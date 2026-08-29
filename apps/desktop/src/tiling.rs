use std::collections::HashSet;

use serde::{Deserialize, Serialize};

pub const MAX_TERMINAL_TILES: usize = 6;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct PanelId {
    pub id: u64,
}

impl PanelId {
    pub const fn new(id: u64) -> Self {
        Self { id }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TerminalPaneView {
    Empty,
    Terminal {
        #[serde(rename = "muxTerminalId")]
        mux_terminal_id: String,
    },
}

impl TerminalPaneView {
    pub fn terminal_id(&self) -> Option<&str> {
        match self {
            Self::Empty => None,
            Self::Terminal { mux_terminal_id } => Some(mux_terminal_id),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PanelSplit {
    pub children: Vec<PanelNode>,
    pub ratios: Vec<f32>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PanelNode {
    Leaf {
        #[serde(rename = "panelId")]
        panel_id: PanelId,
        view: TerminalPaneView,
    },
    Row {
        split: PanelSplit,
    },
    Column {
        split: PanelSplit,
    },
}

impl PanelNode {
    pub fn split(&self) -> Option<&PanelSplit> {
        match self {
            Self::Leaf { .. } => None,
            Self::Row { split } | Self::Column { split } => Some(split),
        }
    }

    pub fn is_row(&self) -> bool {
        matches!(self, Self::Row { .. })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TerminalWorkspace {
    pub root: PanelNode,
    pub next_panel_id: u64,
    pub focused_panel_id: PanelId,
    pub zoomed_panel_id: Option<PanelId>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedTerminalWorkspace {
    version: u8,
    tree: PanelTreeSnapshot,
    focused_panel_id: u64,
    zoomed_panel_id: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PanelTreeSnapshot {
    root: PanelNode,
    next_panel_id: u64,
}

impl Default for TerminalWorkspace {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalWorkspace {
    pub fn new() -> Self {
        let panel_id = PanelId::new(1);
        Self {
            root: PanelNode::Leaf {
                panel_id,
                view: TerminalPaneView::Empty,
            },
            next_panel_id: 2,
            focused_panel_id: panel_id,
            zoomed_panel_id: None,
        }
    }

    pub fn restore(layout_json: Option<&str>, live_terminal_ids: &[String]) -> Self {
        let mut workspace = layout_json.and_then(Self::parse).unwrap_or_default();
        workspace.remove_missing(live_terminal_ids);
        while workspace.pane_count() > MAX_TERMINAL_TILES {
            let leaves = workspace.leaf_ids();
            let panel = leaves
                .iter()
                .copied()
                .find(|panel| matches!(workspace.view(*panel), Some(TerminalPaneView::Empty)))
                .or_else(|| leaves.last().copied());
            let Some(panel) = panel else { break };
            workspace.close_panel(panel);
        }
        let mut open = workspace.terminal_ids().into_iter().collect::<HashSet<_>>();
        for terminal_id in live_terminal_ids {
            if open.contains(terminal_id) || workspace.pane_count() >= MAX_TERMINAL_TILES {
                continue;
            }
            if workspace.open_terminal(terminal_id.clone()) {
                open.insert(terminal_id.clone());
            }
        }
        workspace
    }

    fn parse(layout_json: &str) -> Option<Self> {
        let persisted: PersistedTerminalWorkspace = serde_json::from_str(layout_json).ok()?;
        if persisted.version != 1 || !validate_node(&persisted.tree.root) {
            return None;
        }
        let mut panel_ids = Vec::new();
        visit_leaves(&persisted.tree.root, &mut |panel_id, _| {
            panel_ids.push(panel_id)
        });
        let unique = panel_ids.iter().copied().collect::<HashSet<_>>();
        if panel_ids.is_empty()
            || unique.len() != panel_ids.len()
            || !unique.contains(&PanelId::new(persisted.focused_panel_id))
        {
            return None;
        }
        let maximum = panel_ids.iter().map(|panel| panel.id).max()?;
        let zoomed_panel_id = persisted
            .zoomed_panel_id
            .map(PanelId::new)
            .filter(|panel| unique.contains(panel));
        let mut root = persisted.tree.root;
        normalize_node(&mut root);
        Some(Self {
            root,
            next_panel_id: persisted.tree.next_panel_id.max(maximum.saturating_add(1)),
            focused_panel_id: PanelId::new(persisted.focused_panel_id),
            zoomed_panel_id,
        })
    }

    pub fn serialize(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string(&PersistedTerminalWorkspace {
            version: 1,
            tree: PanelTreeSnapshot {
                root: self.root.clone(),
                next_panel_id: self.next_panel_id,
            },
            focused_panel_id: self.focused_panel_id.id,
            zoomed_panel_id: self.zoomed_panel_id.map(|panel| panel.id),
        })
    }

    pub fn pane_count(&self) -> usize {
        let mut count = 0;
        visit_leaves(&self.root, &mut |_, _| count += 1);
        count
    }

    pub fn leaf_ids(&self) -> Vec<PanelId> {
        let mut ids = Vec::new();
        visit_leaves(&self.root, &mut |panel, _| ids.push(panel));
        ids
    }

    pub fn terminal_ids(&self) -> Vec<String> {
        let mut ids = Vec::new();
        visit_leaves(&self.root, &mut |_, view| {
            if let Some(id) = view.terminal_id() {
                ids.push(id.to_string());
            }
        });
        ids
    }

    pub fn view(&self, panel_id: PanelId) -> Option<&TerminalPaneView> {
        find_leaf(&self.root, panel_id).map(|(_, view)| view)
    }

    pub fn panel_for_terminal(&self, terminal_id: &str) -> Option<PanelId> {
        let mut found = None;
        visit_leaves(&self.root, &mut |panel, view| {
            if view.terminal_id() == Some(terminal_id) {
                found = Some(panel);
            }
        });
        found
    }

    pub fn focus(&mut self, panel_id: PanelId) -> bool {
        if self.view(panel_id).is_none() {
            return false;
        }
        let changed = self.focused_panel_id != panel_id || self.zoomed_panel_id.is_some();
        self.focused_panel_id = panel_id;
        self.zoomed_panel_id = None;
        changed
    }

    pub fn open_terminal(&mut self, terminal_id: String) -> bool {
        if let Some(panel) = self.panel_for_terminal(&terminal_id) {
            return self.focus(panel);
        }
        let target = if self.view(self.focused_panel_id).is_some() {
            self.focused_panel_id
        } else {
            self.leaf_ids().first().copied().unwrap_or(PanelId::new(1))
        };
        if matches!(self.view(target), Some(TerminalPaneView::Empty)) {
            return self.set_terminal(target, terminal_id);
        }
        if self.pane_count() >= MAX_TERMINAL_TILES {
            return false;
        }
        let Some(created) = self.split_panel(target, Edge::Right) else {
            return false;
        };
        self.set_terminal(created, terminal_id)
    }

    pub fn open_terminal_in_panel(&mut self, panel_id: PanelId, terminal_id: String) -> bool {
        if let Some(existing) = self.panel_for_terminal(&terminal_id) {
            return self.focus(existing);
        }
        if !matches!(self.view(panel_id), Some(TerminalPaneView::Empty)) {
            return self.open_terminal(terminal_id);
        }
        self.set_terminal(panel_id, terminal_id)
    }

    fn set_terminal(&mut self, panel_id: PanelId, terminal_id: String) -> bool {
        let Some((_, view)) = find_leaf_mut(&mut self.root, panel_id) else {
            return false;
        };
        *view = TerminalPaneView::Terminal {
            mux_terminal_id: terminal_id,
        };
        self.focused_panel_id = panel_id;
        self.zoomed_panel_id = None;
        true
    }

    pub fn split_panel(&mut self, panel_id: PanelId, edge: Edge) -> Option<PanelId> {
        if self.view(panel_id).is_none() || self.pane_count() >= MAX_TERMINAL_TILES {
            return None;
        }
        let created = PanelId::new(self.next_panel_id);
        self.next_panel_id = self.next_panel_id.saturating_add(1);
        if !split_leaf(&mut self.root, panel_id, created, edge) {
            return None;
        }
        self.focused_panel_id = created;
        self.zoomed_panel_id = None;
        Some(created)
    }

    pub fn close_panel(&mut self, panel_id: PanelId) -> bool {
        if self.view(panel_id).is_none() {
            return false;
        }
        if self.pane_count() == 1 {
            let Some((_, view)) = find_leaf_mut(&mut self.root, panel_id) else {
                return false;
            };
            *view = TerminalPaneView::Empty;
        } else {
            self.root =
                remove_panel(self.root.clone(), panel_id).unwrap_or_else(|| PanelNode::Leaf {
                    panel_id: PanelId::new(self.next_panel_id),
                    view: TerminalPaneView::Empty,
                });
        }
        let leaves = self.leaf_ids();
        if !leaves.contains(&self.focused_panel_id) {
            self.focused_panel_id = leaves.first().copied().unwrap_or(PanelId::new(1));
        }
        if self.zoomed_panel_id == Some(panel_id) {
            self.zoomed_panel_id = None;
        }
        true
    }

    pub fn toggle_zoom(&mut self, panel_id: PanelId) -> bool {
        if self.view(panel_id).is_none() || self.pane_count() < 2 {
            return false;
        }
        self.focused_panel_id = panel_id;
        self.zoomed_panel_id = if self.zoomed_panel_id == Some(panel_id) {
            None
        } else {
            Some(panel_id)
        };
        true
    }

    pub fn set_split_ratios(&mut self, path: &[usize], ratios: &[f32]) -> bool {
        let Some(node) = node_at_path_mut(&mut self.root, path) else {
            return false;
        };
        let split = match node {
            PanelNode::Leaf { .. } => return false,
            PanelNode::Row { split } | PanelNode::Column { split } => split,
        };
        if ratios.len() != split.children.len()
            || ratios
                .iter()
                .any(|ratio| !ratio.is_finite() || *ratio <= 0.0)
        {
            return false;
        }
        let sum = ratios.iter().sum::<f32>();
        if !sum.is_finite() || sum <= 0.0 {
            return false;
        }
        let normalized = ratios.iter().map(|ratio| ratio / sum).collect::<Vec<_>>();
        if !normalized
            .iter()
            .zip(&split.ratios)
            .any(|(next, current)| (next - current).abs() > 0.001)
        {
            return false;
        }
        split.ratios = normalized;
        true
    }

    pub fn dock_terminal(
        &mut self,
        terminal_id: &str,
        target: PanelId,
        edge: Option<Edge>,
    ) -> bool {
        if self.view(target).is_none() {
            return false;
        }
        let source = self.panel_for_terminal(terminal_id);
        if source == Some(target) {
            return self.focus(target);
        }

        if let Some(edge) = edge {
            if source.is_none() && self.pane_count() >= MAX_TERMINAL_TILES {
                return false;
            }
            if let Some(source) = source {
                self.remove_terminal_panel(source);
            }
            if self.view(target).is_none() {
                return false;
            }
            let Some(created) = self.split_panel(target, edge) else {
                return false;
            };
            return self.set_terminal(created, terminal_id.to_string());
        }

        if let Some(source) = source {
            let source_view = self.view(source).cloned();
            let target_view = self.view(target).cloned();
            let (Some(source_view), Some(target_view)) = (source_view, target_view) else {
                return false;
            };
            if let Some((_, view)) = find_leaf_mut(&mut self.root, source) {
                *view = target_view;
            }
            if let Some((_, view)) = find_leaf_mut(&mut self.root, target) {
                *view = source_view;
            }
            self.focused_panel_id = target;
            self.zoomed_panel_id = None;
            return true;
        }

        if matches!(self.view(target), Some(TerminalPaneView::Empty)) {
            return self.set_terminal(target, terminal_id.to_string());
        }
        if self.pane_count() >= MAX_TERMINAL_TILES {
            return false;
        }
        let Some(created) = self.split_panel(target, Edge::Right) else {
            return false;
        };
        self.set_terminal(created, terminal_id.to_string())
    }

    fn remove_terminal_panel(&mut self, panel_id: PanelId) {
        if self.pane_count() == 1 {
            if let Some((_, view)) = find_leaf_mut(&mut self.root, panel_id) {
                *view = TerminalPaneView::Empty;
            }
        } else {
            self.root =
                remove_panel(self.root.clone(), panel_id).unwrap_or_else(|| self.root.clone());
        }
    }

    fn remove_missing(&mut self, live_terminal_ids: &[String]) {
        let live = live_terminal_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let missing = self
            .leaf_ids()
            .into_iter()
            .filter(|panel| {
                self.view(*panel)
                    .and_then(TerminalPaneView::terminal_id)
                    .is_some_and(|terminal_id| !live.contains(terminal_id))
            })
            .collect::<Vec<_>>();
        for panel in missing {
            self.close_panel(panel);
        }
    }
}

fn validate_node(node: &PanelNode) -> bool {
    match node {
        PanelNode::Leaf { panel_id, .. } => panel_id.id > 0,
        PanelNode::Row { split } | PanelNode::Column { split } => {
            split.children.len() >= 2
                && split.children.len() == split.ratios.len()
                && split
                    .ratios
                    .iter()
                    .all(|ratio| ratio.is_finite() && *ratio > 0.0)
                && split.children.iter().all(validate_node)
        }
    }
}

fn normalize_node(node: &mut PanelNode) {
    let split = match node {
        PanelNode::Leaf { .. } => return,
        PanelNode::Row { split } | PanelNode::Column { split } => split,
    };
    let sum = split.ratios.iter().sum::<f32>();
    for ratio in &mut split.ratios {
        *ratio /= sum;
    }
    for child in &mut split.children {
        normalize_node(child);
    }
}

fn visit_leaves(node: &PanelNode, visitor: &mut impl FnMut(PanelId, &TerminalPaneView)) {
    match node {
        PanelNode::Leaf { panel_id, view } => visitor(*panel_id, view),
        PanelNode::Row { split } | PanelNode::Column { split } => {
            for child in &split.children {
                visit_leaves(child, visitor);
            }
        }
    }
}

fn find_leaf(node: &PanelNode, target: PanelId) -> Option<(PanelId, &TerminalPaneView)> {
    match node {
        PanelNode::Leaf { panel_id, view } => (*panel_id == target).then_some((*panel_id, view)),
        PanelNode::Row { split } | PanelNode::Column { split } => split
            .children
            .iter()
            .find_map(|child| find_leaf(child, target)),
    }
}

fn find_leaf_mut(
    node: &mut PanelNode,
    target: PanelId,
) -> Option<(PanelId, &mut TerminalPaneView)> {
    match node {
        PanelNode::Leaf { panel_id, view } => (*panel_id == target).then_some((*panel_id, view)),
        PanelNode::Row { split } | PanelNode::Column { split } => split
            .children
            .iter_mut()
            .find_map(|child| find_leaf_mut(child, target)),
    }
}

fn split_leaf(node: &mut PanelNode, target: PanelId, created: PanelId, edge: Edge) -> bool {
    match node {
        PanelNode::Leaf { panel_id, .. } if *panel_id == target => {
            let existing = node.clone();
            let new_leaf = PanelNode::Leaf {
                panel_id: created,
                view: TerminalPaneView::Empty,
            };
            let (first, second) = if matches!(edge, Edge::Right | Edge::Bottom) {
                (existing, new_leaf)
            } else {
                (new_leaf, existing)
            };
            let split = PanelSplit {
                children: vec![first, second],
                ratios: vec![0.5, 0.5],
            };
            *node = if matches!(edge, Edge::Left | Edge::Right) {
                PanelNode::Row { split }
            } else {
                PanelNode::Column { split }
            };
            true
        }
        PanelNode::Leaf { .. } => false,
        PanelNode::Row { split } | PanelNode::Column { split } => split
            .children
            .iter_mut()
            .any(|child| split_leaf(child, target, created, edge)),
    }
}

fn remove_panel(node: PanelNode, target: PanelId) -> Option<PanelNode> {
    match node {
        PanelNode::Leaf { panel_id, .. } if panel_id == target => None,
        PanelNode::Leaf { .. } => Some(node),
        PanelNode::Row { split } => remove_from_split(split, target, true),
        PanelNode::Column { split } => remove_from_split(split, target, false),
    }
}

fn remove_from_split(split: PanelSplit, target: PanelId, row: bool) -> Option<PanelNode> {
    let children = split
        .children
        .into_iter()
        .filter_map(|child| remove_panel(child, target))
        .collect::<Vec<_>>();
    match children.len() {
        0 => None,
        1 => children.into_iter().next(),
        count => {
            let split = PanelSplit {
                children,
                ratios: vec![1.0 / count as f32; count],
            };
            Some(if row {
                PanelNode::Row { split }
            } else {
                PanelNode::Column { split }
            })
        }
    }
}

fn node_at_path_mut<'a>(node: &'a mut PanelNode, path: &[usize]) -> Option<&'a mut PanelNode> {
    let mut current = node;
    for index in path {
        let split = match current {
            PanelNode::Leaf { .. } => return None,
            PanelNode::Row { split } | PanelNode::Column { split } => split,
        };
        current = split.children.get_mut(*index)?;
    }
    Some(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_each_terminal_in_its_own_pane() {
        let mut workspace = TerminalWorkspace::new();
        assert!(workspace.open_terminal("first".to_string()));
        let first_panel = workspace.focused_panel_id;
        assert!(workspace.open_terminal("second".to_string()));
        assert_eq!(workspace.terminal_ids(), ["first", "second"]);
        assert_eq!(workspace.pane_count(), 2);
        assert!(workspace.open_terminal("first".to_string()));
        assert_eq!(workspace.focused_panel_id, first_panel);
    }

    #[test]
    fn round_trips_web_layout_shape_and_focus() {
        let mut workspace = TerminalWorkspace::new();
        workspace.open_terminal("first".to_string());
        workspace.open_terminal("second".to_string());
        let json = workspace.serialize().expect("serialize");
        assert!(json.contains("\"muxTerminalId\":\"first\""));
        let restored = TerminalWorkspace::restore(Some(&json), &["first".into(), "second".into()]);
        assert_eq!(restored.terminal_ids(), ["first", "second"]);
        assert!(matches!(restored.root, PanelNode::Row { .. }));
        assert_eq!(restored.focused_panel_id, workspace.focused_panel_id);
    }

    #[test]
    fn restore_normalizes_ratios_and_drops_stale_terminals() {
        let json = r#"{"version":1,"tree":{"root":{"kind":"row","split":{"children":[{"kind":"leaf","panelId":{"id":1},"view":{"kind":"terminal","muxTerminalId":"stale"}},{"kind":"leaf","panelId":{"id":2},"view":{"kind":"empty"}}],"ratios":[100,1]}},"nextPanelId":3},"focusedPanelId":1,"zoomedPanelId":null}"#;
        let workspace = TerminalWorkspace::restore(Some(json), &["current".into()]);
        assert_eq!(workspace.terminal_ids(), ["current"]);
    }

    #[test]
    fn caps_tiles_and_swaps_center_drops() {
        let mut workspace = TerminalWorkspace::new();
        for index in 0..MAX_TERMINAL_TILES {
            workspace.open_terminal(format!("terminal-{index}"));
        }
        assert_eq!(workspace.pane_count(), MAX_TERMINAL_TILES);
        assert!(!workspace.open_terminal("overflow".to_string()));

        let first = workspace.panel_for_terminal("terminal-0").expect("first");
        let second = workspace.panel_for_terminal("terminal-1").expect("second");
        assert!(workspace.dock_terminal("terminal-1", first, None));
        assert_eq!(
            workspace
                .view(first)
                .and_then(TerminalPaneView::terminal_id),
            Some("terminal-1")
        );
        assert_eq!(
            workspace
                .view(second)
                .and_then(TerminalPaneView::terminal_id),
            Some("terminal-0")
        );
    }

    #[test]
    fn split_ratios_validate_and_normalize() {
        let mut workspace = TerminalWorkspace::new();
        workspace.open_terminal("first".to_string());
        workspace.open_terminal("second".to_string());
        assert!(workspace.set_split_ratios(&[], &[3.0, 1.0]));
        let PanelNode::Row { split } = workspace.root else {
            panic!("row");
        };
        assert!((split.ratios[0] - 0.75).abs() < 0.001);
    }
}
