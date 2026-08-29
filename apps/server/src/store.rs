use std::{
    fs,
    path::Path,
    sync::{Mutex, MutexGuard},
};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    database_owner::{DatabaseError, DatabaseOwner},
    model::{
    AppSession, MuxTerminal, SessionSnapshot, SessionTab, TerminalInput, TerminalOutput,
        TerminalStatus, now_iso,
    },
};

const STATE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("invalid command: {0}")]
    Invalid(String),
    #[error("storage failure: {0}")]
    Storage(String),
}

impl StoreError {
    #[must_use]
    pub const fn wire_code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "NOT_FOUND",
            Self::Conflict(_) => "CONFLICT",
            Self::Invalid(_) => "OPERATION_FAILED",
            Self::Storage(_) => "OPERATION_FAILED",
        }
    }
}

impl From<DatabaseError> for StoreError {
    fn from(error: DatabaseError) -> Self {
        Self::Storage(error.to_string())
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error.to_string())
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(error: serde_json::Error) -> Self {
        Self::Storage(error.to_string())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    schema_version: u32,
    machine: String,
    sessions: Vec<AppSession>,
    tabs: Vec<SessionTab>,
    terminals: Vec<MuxTerminal>,
}

impl PersistedState {
    fn new(machine: String) -> Self {
        let mut state = Self {
            schema_version: STATE_SCHEMA_VERSION,
            machine,
            sessions: Vec::new(),
            tabs: Vec::new(),
            terminals: Vec::new(),
        };
        state.ensure_visible_session();
        state
    }

