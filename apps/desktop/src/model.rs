use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session: AppSession,
    #[serde(default)]
    pub tabs: Vec<SessionTab>,
    #[serde(default)]
    pub mux_terminals: Vec<MuxTerminal>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppSession {
    pub id: String,
    pub title: String,
    pub position: f64,
    pub active_tab_id: Option<String>,
    pub active_mux_terminal_id: Option<String>,
    pub revision: Option<u64>,
    pub archived_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionTab {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub position: f64,
    pub active_mux_terminal_id: Option<String>,
    pub layout_json: Option<String>,
    pub revision: Option<u64>,
    pub archived_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MuxTerminal {
    pub id: String,
    pub session_id: String,
    pub tab_id: Option<String>,
    pub title: String,
    pub position: f64,
    pub status: String,
    pub output: TerminalOutput,
    pub revision: u64,
    pub archived_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub pty_id: Option<String>,
    pub generation: u64,
    pub process_state: String,
    pub activity_state: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCheckpoint {
    pub checkpoint_version: u32,
    pub terminal_epoch: String,
    pub sequence: u64,
    pub cols: usize,
    pub rows: usize,
    pub created_at: String,
    pub synthetic_ansi: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachResult {
    pub id: String,
    pub title: Option<String>,
    pub terminal_epoch: Option<String>,
    pub owner_id: Option<String>,
    pub owner_epoch: Option<String>,
    pub protocol_version: Option<u32>,
    pub checkpoint: Option<TerminalCheckpoint>,
    pub replay_quality: Option<String>,
    #[serde(default)]
    pub output_chunks: Vec<String>,
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub replay_truncated: bool,
    #[serde(default)]
    pub replay_needs_query_responses: bool,
    #[serde(default)]
    pub archive_available: bool,
    #[serde(default)]
    pub last_sequence: u64,
    pub cols: Option<usize>,
    pub rows: Option<usize>,
    pub status: String,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub semantic_snapshot: Option<TerminalSemanticSnapshot>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSemanticSnapshot {
    pub schema_version: u32,
    pub cols: usize,
    pub rows: usize,
    pub active_screen: String,
    pub revision: u64,
    pub cursor: TerminalCursor,
    #[serde(default)]
    pub screen_rows: Vec<TerminalRow>,
    #[serde(default)]
    pub scrollback: TerminalScrollbackSummary,
    #[serde(default)]
    pub modes: TerminalModes,
    pub title: Option<String>,
    #[serde(default)]
    pub palette: Vec<TerminalColor>,
    #[serde(default)]
    pub hyperlinks: Vec<TerminalHyperlink>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalModes {
    #[serde(default)]
    pub bracketed_paste: bool,
    #[serde(default)]
    pub application_cursor_keys: bool,
    #[serde(default)]
    pub focus_reporting: bool,
    #[serde(default)]
    pub mouse_tracking: bool,
    #[serde(default)]
    pub mouse_sgr: bool,
    #[serde(default)]
    pub mouse_sgr_pixels: bool,
    #[serde(default)]
    pub synchronized_output: bool,
    #[serde(default)]
    pub kitty_keyboard: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalScrollbackSummary {
    pub first_row_id: Option<String>,
    pub last_row_id: Option<String>,
    #[serde(default)]
    pub row_count: usize,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct TerminalHyperlink {
    pub id: String,
    pub uri: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCursor {
    pub x: usize,
    pub y: usize,
    pub visible: bool,
    pub blinking: bool,
    pub style: u8,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRow {
    pub row_id: String,
    #[serde(default)]
    pub cells: Vec<TerminalCell>,
    pub is_wrap_continuation: bool,
    pub wraps_to_next: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCell {
    pub text: String,
    pub wide: u8,
    pub foreground: TerminalColor,
    pub background: TerminalColor,
    pub underline_color: Option<TerminalColor>,
    pub bold: bool,
    pub faint: bool,
    pub italic: bool,
    pub blink: bool,
    pub inverse: bool,
    pub invisible: bool,
    pub strikethrough: bool,
    pub overline: bool,
    pub underline: u8,
    pub hyperlink_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct TerminalColor {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    #[serde(default = "opaque")]
    pub a: f32,
}

const fn opaque() -> f32 {
    1.0
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum TerminalStreamMessage {
    #[serde(rename = "terminal.snapshot")]
    Snapshot(TerminalSnapshotMessage),
    #[serde(rename = "terminal.patch")]
    Patch(TerminalPatchMessage),
    #[serde(rename = "terminal.resync-required")]
    ResyncRequired(TerminalResyncRequiredMessage),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshotMessage {
    pub terminal_id: String,
    pub owner_epoch: String,
    pub terminal_epoch: String,
    pub revision: u64,
    pub snapshot: TerminalSemanticSnapshot,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalPatchMessage {
    pub terminal_id: String,
    pub owner_epoch: String,
    pub terminal_epoch: String,
    pub base_revision: u64,
    pub revision: u64,
    pub patch: TerminalSemanticPatch,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResyncRequiredMessage {
    pub terminal_id: String,
    pub terminal_epoch: String,
    pub latest_revision: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSemanticPatch {
    pub schema_version: u32,
    pub terminal_epoch: String,
    pub base_revision: u64,
    pub revision: u64,
    #[serde(default)]
    pub changed_rows: Vec<TerminalRow>,
    #[serde(default)]
    pub deleted_row_ids: Vec<String>,
    pub cursor: Option<TerminalCursor>,
    pub cols: Option<usize>,
    pub rows: Option<usize>,
    pub active_screen: Option<String>,
    pub scrollback: Option<TerminalScrollbackSummary>,
    pub modes: Option<TerminalModes>,
    #[serde(default, deserialize_with = "deserialize_nullable_option")]
    pub title: Option<Option<String>>,
    pub palette: Option<Vec<TerminalColor>>,
    pub hyperlinks: Option<Vec<TerminalHyperlink>>,
    #[serde(default)]
    pub full_reset: bool,
}

fn deserialize_nullable_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkspaceSelection {
    pub session_id: Option<String>,
    pub tab_id: Option<String>,
    pub terminal_id: Option<String>,
}

impl WorkspaceSelection {
    pub fn resolve(snapshots: &[SessionSnapshot], requested_session_id: Option<&str>) -> Self {
        let mut sessions = snapshots
            .iter()
            .filter(|snapshot| snapshot.session.archived_at.is_none())
            .collect::<Vec<_>>();
        sessions.sort_by(|left, right| left.session.position.total_cmp(&right.session.position));
        let selected = requested_session_id
            .and_then(|id| sessions.iter().copied().find(|item| item.session.id == id))
            .or_else(|| sessions.first().copied());
        let Some(snapshot) = selected else {
            return Self {
                session_id: None,
                tab_id: None,
                terminal_id: None,
            };
        };

        let mut tabs = snapshot
            .tabs
            .iter()
            .filter(|tab| tab.archived_at.is_none())
            .collect::<Vec<_>>();
        tabs.sort_by(|left, right| left.position.total_cmp(&right.position));
        let tab = snapshot
            .session
            .active_tab_id
            .as_deref()
            .and_then(|id| tabs.iter().copied().find(|tab| tab.id == id))
            .or_else(|| tabs.first().copied());
        let tab_id = tab.map(|value| value.id.clone());
        let legacy_terminal_tab_id = tabs.first().map(|value| value.id.as_str());

        let mut terminals = snapshot
            .mux_terminals
            .iter()
            .filter(|terminal| {
                terminal.archived_at.is_none()
                    && tab_id.as_deref().is_none_or(|id| {
                        terminal.tab_id.as_deref() == Some(id)
                            || (terminal.tab_id.is_none() && legacy_terminal_tab_id == Some(id))
                    })
            })
            .collect::<Vec<_>>();
        terminals.sort_by(|left, right| left.position.total_cmp(&right.position));
        let requested_terminal_id = tab
            .and_then(|value| value.active_mux_terminal_id.as_deref())
            .or(snapshot.session.active_mux_terminal_id.as_deref());
        let terminal = requested_terminal_id
            .and_then(|id| terminals.iter().copied().find(|terminal| terminal.id == id))
            .or_else(|| terminals.first().copied());

        Self {
            session_id: Some(snapshot.session.id.clone()),
            tab_id,
            terminal_id: terminal.map(|value| value.id.clone()),
        }
    }
}

pub fn active_snapshot<'a>(
    snapshots: &'a [SessionSnapshot],
    selection: &WorkspaceSelection,
) -> Option<&'a SessionSnapshot> {
    let session_id = selection.session_id.as_deref()?;
    snapshots
        .iter()
        .find(|snapshot| snapshot.session.id == session_id)
}

pub fn active_terminal<'a>(
    snapshots: &'a [SessionSnapshot],
    selection: &WorkspaceSelection,
) -> Option<&'a MuxTerminal> {
    let terminal_id = selection.terminal_id.as_deref()?;
    snapshots
        .iter()
        .flat_map(|snapshot| &snapshot.mux_terminals)
        .find(|terminal| terminal.id == terminal_id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRpcRequest<'a> {
    pub channel: &'a str,
    pub args: serde_json::Value,
    pub client_id: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum HostRpcResponse<T> {
    Success { value: T },
    Failure { error: HostRpcWireError },
}

#[derive(Debug, Deserialize)]
pub struct HostRpcWireError {
    pub code: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_host_snapshot_and_resolves_active_entities() {
        let response: HostRpcResponse<Vec<SessionSnapshot>> =
            serde_json::from_str(include_str!("../tests/fixtures/list-sessions-success.json"))
                .expect("fixture should decode");
        let HostRpcResponse::Success { value } = response else {
            panic!("expected success fixture");
        };
        let selection = WorkspaceSelection::resolve(&value, None);
        assert_eq!(selection.session_id.as_deref(), Some("ses-primary"));
        assert_eq!(selection.tab_id.as_deref(), Some("tab-main"));
        assert_eq!(selection.terminal_id.as_deref(), Some("term-shell"));
        assert_eq!(
            active_terminal(&value, &selection)
                .and_then(|terminal| terminal.output.pty_id.as_deref()),
            Some("pty-shell"),
        );
    }

    #[test]
    fn decodes_semantic_terminal_snapshot() {
        let response: HostRpcResponse<Option<TerminalAttachResult>> = serde_json::from_str(
            include_str!("../tests/fixtures/terminal-attach-success.json"),
        )
        .expect("fixture should decode");
        let HostRpcResponse::Success { value: Some(value) } = response else {
            panic!("expected attached terminal");
        };
        let snapshot = value.semantic_snapshot.expect("semantic snapshot");
        assert_eq!(snapshot.revision, 7);
        assert_eq!(snapshot.screen_rows[0].cells[0].text, "$ ");
    }
}
