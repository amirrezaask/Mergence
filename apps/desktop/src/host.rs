use anyhow::{Context as _, Result, bail};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::model::{
    AppSession, HostRpcRequest, HostRpcResponse, MuxTerminal, SessionSnapshot, SessionTab,
    TerminalAttachResult,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostConfig {
    pub base_url: String,
    pub token: Option<String>,
    pub client_id: String,
}

impl HostConfig {
    pub fn from_env() -> Self {
        let base_url =
            std::env::var("YAADE_HOST_URL").unwrap_or_else(|_| "http://127.0.0.1:4747".to_string());
        let token = std::env::var("YAADE_HOST_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        Self {
            base_url: normalize_base_url(&base_url),
            token,
            client_id: format!("yaade-desktop-{}", uuid::Uuid::new_v4()),
        }
    }
}

#[derive(Clone, Debug)]
pub struct HostClient {
    config: HostConfig,
}

impl HostClient {
    pub fn new(config: HostConfig) -> Self {
        Self { config }
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionSnapshot>> {
        self.invoke("mux:listSessions", json!([false]))
    }

    pub fn attach_terminal(&self, pty_id: &str) -> Result<Option<TerminalAttachResult>> {
        self.attach_terminal_after(pty_id, 0)
    }

    pub fn attach_terminal_after(
        &self,
        pty_id: &str,
        after_sequence: u64,
    ) -> Result<Option<TerminalAttachResult>> {
        // Native clients consume the host's semantic stream. The optional
        // third argument keeps this compatible with older hosts that only
        // understand the two-argument attach route.
        self.invoke(
            "terminal:attach",
            json!([pty_id, after_sequence, "semantic"]),
        )
    }

    pub fn write_terminal(&self, pty_id: &str, data: &str) -> Result<()> {
        self.invoke("terminal:write", json!([pty_id, data]))
    }

    pub fn resize_terminal(&self, pty_id: &str, cols: usize, rows: usize) -> Result<()> {
        self.invoke("terminal:resize", json!([pty_id, cols, rows]))
    }

    pub fn create_session(&self) -> Result<AppSession> {
        self.invoke("mux:createSession", json!(["New session"]))
    }

    pub fn create_tab(&self, session_id: &str, title: Option<&str>) -> Result<SessionTab> {
        let mut command = json!({
            "_tag": "CreateSessionTab",
            "sessionId": session_id,
        });
        if let Some(title) = title {
            command["title"] = json!(title);
        }
        self.invoke("mux:createTab", json!([command]))
    }

    pub fn rename_session(&self, session_id: &str, title: &str) -> Result<AppSession> {
        self.invoke("mux:renameSession", json!([session_id, title]))
    }

    pub fn reorder_sessions(&self, session_ids: &[String]) -> Result<Vec<AppSession>> {
        self.invoke(
            "mux:reorderSessions",
            json!([{
                "_tag": "ReorderSessions",
                "sessionIds": session_ids,
            }]),
        )
    }

    pub fn rename_tab(&self, tab_id: &str, title: &str) -> Result<SessionTab> {
        self.invoke(
            "mux:renameTab",
            json!([{
                "_tag": "RenameSessionTab",
                "tabId": tab_id,
                "title": title,
            }]),
        )
    }

    pub fn reorder_tabs(&self, session_id: &str, tab_ids: &[String]) -> Result<Vec<SessionTab>> {
        self.invoke(
            "mux:reorderTabs",
            json!([{
                "_tag": "ReorderSessionTabs",
                "sessionId": session_id,
                "tabIds": tab_ids,
            }]),
        )
    }

    pub fn select_tab(&self, session_id: &str, tab_id: Option<&str>) -> Result<AppSession> {
        self.invoke(
            "mux:selectTab",
            match tab_id {
                Some(tab_id) => json!([{
                    "_tag": "SelectSessionTab",
                    "sessionId": session_id,
                    "tabId": tab_id,
                }]),
                None => json!([{
                    "_tag": "SelectSessionTab",
                    "sessionId": session_id,
                }]),
            },
        )
    }

    pub fn archive_session(&self, session_id: &str, mode: &str) -> Result<AppSession> {
        self.invoke(
            "mux:archiveSession",
            json!([{
                "_tag": "ArchiveSession",
                "sessionId": session_id,
                "mode": mode,
            }]),
        )
    }

    pub fn restore_session(&self, session_id: &str) -> Result<AppSession> {
        self.invoke(
            "mux:restoreSession",
            json!([{
                "_tag": "RestoreSession",
                "sessionId": session_id,
            }]),
        )
    }

    pub fn get_session(&self, session_id: &str) -> Result<Option<SessionSnapshot>> {
        self.invoke("mux:getSession", json!([session_id]))
    }

    pub fn archive_tab(&self, tab_id: &str) -> Result<SessionTab> {
        self.invoke(
            "mux:archiveTab",
            json!([{
                "_tag": "ArchiveSessionTab",
                "tabId": tab_id,
                "mode": "keep-running"
            }]),
        )
    }

    pub fn create_terminal(&self, session_id: &str, tab_id: &str) -> Result<MuxTerminal> {
        self.invoke(
            "mux:createTerminal",
            json!([{
                "_tag": "CreateTerminal",
                "sessionId": session_id,
                "tabId": tab_id,
                "kind": "terminal",
                "input": {
                    "_tag": "TerminalInput",
                    "kind": "terminal"
                }
            }]),
        )
    }

    pub fn close_terminal(&self, mux_terminal_id: &str) -> Result<MuxTerminal> {
        self.invoke(
            "mux:closeTerminal",
            json!([{
                "_tag": "CloseTerminal",
                "muxTerminalId": mux_terminal_id
            }]),
        )
    }

    pub fn stop_terminal(&self, mux_terminal_id: &str, revision: u64) -> Result<MuxTerminal> {
        self.invoke("mux:stopTerminal", json!([mux_terminal_id, revision]))
    }

    pub fn restart_terminal(&self, mux_terminal_id: &str, revision: u64) -> Result<MuxTerminal> {
        self.invoke("mux:restartTerminal", json!([mux_terminal_id, revision]))
    }

    pub fn rename_terminal(&self, mux_terminal_id: &str, title: &str) -> Result<MuxTerminal> {
        self.invoke("mux:renameTerminal", json!([mux_terminal_id, title]))
    }

    pub fn get_terminal(&self, mux_terminal_id: &str) -> Result<Option<MuxTerminal>> {
        self.invoke("mux:getTerminal", json!([mux_terminal_id]))
    }

    pub fn reorder_terminals(
        &self,
        session_id: &str,
        tab_id: Option<&str>,
        terminal_ids: &[String],
    ) -> Result<Vec<MuxTerminal>> {
        let mut command = json!({
            "_tag": "ReorderTerminals",
            "sessionId": session_id,
            "muxTerminalIds": terminal_ids,
        });
        if let Some(tab_id) = tab_id {
            command["tabId"] = json!(tab_id);
        }
        self.invoke("mux:reorderTerminals", json!([command]))
    }

    pub fn move_terminal(&self, mux_terminal_id: &str, target_tab_id: &str) -> Result<MuxTerminal> {
        self.invoke(
            "mux:moveTerminal",
            json!([{
                "_tag": "MoveTerminalToTab",
                "muxTerminalId": mux_terminal_id,
                "targetTabId": target_tab_id,
            }]),
        )
    }

    pub fn save_tab_layout(
        &self,
        tab_id: &str,
        layout_json: &str,
        revision: Option<u64>,
    ) -> Result<SessionTab> {
        let mut command = json!({
            "_tag": "SaveSessionTabLayout",
            "tabId": tab_id,
            "layoutJson": layout_json
        });
        if let Some(revision) = revision {
            command["revision"] = json!(revision);
        }
        self.invoke("mux:saveTabLayout", json!([command]))
    }

    pub fn select_terminal(
        &self,
        session_id: &str,
        mux_terminal_id: Option<&str>,
    ) -> Result<AppSession> {
        self.invoke(
            "mux:selectTerminal",
            match mux_terminal_id {
                Some(terminal_id) => json!([session_id, terminal_id]),
                None => json!([session_id]),
            },
        )
    }

    fn invoke<T>(&self, channel: &str, args: Value) -> Result<T>
    where
        T: DeserializeOwned,
    {
        let request = HostRpcRequest {
            channel,
            args,
            client_id: &self.config.client_id,
        };
        let url = format!("{}/api/v1/rpc", self.config.base_url);
        let mut builder = ureq::post(&url)
            .header("content-type", "application/json")
            .header("accept", "application/json");
        if let Some(token) = &self.config.token {
            builder = builder.header("authorization", &format!("Bearer {token}"));
        }
        let mut response = builder
            .send_json(&request)
            .with_context(|| format!("could not reach YAADE host at {}", self.config.base_url))?;
        let envelope: HostRpcResponse<T> = response
            .body_mut()
            .read_json()
            .with_context(|| format!("host returned an invalid response for {channel}"))?;
        match envelope {
            HostRpcResponse::Success { value } => Ok(value),
            HostRpcResponse::Failure { error } => {
                bail!("{}: {}", error.code, error.message)
            }
        }
    }
}

fn normalize_base_url(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        "http://127.0.0.1:4747".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_url_drops_trailing_slashes() {
        assert_eq!(
            normalize_base_url(" http://localhost:4747/// "),
            "http://localhost:4747"
        );
        assert_eq!(normalize_base_url(""), "http://127.0.0.1:4747");
    }
}