    fn ensure_visible_session(&mut self) {
        if self
            .sessions
            .iter()
            .any(|session| session.archived_at.is_none())
        {
            return;
        }
        let timestamp = now_iso();
        let session_id = format!("ses-{}", Uuid::new_v4());
        let tab_id = format!("tab-{}", Uuid::new_v4());
        self.sessions.push(AppSession {
            id: session_id.clone(),
            title: "Session 1".to_owned(),
            position: 0,
            active_tab_id: Some(tab_id.clone()),
            active_mux_terminal_id: None,
            revision: 2,
            created_at: timestamp.clone(),
            updated_at: timestamp.clone(),
            archived_at: None,
        });
        self.tabs.push(SessionTab {
            id: tab_id,
            session_id,
            title: "Window 1".to_owned(),
            position: 0,
            active_mux_terminal_id: None,
            layout_json: None,
            revision: 1,
            created_at: timestamp.clone(),
            updated_at: timestamp,
            archived_at: None,
        });
    }
}

pub struct StateStore {
    database: DatabaseOwner,
    state: Mutex<PersistedState>,
    server_id: String,
}

impl StateStore {
    pub fn open(path: &Path, machine: String) -> Result<Self, StoreError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| StoreError::Storage(error.to_string()))?;
        }
        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS host_identity(
               singleton INTEGER PRIMARY KEY CHECK(singleton=1),
               server_id TEXT NOT NULL,
               created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS rust_runtime_state(
               singleton INTEGER PRIMARY KEY CHECK(singleton=1),
               schema_version INTEGER NOT NULL,
               state_json TEXT NOT NULL,
               updated_at TEXT NOT NULL
             );",
        )?;
        let quick_check: String =
            connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if quick_check != "ok" {
            return Err(StoreError::Storage(format!(
                "sqlite integrity check failed: {quick_check}"
            )));
        }
        let server_id = connection
            .query_row(
                "SELECT server_id FROM host_identity WHERE singleton=1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        connection.execute(
            "INSERT OR IGNORE INTO host_identity(singleton,server_id,created_at) VALUES(1,?,?)",
            params![server_id, now_iso()],
        )?;
        let persisted = connection
            .query_row(
                "SELECT state_json FROM rust_runtime_state WHERE singleton=1 AND schema_version=?",
                [STATE_SCHEMA_VERSION],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let mut state = persisted
            .as_deref()
            .and_then(|json| serde_json::from_str::<PersistedState>(json).ok())
            .filter(|state| {
                state.schema_version == STATE_SCHEMA_VERSION && state.machine == machine
            })
            .unwrap_or_else(|| PersistedState::new(machine));
        state.ensure_visible_session();
        let encoded = serde_json::to_string(&state)?;
        connection.execute(
            "INSERT INTO rust_runtime_state(singleton,schema_version,state_json,updated_at)
             VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET
             schema_version=excluded.schema_version,state_json=excluded.state_json,updated_at=excluded.updated_at",
            params![STATE_SCHEMA_VERSION, encoded, now_iso()],
        )?;
        Ok(Self {
            connection: Mutex::new(connection),
            state: Mutex::new(state),
            server_id,
        })
    }

    pub fn reset_runtime_state(&self) -> Result<(), StoreError> {
        let machine = self.state().machine.clone();
        self.mutate(|state| {
            *state = PersistedState::new(machine);
            Ok(())
        })
    }

    #[must_use]
    pub fn server_id(&self) -> &str {
        &self.server_id
    }

    pub(crate) fn with_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> Result<T, rusqlite::Error>,
    ) -> Result<T, StoreError> {
        operation(
            &self
                .connection
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
        .map_err(Into::into)
    }

    pub fn health(&self) -> bool {
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .query_row("SELECT 1", [], |_| Ok(()))
            .is_ok()
    }

    fn state(&self) -> MutexGuard<'_, PersistedState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn mutate<T>(
        &self,
        operation: impl FnOnce(&mut PersistedState) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let mut current = self.state();
        let mut next = current.clone();
        let result = operation(&mut next)?;
        let encoded = serde_json::to_string(&next)?;
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .execute(
                "UPDATE rust_runtime_state SET state_json=?,updated_at=? WHERE singleton=1",
                params![encoded, now_iso()],
            )?;
        *current = next;
        Ok(result)
    }

    #[must_use]
    pub fn list_snapshots(&self, include_archived: bool) -> Vec<SessionSnapshot> {
        let state = self.state();
        let mut sessions = state
            .sessions
            .iter()
            .filter(|session| include_archived || session.archived_at.is_none())
            .cloned()
            .collect::<Vec<_>>();
        sessions.sort_by_key(|session| session.position);
        sessions
            .into_iter()
            .map(|session| snapshot(&state, session, include_archived))
            .collect()
    }

    #[must_use]
    pub fn get_snapshot(&self, session_id: &str) -> Option<SessionSnapshot> {
        let state = self.state();
        state
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
            .map(|session| snapshot(&state, session, false))
    }

    #[must_use]
    pub fn get_session(&self, session_id: &str) -> Option<AppSession> {
        self.state()
            .sessions
            .iter()
            .find(|session| session.id == session_id)
            .cloned()
    }

    #[must_use]
    pub fn get_tab(&self, tab_id: &str) -> Option<SessionTab> {
        self.state()
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .cloned()
    }

    #[must_use]
    pub fn get_terminal(&self, terminal_id: &str) -> Option<MuxTerminal> {
        self.state()
            .terminals
            .iter()
            .find(|terminal| terminal.id == terminal_id)
            .cloned()
    }

    #[must_use]
    pub fn terminal_for_pty(&self, pty_id: &str) -> Option<MuxTerminal> {
        self.state()
            .terminals
            .iter()
            .find(|terminal| terminal.output.pty_id.as_deref() == Some(pty_id))
            .cloned()
    }

    #[must_use]
    pub fn terminals_for_session(
        &self,
        session_id: &str,
        include_archived: bool,
    ) -> Vec<MuxTerminal> {
        let mut terminals = self
            .state()
            .terminals
            .iter()
            .filter(|terminal| {
                terminal.session_id == session_id
                    && (include_archived || terminal.archived_at.is_none())
            })
            .cloned()
            .collect::<Vec<_>>();
        terminals.sort_by_key(|terminal| terminal.position);
        terminals
    }

    #[must_use]
    pub fn terminals_for_tab(&self, tab_id: &str, include_archived: bool) -> Vec<MuxTerminal> {
        let mut terminals = self
            .state()
            .terminals
            .iter()
            .filter(|terminal| {
                terminal.tab_id.as_deref() == Some(tab_id)
                    && (include_archived || terminal.archived_at.is_none())
            })
            .cloned()
            .collect::<Vec<_>>();
        terminals.sort_by_key(|terminal| terminal.position);
        terminals
    }

    pub fn create_session(&self, title: &str) -> Result<AppSession, StoreError> {
        self.mutate(|state| {
            let timestamp = now_iso();
            let session_id = format!("ses-{}", Uuid::new_v4());
            let tab_id = format!("tab-{}", Uuid::new_v4());
            let position = state
                .sessions
                .iter()
                .filter(|session| session.archived_at.is_none())
                .count();
            let session = AppSession {
                id: session_id.clone(),
                title: nonempty(title, "New session"),
                position,
                active_tab_id: Some(tab_id.clone()),
                active_mux_terminal_id: None,
                revision: 2,
                created_at: timestamp.clone(),
                updated_at: timestamp.clone(),
                archived_at: None,
            };
            state.sessions.push(session.clone());
            state.tabs.push(SessionTab {
                id: tab_id,
                session_id,
                title: "Window 1".to_owned(),
                position: 0,
                active_mux_terminal_id: None,
                layout_json: None,
                revision: 1,
                created_at: timestamp.clone(),
                updated_at: timestamp,
                archived_at: None,
            });
            Ok(session)
        })
    }

    pub fn rename_session(&self, session_id: &str, title: &str) -> Result<AppSession, StoreError> {
        self.mutate(|state| {
            let session = find_session_mut(state, session_id)?;
            session.title = nonempty(title, &session.title);
            touch_session(session);
            Ok(session.clone())
        })
    }

    pub fn reorder_sessions(&self, ids: &[String]) -> Result<Vec<AppSession>, StoreError> {
        self.mutate(|state| {
            let current = state
                .sessions
                .iter()
                .filter(|session| session.archived_at.is_none())
                .map(|session| session.id.clone())
                .collect::<Vec<_>>();
            assert_permutation(ids, &current, "sessions")?;
            let timestamp = now_iso();
            for (position, id) in ids.iter().enumerate() {
                let session = find_session_mut(state, id)?;
                session.position = position;
                session.updated_at = timestamp.clone();
                session.revision += 1;
            }
            Ok(ordered_sessions(state, false))
        })
    }

    pub fn create_tab(&self, session_id: &str, title: &str) -> Result<SessionTab, StoreError> {
        self.mutate(|state| {
            if !state
                .sessions
                .iter()
                .any(|session| session.id == session_id && session.archived_at.is_none())
            {
                return Err(StoreError::NotFound(format!("session {session_id}")));
            }
            let timestamp = now_iso();
            let tab = SessionTab {
                id: format!("tab-{}", Uuid::new_v4()),
                session_id: session_id.to_owned(),
                title: nonempty(title, "New tab"),
                position: state
                    .tabs
                    .iter()
                    .filter(|tab| tab.session_id == session_id && tab.archived_at.is_none())
                    .count(),
                active_mux_terminal_id: None,
                layout_json: None,
                revision: 1,
                created_at: timestamp.clone(),
                updated_at: timestamp.clone(),
                archived_at: None,
            };
            state.tabs.push(tab.clone());
            let session = find_session_mut(state, session_id)?;
            if session.active_tab_id.is_none() {
                session.active_tab_id = Some(tab.id.clone());
                touch_session(session);
            }
            Ok(tab)
        })
    }

    pub fn rename_tab(&self, tab_id: &str, title: &str) -> Result<SessionTab, StoreError> {
        self.mutate(|state| {
            let tab = find_tab_mut(state, tab_id)?;
            tab.title = nonempty(title, &tab.title).chars().take(160).collect();
            touch_tab(tab);
            Ok(tab.clone())
        })
    }

    pub fn save_tab_layout(
        &self,
        tab_id: &str,
        layout_json: &str,
        expected_revision: Option<u64>,
    ) -> Result<SessionTab, StoreError> {
        if layout_json.len() > 65_536 {
            return Err(StoreError::Invalid("layout exceeds 65536 bytes".to_owned()));
        }
        self.mutate(|state| {
            let tab = find_tab_mut(state, tab_id)?;
            if tab.archived_at.is_some() {
                return Err(StoreError::NotFound(format!("tab {tab_id}")));
            }
            if expected_revision.is_some_and(|revision| revision != tab.revision) {
                return Err(StoreError::Conflict(format!("tab revision {tab_id}")));
            }
            tab.layout_json = Some(layout_json.to_owned());
            touch_tab(tab);
            Ok(tab.clone())
        })
    }

    pub fn reorder_tabs(
        &self,
        session_id: &str,
        ids: &[String],
    ) -> Result<Vec<SessionTab>, StoreError> {
        self.mutate(|state| {
            let current = ordered_tabs(state, session_id, false)
                .into_iter()
                .map(|tab| tab.id)
                .collect::<Vec<_>>();
            assert_permutation(ids, &current, "tabs")?;
            let timestamp = now_iso();
            for (position, id) in ids.iter().enumerate() {
                let tab = find_tab_mut(state, id)?;
                tab.position = position;
                tab.updated_at = timestamp.clone();
                tab.revision += 1;
            }
            Ok(ordered_tabs(state, session_id, false))
        })
    }

    pub fn select_tab(
        &self,
        session_id: &str,
        tab_id: Option<&str>,
    ) -> Result<AppSession, StoreError> {
        self.mutate(|state| {
            let selected = match tab_id {
                Some(tab_id) => {
                    let tab = state
                        .tabs
                        .iter()
                        .find(|tab| {
                            tab.id == tab_id
                                && tab.session_id == session_id
                                && tab.archived_at.is_none()
                        })
                        .ok_or_else(|| {
                            StoreError::Invalid("active tab does not belong to session".to_owned())
                        })?;
                    Some((tab.id.clone(), tab.active_mux_terminal_id.clone()))
                }
                None => None,
            };
            let session = find_session_mut(state, session_id)?;
            session.active_tab_id = selected.as_ref().map(|(id, _)| id.clone());
            session.active_mux_terminal_id = selected.and_then(|(_, terminal)| terminal);
            touch_session(session);
            Ok(session.clone())
        })
    }

    pub fn archive_tab(&self, tab_id: &str) -> Result<SessionTab, StoreError> {
        self.mutate(|state| {
            let current = state
                .tabs
                .iter()
                .find(|tab| tab.id == tab_id)
                .cloned()
                .ok_or_else(|| StoreError::NotFound(format!("tab {tab_id}")))?;
            if current.archived_at.is_some() {
                return Ok(current);
            }
            let timestamp = now_iso();
            let tab = find_tab_mut(state, tab_id)?;
            tab.archived_at = Some(timestamp.clone());
            touch_tab(tab);
            let archived = tab.clone();
            if !state
                .tabs
                .iter()
                .any(|tab| tab.session_id == current.session_id && tab.archived_at.is_none())
            {
                let replacement = SessionTab {
                    id: format!("tab-{}", Uuid::new_v4()),
                    session_id: current.session_id.clone(),
                    title: "Window 1".to_owned(),
                    position: 0,
                    active_mux_terminal_id: None,
                    layout_json: None,
                    revision: 1,
                    created_at: timestamp.clone(),
                    updated_at: timestamp.clone(),
                    archived_at: None,
                };
                state.tabs.push(replacement);
            }
            let next = ordered_tabs(state, &current.session_id, false)
                .into_iter()
                .next();
            let session = find_session_mut(state, &current.session_id)?;
            if session.active_tab_id.as_deref() == Some(tab_id) {
                session.active_tab_id = next.as_ref().map(|tab| tab.id.clone());
                session.active_mux_terminal_id = next.and_then(|tab| tab.active_mux_terminal_id);
                touch_session(session);
            }
            Ok(archived)
        })
    }

    pub fn archive_session(&self, session_id: &str) -> Result<AppSession, StoreError> {
        self.mutate(|state| {
            let session = find_session_mut(state, session_id)?;
            if session.archived_at.is_none() {
                let timestamp = now_iso();
                session.archived_at = Some(timestamp);
                touch_session(session);
            }
            let archived = session.clone();
            state.ensure_visible_session();
            Ok(archived)
        })
    }

    pub fn restore_session(&self, session_id: &str) -> Result<AppSession, StoreError> {
        self.mutate(|state| {
            let session = find_session_mut(state, session_id)?;
            session.archived_at = None;
            touch_session(session);
            Ok(session.clone())
        })
    }

    pub fn create_terminal(
        &self,
        session_id: &str,
        tab_id: Option<&str>,
        title: &str,
        input: TerminalInput,
    ) -> Result<MuxTerminal, StoreError> {
        self.mutate(|state| {
            if !state
                .sessions
                .iter()
                .any(|session| session.id == session_id && session.archived_at.is_none())
            {
                return Err(StoreError::NotFound(format!("session {session_id}")));
            }
            let selected_tab = tab_id
                .map(str::to_owned)
                .or_else(|| {
                    state
                        .sessions
                        .iter()
                        .find(|session| session.id == session_id)
                        .and_then(|session| session.active_tab_id.clone())
                })
                .ok_or_else(|| StoreError::NotFound(format!("tab for {session_id}")))?;
            if !state.tabs.iter().any(|tab| {
                tab.id == selected_tab && tab.session_id == session_id && tab.archived_at.is_none()
            }) {
                return Err(StoreError::Invalid(
                    "terminal tab does not belong to session".to_owned(),
                ));
            }
            let timestamp = now_iso();
            let terminal = MuxTerminal {
                id: format!("term-{}", Uuid::new_v4()),
                session_id: session_id.to_owned(),
                tab_id: Some(selected_tab.clone()),
                kind: "terminal".to_owned(),
                title: nonempty(title, "Terminal"),
                position: state
                    .terminals
                    .iter()
                    .filter(|terminal| {
                        terminal.tab_id.as_deref() == Some(&selected_tab)
                            && terminal.archived_at.is_none()
                    })
                    .count(),
                status: TerminalStatus::Created,
                input,
                input_revision: 1,
                output: TerminalOutput::pending(),
                error: None,
                revision: 1,
                created_at: timestamp.clone(),
                updated_at: timestamp,
                started_at: None,
                finished_at: None,
                archived_at: None,
            };
            state.terminals.push(terminal.clone());
            select_terminal_in_state(state, session_id, Some(&terminal.id))?;
            Ok(terminal)
        })
    }

    pub fn update_terminal(
        &self,
        terminal_id: &str,
        expected_revision: Option<u64>,
        update: impl FnOnce(&mut MuxTerminal),
    ) -> Result<MuxTerminal, StoreError> {
        self.mutate(|state| {
            let terminal = find_terminal_mut(state, terminal_id)?;
            if expected_revision.is_some_and(|revision| terminal.revision != revision) {
                return Err(StoreError::Conflict(format!(
                    "terminal revision {terminal_id}"
                )));
            }
            update(terminal);
            terminal.revision += 1;
            terminal.updated_at = now_iso();
            if matches!(
                terminal.status,
                TerminalStatus::Starting | TerminalStatus::Running | TerminalStatus::Waiting
            ) && terminal.started_at.is_none()
            {
                terminal.started_at = Some(terminal.updated_at.clone());
            }
            if matches!(
                terminal.status,
                TerminalStatus::Succeeded
                    | TerminalStatus::Failed
                    | TerminalStatus::Cancelled
                    | TerminalStatus::Disconnected
            ) && terminal.finished_at.is_none()
            {
                terminal.finished_at = Some(terminal.updated_at.clone());
            }
            Ok(terminal.clone())
        })
    }

    pub fn rename_terminal(
        &self,
        terminal_id: &str,
        title: &str,
    ) -> Result<MuxTerminal, StoreError> {
        self.update_terminal(terminal_id, None, |terminal| {
            terminal.title = nonempty(title, &terminal.title).chars().take(160).collect();
        })
    }

    pub fn select_terminal(
        &self,
        session_id: &str,
        terminal_id: Option<&str>,
    ) -> Result<AppSession, StoreError> {
        self.mutate(|state| select_terminal_in_state(state, session_id, terminal_id))
    }

    pub fn reorder_terminals(
        &self,
        session_id: &str,
        tab_id: Option<&str>,
        ids: &[String],
    ) -> Result<Vec<MuxTerminal>, StoreError> {
        self.mutate(|state| {
            let selected_tab = tab_id
                .map(str::to_owned)
                .or_else(|| {
                    state
                        .sessions
                        .iter()
                        .find(|session| session.id == session_id)
                        .and_then(|session| session.active_tab_id.clone())
                })
                .ok_or_else(|| StoreError::NotFound("active tab".to_owned()))?;
            if !state.tabs.iter().any(|tab| {
                tab.id == selected_tab && tab.session_id == session_id && tab.archived_at.is_none()
            }) {
                return Err(StoreError::Invalid(
                    "terminal tab does not belong to session".to_owned(),
                ));
            }
            let current = ordered_terminals(state, &selected_tab, false)
                .into_iter()
                .map(|terminal| terminal.id)
                .collect::<Vec<_>>();
            assert_permutation(ids, &current, "terminals")?;
            let timestamp = now_iso();
            for (position, id) in ids.iter().enumerate() {
                let terminal = find_terminal_mut(state, id)?;
                terminal.position = position;
                terminal.revision += 1;
                terminal.updated_at = timestamp.clone();
            }
            Ok(ordered_terminals(state, &selected_tab, false))
        })
    }

    pub fn move_terminal(
        &self,
        terminal_id: &str,
        target_tab_id: &str,
    ) -> Result<MuxTerminal, StoreError> {
        self.mutate(|state| {
            let current = state
                .terminals
                .iter()
                .find(|terminal| terminal.id == terminal_id && terminal.archived_at.is_none())
                .cloned()
                .ok_or_else(|| StoreError::NotFound(format!("terminal {terminal_id}")))?;
            if !state.tabs.iter().any(|tab| {
                tab.id == target_tab_id
                    && tab.session_id == current.session_id
                    && tab.archived_at.is_none()
            }) {
                return Err(StoreError::Invalid(
                    "target tab does not belong to session".to_owned(),
                ));
            }
            if current.tab_id.as_deref() == Some(target_tab_id) {
                return Ok(current);
            }
            let position = state
                .terminals
                .iter()
                .filter(|terminal| {
                    terminal.tab_id.as_deref() == Some(target_tab_id)
                        && terminal.archived_at.is_none()
                })
                .count();
            let source_replacement = current.tab_id.as_deref().and_then(|source_tab_id| {
                ordered_terminals(state, source_tab_id, false)
                    .into_iter()
                    .find(|terminal| terminal.id != terminal_id)
                    .map(|terminal| terminal.id)
            });
            let timestamp = now_iso();
            let terminal = find_terminal_mut(state, terminal_id)?;
            terminal.tab_id = Some(target_tab_id.to_owned());
            terminal.position = position;
            terminal.revision += 1;
            terminal.updated_at = timestamp;
            let moved = terminal.clone();
            if let Some(source_tab_id) = current.tab_id.as_deref() {
                let source = find_tab_mut(state, source_tab_id)?;
                if source.active_mux_terminal_id.as_deref() == Some(terminal_id) {
                    source.active_mux_terminal_id = source_replacement;
                }
                touch_tab(source);
            }
            select_terminal_in_state(state, &current.session_id, Some(terminal_id))?;
            Ok(moved)
        })
    }

    pub fn archive_terminal(&self, terminal_id: &str) -> Result<MuxTerminal, StoreError> {
        self.mutate(|state| {
            let current = state
                .terminals
                .iter()
                .find(|terminal| terminal.id == terminal_id)
                .cloned()
                .ok_or_else(|| StoreError::NotFound(format!("terminal {terminal_id}")))?;
            if current.archived_at.is_some() {
                return Ok(current);
            }
            let terminal = find_terminal_mut(state, terminal_id)?;
            terminal.archived_at = Some(now_iso());
            terminal.revision += 1;
            terminal.updated_at = now_iso();
            let archived = terminal.clone();
            let next = current.tab_id.as_deref().and_then(|tab_id| {
                ordered_terminals(state, tab_id, false)
                    .into_iter()
                    .next()
                    .map(|terminal| terminal.id)
            });
            if let Some(tab_id) = current.tab_id.as_deref()
                && let Ok(tab) = find_tab_mut(state, tab_id)
                && tab.active_mux_terminal_id.as_deref() == Some(terminal_id)
            {
                tab.active_mux_terminal_id = next.clone();
                touch_tab(tab);
            }
            let session = find_session_mut(state, &current.session_id)?;
            if session.active_mux_terminal_id.as_deref() == Some(terminal_id) {
                session.active_mux_terminal_id = next;
                touch_session(session);
            }
            Ok(archived)
        })
    }
}

