use std::collections::HashSet;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSession {
    pub id: String,
    pub title: String,
    pub position: usize,
    pub active_tab_id: Option<String>,
    pub archived_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub position: usize,
    pub active_mux_terminal_id: Option<String>,
    pub layout_json: Option<String>,
    pub archived_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityState {
    Starting,
    Working,
    RunningCommand,
    WaitingForInput,
    Idle,
    Failed,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub pty_id: Option<String>,
    pub activity_state: ActivityState,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalStatus {
    Created,
    Starting,
    Running,
    Waiting,
    Succeeded,
    Failed,
    Cancelled,
    Disconnected,
}

impl TerminalStatus {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Created => "Created",
            Self::Starting => "Starting",
            Self::Running => "Running",
            Self::Waiting => "Waiting",
            Self::Succeeded => "Finished",
            Self::Failed => "Failed",
            Self::Cancelled => "Cancelled",
            Self::Disconnected => "Disconnected",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MuxTerminal {
    pub id: String,
    pub tab_id: Option<String>,
    pub title: String,
    pub position: usize,
    pub status: TerminalStatus,
    pub output: TerminalOutput,
    pub archived_at: Option<String>,
}

impl MuxTerminal {
    pub fn status_label(&self) -> &'static str {
        match self.output.activity_state {
            ActivityState::WaitingForInput => "Waiting for input",
            ActivityState::RunningCommand | ActivityState::Working => "Working",
            ActivityState::Starting => "Starting",
            ActivityState::Failed => "Failed",
            ActivityState::Idle => self.status.label(),
        }
    }
}

#[derive(Clone, Debug)]
pub enum TerminalLayoutNode {
    Empty,
    Terminal(String),
    Row(Vec<(f32, TerminalLayoutNode)>),
    Column(Vec<(f32, TerminalLayoutNode)>),
}

#[derive(Deserialize)]
struct PersistedWorkspace {
    version: u8,
    tree: PersistedTree,
}

#[derive(Deserialize)]
struct PersistedTree {
    root: PersistedNode,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum PersistedNode {
    Leaf { view: PersistedView },
    Row { split: PersistedSplit },
    Column { split: PersistedSplit },
}

#[derive(Deserialize)]
struct PersistedSplit {
    children: Vec<PersistedNode>,
    ratios: Vec<f32>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum PersistedView {
    Empty,
    Terminal {
        #[serde(rename = "muxTerminalId")]
        mux_terminal_id: String,
    },
}

impl PersistedNode {
    fn into_layout(self, live: &HashSet<&str>) -> Option<TerminalLayoutNode> {
        match self {
            Self::Leaf { view } => Some(match view {
                PersistedView::Empty => TerminalLayoutNode::Empty,
                PersistedView::Terminal { mux_terminal_id } if live.contains(mux_terminal_id.as_str()) => {
                    TerminalLayoutNode::Terminal(mux_terminal_id)
                }
                PersistedView::Terminal { .. } => TerminalLayoutNode::Empty,
            }),
            Self::Row { split } => split.into_layout(live, TerminalLayoutNode::Row),
            Self::Column { split } => split.into_layout(live, TerminalLayoutNode::Column),
        }
    }
}

impl PersistedSplit {
    fn into_layout(
        self,
        live: &HashSet<&str>,
        wrap: impl FnOnce(Vec<(f32, TerminalLayoutNode)>) -> TerminalLayoutNode,
    ) -> Option<TerminalLayoutNode> {
        if self.children.len() < 2 || self.children.len() != self.ratios.len() {
            return None;
        }
        let children = self
            .children
            .into_iter()
            .zip(self.ratios)
            .filter_map(|(child, ratio)| {
                (ratio.is_finite() && ratio > 0.0)
                    .then(|| child.into_layout(live).map(|node| (ratio, node)))
                    .flatten()
            })
            .collect::<Vec<_>>();
        (children.len() >= 2).then(|| wrap(children))
    }
}

impl TerminalLayoutNode {
    pub fn restore(layout_json: Option<&str>, terminal_ids: &[String]) -> Self {
        let live = terminal_ids.iter().map(String::as_str).collect::<HashSet<_>>();
        let mut root = layout_json
            .and_then(|json| serde_json::from_str::<PersistedWorkspace>(json).ok())
            .filter(|workspace| workspace.version == 1)
            .and_then(|workspace| workspace.tree.root.into_layout(&live))
            .unwrap_or(Self::Empty);
        let mut placed = HashSet::new();
        root.collect_terminal_ids(&mut placed);
        for terminal_id in terminal_ids {
            if placed.insert(terminal_id.clone()) {
                root.insert_terminal(terminal_id.clone());
            }
        }
        root
    }

    fn collect_terminal_ids(&self, output: &mut HashSet<String>) {
        match self {
            Self::Terminal(id) => {
                output.insert(id.clone());
            }
            Self::Row(children) | Self::Column(children) => {
                for (_, child) in children {
                    child.collect_terminal_ids(output);
                }
            }
            Self::Empty => {}
        }
    }

    fn insert_terminal(&mut self, terminal_id: String) {
        if self.fill_empty(&terminal_id) {
            return;
        }
        let previous = std::mem::replace(self, Self::Empty);
        *self = Self::Row(vec![
            (1.0, previous),
            (1.0, Self::Terminal(terminal_id)),
        ]);
    }

    fn fill_empty(&mut self, terminal_id: &str) -> bool {
        match self {
            Self::Empty => {
                *self = Self::Terminal(terminal_id.to_owned());
                true
            }
            Self::Row(children) | Self::Column(children) => children
                .iter_mut()
                .any(|(_, child)| child.fill_empty(terminal_id)),
            Self::Terminal(_) => false,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session: AppSession,
    pub tabs: Vec<SessionTab>,
    pub mux_terminals: Vec<MuxTerminal>,
}

#[derive(Debug, Serialize)]
pub struct RpcRequest<'a> {
    pub channel: &'a str,
    pub args: Vec<serde_json::Value>,
    #[serde(rename = "clientId")]
    pub client_id: &'a str,
}

#[derive(Debug, Deserialize)]
pub struct RpcResponse {
    pub value: Option<serde_json::Value>,
    pub error: Option<RpcFailure>,
}

#[derive(Debug, Deserialize)]
pub struct RpcFailure {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub sessions: Vec<SessionSnapshot>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCheckpoint {
    pub synthetic_bytes: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttach {
    pub id: String,
    pub checkpoint: Option<TerminalCheckpoint>,
    pub output_chunks: Vec<String>,
    pub output: String,
    pub last_sequence: u64,
    pub cols: u16,
    pub rows: u16,
}
