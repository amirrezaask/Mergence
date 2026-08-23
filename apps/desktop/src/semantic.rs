use std::collections::{HashMap, HashSet};

use crate::model::{
    TerminalPatchMessage, TerminalSemanticPatch, TerminalSemanticSnapshot, TerminalSnapshotMessage,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreApplyResult {
    Applied,
    Ignored,
    ResyncRequired,
}

/// Client-side projection of the owner-published semantic terminal stream.
///
/// The store never parses PTY bytes. Epoch and revision checks ensure a patch
/// from an old process or a dropped frame cannot corrupt the visible grid.
#[derive(Clone, Debug, Default)]
pub struct TerminalSemanticStore {
    terminal_id: Option<String>,
    owner_epoch: Option<String>,
    terminal_epoch: Option<String>,
    revision: u64,
    current: Option<TerminalSemanticSnapshot>,
}

impl TerminalSemanticStore {
    pub fn apply_snapshot(&mut self, message: TerminalSnapshotMessage) -> StoreApplyResult {
        if self
            .terminal_id
            .as_deref()
            .is_some_and(|terminal_id| terminal_id != message.terminal_id)
        {
            return StoreApplyResult::Ignored;
        }
        if self.owner_epoch.as_deref() == Some(message.owner_epoch.as_str())
            && self.terminal_epoch.as_deref() == Some(message.terminal_epoch.as_str())
            && message.revision <= self.revision
        {
            return StoreApplyResult::Ignored;
        }
        if message.snapshot.schema_version != 1
            || message.snapshot.revision != message.revision
            || !valid_snapshot_shape(&message.snapshot)
        {
            return StoreApplyResult::ResyncRequired;
        }

        self.terminal_id = Some(message.terminal_id);
        self.owner_epoch = Some(message.owner_epoch);
        self.terminal_epoch = Some(message.terminal_epoch);
        self.revision = message.revision;
        self.current = Some(message.snapshot);
        StoreApplyResult::Applied
    }

    pub fn apply_patch(&mut self, message: TerminalPatchMessage) -> StoreApplyResult {
        if self.terminal_id.as_deref() != Some(message.terminal_id.as_str())
            || self.owner_epoch.as_deref() != Some(message.owner_epoch.as_str())
            || self.terminal_epoch.as_deref() != Some(message.terminal_epoch.as_str())
            || self.current.is_none()
        {
            return StoreApplyResult::ResyncRequired;
        }
        if message.revision != message.patch.revision
            || message.base_revision != message.patch.base_revision
            || message.revision <= self.revision
        {
            return if message.revision <= self.revision {
                StoreApplyResult::Ignored
            } else {
                StoreApplyResult::ResyncRequired
            };
        }
        if message.base_revision != self.revision {
            return StoreApplyResult::ResyncRequired;
        }
        let Some(next) = apply_terminal_semantic_patch(
            self.current.as_ref().expect("checked above"),
            &message.terminal_epoch,
            &message.patch,
        ) else {
            return StoreApplyResult::ResyncRequired;
        };
        self.revision = message.revision;
        self.current = Some(next);
        StoreApplyResult::Applied
    }

    pub fn replace_attached_snapshot(
        &mut self,
        terminal_id: String,
        owner_epoch: Option<String>,
        terminal_epoch: Option<String>,
        snapshot: TerminalSemanticSnapshot,
    ) -> StoreApplyResult {
        let revision = snapshot.revision;
        self.apply_snapshot(TerminalSnapshotMessage {
            terminal_id,
            owner_epoch: owner_epoch.unwrap_or_else(|| "attach".to_string()),
            terminal_epoch: terminal_epoch.unwrap_or_else(|| "attach".to_string()),
            revision,
            snapshot,
        })
    }

    pub fn snapshot(&self) -> Option<&TerminalSemanticSnapshot> {
        self.current.as_ref()
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn terminal_epoch(&self) -> Option<&str> {
        self.terminal_epoch.as_deref()
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

pub fn apply_terminal_semantic_patch(
    snapshot: &TerminalSemanticSnapshot,
    terminal_epoch: &str,
    patch: &TerminalSemanticPatch,
) -> Option<TerminalSemanticSnapshot> {
    if patch.schema_version != 1
        || patch.terminal_epoch != terminal_epoch
        || patch.base_revision != snapshot.revision
        || patch.revision <= patch.base_revision
        || patch
            .active_screen
            .as_deref()
            .is_some_and(|screen| !matches!(screen, "primary" | "alternate"))
    {
        return None;
    }

    let mut next = snapshot.clone();
    let screen_rows = if patch.full_reset {
        patch.changed_rows.clone()
    } else {
        let deleted = patch
            .deleted_row_ids
            .iter()
            .map(String::as_str)
            .collect::<HashSet<_>>();
        let changed = patch
            .changed_rows
            .iter()
            .map(|row| (row.row_id.as_str(), row))
            .collect::<HashMap<_, _>>();
        let mut rows = snapshot
            .screen_rows
            .iter()
            .filter(|row| !deleted.contains(row.row_id.as_str()))
            .map(|row| {
                changed
                    .get(row.row_id.as_str())
                    .map_or_else(|| row.clone(), |changed| (*changed).clone())
            })
            .collect::<Vec<_>>();
        let mut existing = rows
            .iter()
            .map(|row| row.row_id.clone())
            .collect::<HashSet<_>>();
        for row in &patch.changed_rows {
            if existing.insert(row.row_id.clone()) {
                rows.push(row.clone());
            }
        }
        rows
    };

    next.cols = patch.cols.unwrap_or(next.cols);
    next.rows = patch.rows.unwrap_or(next.rows);
    if let Some(active_screen) = &patch.active_screen {
        next.active_screen.clone_from(active_screen);
    }
    if let Some(cursor) = &patch.cursor {
        next.cursor = cursor.clone();
    }
    if let Some(scrollback) = &patch.scrollback {
        next.scrollback = scrollback.clone();
    }
    if let Some(modes) = &patch.modes {
        next.modes = modes.clone();
    }
    if let Some(title) = &patch.title {
        next.title.clone_from(title);
    }
    if let Some(palette) = &patch.palette {
        next.palette.clone_from(palette);
    }
    if let Some(hyperlinks) = &patch.hyperlinks {
        next.hyperlinks.clone_from(hyperlinks);
    }
    next.revision = patch.revision;
    next.screen_rows = screen_rows;
    valid_snapshot_shape(&next).then_some(next)
}

fn valid_snapshot_shape(snapshot: &TerminalSemanticSnapshot) -> bool {
    snapshot.cols > 0
        && snapshot.rows > 0
        && matches!(snapshot.active_screen.as_str(), "primary" | "alternate")
        && snapshot.screen_rows.len() <= snapshot.rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{TerminalCursor, TerminalPatchMessage, TerminalRow};

    fn attached_snapshot() -> TerminalSemanticSnapshot {
        let response: crate::model::HostRpcResponse<Option<crate::model::TerminalAttachResult>> =
            serde_json::from_str(include_str!("../tests/fixtures/terminal-attach-success.json"))
                .expect("fixture");
        let crate::model::HostRpcResponse::Success { value: Some(result) } = response else {
            panic!("attached terminal fixture");
        };
        result.semantic_snapshot.expect("semantic snapshot")
    }

    #[test]
    fn applies_contiguous_patch_and_preserves_row_order() {
        let snapshot = attached_snapshot();
        let mut store = TerminalSemanticStore::default();
        assert_eq!(
            store.apply_snapshot(TerminalSnapshotMessage {
                terminal_id: "pty-shell".to_string(),
                owner_epoch: "owner-1".to_string(),
                terminal_epoch: "epoch-1".to_string(),
                revision: snapshot.revision,
                snapshot,
            }),
            StoreApplyResult::Applied
        );
        let changed = TerminalRow {
            row_id: "screen-0".to_string(),
            cells: Vec::new(),
            is_wrap_continuation: false,
            wraps_to_next: false,
        };
        let patch = TerminalSemanticPatch {
            schema_version: 1,
            terminal_epoch: "epoch-1".to_string(),
            base_revision: 7,
            revision: 8,
            changed_rows: vec![changed],
            deleted_row_ids: Vec::new(),
            cursor: Some(TerminalCursor {
                x: 0,
                y: 0,
                visible: true,
                blinking: false,
                style: 1,
            }),
            cols: None,
            rows: None,
            active_screen: None,
            scrollback: None,
            modes: None,
            title: Some(None),
            palette: None,
            hyperlinks: None,
            full_reset: false,
        };
        assert_eq!(
            store.apply_patch(TerminalPatchMessage {
                terminal_id: "pty-shell".to_string(),
                owner_epoch: "owner-1".to_string(),
                terminal_epoch: "epoch-1".to_string(),
                base_revision: 7,
                revision: 8,
                patch,
            }),
            StoreApplyResult::Applied
        );
        let current = store.snapshot().expect("snapshot");
        assert_eq!(current.revision, 8);
        assert_eq!(current.screen_rows[0].row_id, "screen-0");
        assert_eq!(current.title, None);
    }

    #[test]
    fn revision_gap_requires_resync() {
        let snapshot = attached_snapshot();
        let mut store = TerminalSemanticStore::default();
        store.apply_snapshot(TerminalSnapshotMessage {
            terminal_id: "pty-shell".to_string(),
            owner_epoch: "owner-1".to_string(),
            terminal_epoch: "epoch-1".to_string(),
            revision: snapshot.revision,
            snapshot,
        });
        let patch: TerminalPatchMessage = serde_json::from_value(serde_json::json!({
            "terminalId": "pty-shell",
            "ownerEpoch": "owner-1",
            "terminalEpoch": "epoch-1",
            "baseRevision": 6,
            "revision": 8,
            "patch": {
                "schemaVersion": 1,
                "terminalEpoch": "epoch-1",
                "baseRevision": 6,
                "revision": 8,
                "changedRows": [],
                "deletedRowIds": []
            }
        }))
        .expect("patch");
        assert_eq!(store.apply_patch(patch), StoreApplyResult::ResyncRequired);
        assert_eq!(store.revision(), 7);
    }
}