fn snapshot(
    state: &PersistedState,
    session: AppSession,
    include_archived: bool,
) -> SessionSnapshot {
    let mut tabs = state
        .tabs
        .iter()
        .filter(|tab| {
            tab.session_id == session.id && (include_archived || tab.archived_at.is_none())
        })
        .cloned()
        .collect::<Vec<_>>();
    tabs.sort_by_key(|tab| tab.position);
    let mut terminals = state
        .terminals
        .iter()
        .filter(|terminal| {
            terminal.session_id == session.id
                && (include_archived || terminal.archived_at.is_none())
        })
        .cloned()
        .collect::<Vec<_>>();
    terminals.sort_by_key(|terminal| terminal.position);
    SessionSnapshot {
        session,
        tabs,
        mux_terminals: terminals,
    }
}

fn find_session_mut<'a>(
    state: &'a mut PersistedState,
    id: &str,
) -> Result<&'a mut AppSession, StoreError> {
    state
        .sessions
        .iter_mut()
        .find(|session| session.id == id)
        .ok_or_else(|| StoreError::NotFound(format!("session {id}")))
}

fn find_tab_mut<'a>(
    state: &'a mut PersistedState,
    id: &str,
) -> Result<&'a mut SessionTab, StoreError> {
    state
        .tabs
        .iter_mut()
        .find(|tab| tab.id == id)
        .ok_or_else(|| StoreError::NotFound(format!("tab {id}")))
}

fn find_terminal_mut<'a>(
    state: &'a mut PersistedState,
    id: &str,
) -> Result<&'a mut MuxTerminal, StoreError> {
    state
        .terminals
        .iter_mut()
        .find(|terminal| terminal.id == id)
        .ok_or_else(|| StoreError::NotFound(format!("terminal {id}")))
}

fn touch_session(session: &mut AppSession) {
    session.revision += 1;
    session.updated_at = now_iso();
}

fn touch_tab(tab: &mut SessionTab) {
    tab.revision += 1;
    tab.updated_at = now_iso();
}

fn nonempty(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn assert_permutation(
    actual: &[String],
    expected: &[String],
    label: &str,
) -> Result<(), StoreError> {
    let mut actual_sorted = actual.to_vec();
    let mut expected_sorted = expected.to_vec();
    actual_sorted.sort();
    actual_sorted.dedup();
    expected_sorted.sort();
    if actual.len() != expected.len() || actual_sorted != expected_sorted {
        return Err(StoreError::Invalid(format!("invalid {label} order")));
    }
    Ok(())
}

fn ordered_sessions(state: &PersistedState, include_archived: bool) -> Vec<AppSession> {
    let mut sessions = state
        .sessions
        .iter()
        .filter(|session| include_archived || session.archived_at.is_none())
        .cloned()
        .collect::<Vec<_>>();
    sessions.sort_by_key(|session| session.position);
    sessions
}

fn ordered_tabs(
    state: &PersistedState,
    session_id: &str,
    include_archived: bool,
) -> Vec<SessionTab> {
    let mut tabs = state
        .tabs
        .iter()
        .filter(|tab| {
            tab.session_id == session_id && (include_archived || tab.archived_at.is_none())
        })
        .cloned()
        .collect::<Vec<_>>();
    tabs.sort_by_key(|tab| tab.position);
    tabs
}

fn ordered_terminals(
    state: &PersistedState,
    tab_id: &str,
    include_archived: bool,
) -> Vec<MuxTerminal> {
    let mut terminals = state
        .terminals
        .iter()
        .filter(|terminal| {
            terminal.tab_id.as_deref() == Some(tab_id)
                && (include_archived || terminal.archived_at.is_none())
        })
        .cloned()
        .collect::<Vec<_>>();
    terminals.sort_by_key(|terminal| terminal.position);
    terminals
}

fn select_terminal_in_state(
    state: &mut PersistedState,
    session_id: &str,
    terminal_id: Option<&str>,
) -> Result<AppSession, StoreError> {
    let tab_id = terminal_id
        .map(|id| {
            state
                .terminals
                .iter()
                .find(|terminal| {
                    terminal.id == id
                        && terminal.session_id == session_id
                        && terminal.archived_at.is_none()
                })
                .and_then(|terminal| terminal.tab_id.clone())
                .ok_or_else(|| {
                    StoreError::Invalid("active terminal does not belong to session".to_owned())
                })
        })
        .transpose()?;
    if let Some(tab_id) = tab_id.as_deref() {
        let tab = find_tab_mut(state, tab_id)?;
        tab.active_mux_terminal_id = terminal_id.map(str::to_owned);
        touch_tab(tab);
    }
    let session = find_session_mut(state, session_id)?;
    if tab_id.is_some() {
        session.active_tab_id = tab_id;
    }
    session.active_mux_terminal_id = terminal_id.map(str::to_owned);
    touch_session(session);
    Ok(session.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> StateStore {
        StateStore::open(Path::new(":memory:"), "test-machine".to_owned()).expect("store")
    }

    #[test]
    fn host_identity_remains_stable_across_database_reopen() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("yaade.sqlite3");
        let first = StateStore::open(&path, "machine".to_owned()).expect("first");
        let identity = first.server_id().to_owned();
        drop(first);
        let second = StateStore::open(&path, "machine".to_owned()).expect("second");
        assert_eq!(second.server_id(), identity);
    }

    #[test]
    fn corrupt_database_is_refused_without_wiping_it() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("yaade.sqlite3");
        fs::write(&path, b"not sqlite").expect("corrupt database");
        assert!(StateStore::open(&path, "machine".to_owned()).is_err());
        assert_eq!(fs::read(&path).expect("database retained"), b"not sqlite");
    }

    #[test]
    fn creates_a_default_session_and_tab() {
        let store = store();
        let snapshots = store.list_snapshots(false);
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].tabs.len(), 1);
        assert_eq!(
            snapshots[0].session.active_tab_id,
            Some(snapshots[0].tabs[0].id.clone())
        );
    }

    #[test]
    fn archived_last_session_gets_a_replacement() {
        let store = store();
        let id = store.list_snapshots(false)[0].session.id.clone();
        store.archive_session(&id).expect("archive");
        let visible = store.list_snapshots(false);
        assert_eq!(visible.len(), 1);
        assert_ne!(visible[0].session.id, id);
    }

    #[test]
    fn incomplete_reorders_are_rejected_and_valid_reorders_increment_revisions() {
        let store = store();
        let first = store.list_snapshots(false)[0].session.clone();
        let second = store.create_session("Second").expect("second");
        assert!(store.reorder_sessions(&[first.id.clone()]).is_err());
        let reordered = store
            .reorder_sessions(&[second.id.clone(), first.id.clone()])
            .expect("reorder");
        assert_eq!(reordered[0].id, second.id);
        assert!(reordered[0].revision > second.revision);
    }

    #[test]
    fn archiving_a_focused_terminal_clears_focus_pointers() {
        let store = store();
        let snapshot = store.list_snapshots(false).remove(0);
        let terminal = store
            .create_terminal(
                &snapshot.session.id,
                snapshot.session.active_tab_id.as_deref(),
                "Terminal",
                TerminalInput::default(),
            )
            .expect("terminal");
        store.archive_terminal(&terminal.id).expect("archive");
        let session = store.get_session(&snapshot.session.id).expect("session");
        let tab = store.get_tab(snapshot.session.active_tab_id.as_deref().expect("tab")).expect("tab");
        assert_eq!(session.active_mux_terminal_id, None);
        assert_eq!(tab.active_mux_terminal_id, None);
    }

    #[test]
    fn moving_a_terminal_preserves_its_runtime_output() {
        let store = store();
        let snapshot = store.list_snapshots(false).remove(0);
        let terminal = store
            .create_terminal(
                &snapshot.session.id,
                snapshot.session.active_tab_id.as_deref(),
                "Terminal",
                TerminalInput::default(),
            )
            .expect("terminal");
        let running = store
            .update_terminal(&terminal.id, Some(terminal.revision), |value| {
                value.status = TerminalStatus::Running;
                value.output = TerminalOutput::running("pty-1".to_owned(), 0);
            })
            .expect("running");
        let target = store.create_tab(&snapshot.session.id, "Window 2").expect("tab");
        let moved = store.move_terminal(&running.id, &target.id).expect("move");
        assert_eq!(moved.output.pty_id.as_deref(), Some("pty-1"));
        assert_eq!(moved.status, TerminalStatus::Running);
    }

    #[test]
    fn active_terminal_must_belong_to_the_selected_session() {
        let store = store();
        let first = store.list_snapshots(false).remove(0);
        let second = store.create_session("Second").expect("second");
        let terminal = store
            .create_terminal(
                &first.session.id,
                first.session.active_tab_id.as_deref(),
                "Terminal",
                TerminalInput::default(),
            )
            .expect("terminal");
        assert!(store.select_terminal(&second.id, Some(&terminal.id)).is_err());
    }

    #[test]
    fn moving_the_active_terminal_repairs_both_tab_selections() {
        let store = store();
        let snapshot = &store.list_snapshots(false)[0];
        let source_tab = &snapshot.tabs[0];
        let first = store
            .create_terminal(
                &snapshot.session.id,
                Some(&source_tab.id),
                "First",
                TerminalInput::default(),
            )
            .expect("first terminal");
        let second = store
            .create_terminal(
                &snapshot.session.id,
                Some(&source_tab.id),
                "Second",
                TerminalInput::default(),
            )
            .expect("second terminal");
        let target = store
            .create_tab(&snapshot.session.id, "Window 2")
            .expect("target tab");

        store
            .move_terminal(&second.id, &target.id)
            .expect("move terminal");

        assert_eq!(
            store
                .get_tab(&source_tab.id)
                .expect("source")
                .active_mux_terminal_id,
            Some(first.id),
        );
        assert_eq!(
            store
                .get_tab(&target.id)
                .expect("target")
                .active_mux_terminal_id,
            Some(second.id.clone()),
        );
        let session = store.get_session(&snapshot.session.id).expect("session");
        assert_eq!(session.active_tab_id, Some(target.id));
        assert_eq!(session.active_mux_terminal_id, Some(second.id));
    }

    #[test]
    fn terminal_revisions_are_fenced() {
        let store = store();
        let snapshot = &store.list_snapshots(false)[0];
        let terminal = store
            .create_terminal(
                &snapshot.session.id,
                snapshot.session.active_tab_id.as_deref(),
                "Terminal",
                TerminalInput::default(),
            )
            .expect("terminal");
        store
            .update_terminal(&terminal.id, Some(terminal.revision), |terminal| {
                terminal.status = TerminalStatus::Running;
            })
            .expect("update");
        assert!(matches!(
            store.update_terminal(&terminal.id, Some(terminal.revision), |_| {}),
            Err(StoreError::Conflict(_))
        ));
    }
}
