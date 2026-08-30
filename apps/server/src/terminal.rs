use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command as ProcessCommand,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Instant,
};

use base64::Engine as _;
use bytes::Bytes;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use serde_json::json;
use thiserror::Error;
use uuid::Uuid;

use crate::{
    event_hub::EventHub,
    terminal_control::{
        RuntimeTerminalLease, TerminalControlError, TerminalControlRegistry, TerminalLeaseRequest,
    },
    terminal_history::{Base64Bytes, HistoryError, TerminalHistoryArchive, TerminalHistoryPage},
    wire::{TerminalLeaseMode, TerminalMutationFence},
};

const MAX_ENTRIES: usize = 64;
const MAX_REPLAY_BYTES: usize = 2 * 1024 * 1024;
const EXITED_REPLAY_BYTES: usize = 256 * 1024;
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const CHECKPOINT_BYTES: usize = 512 * 1024;
const CHECKPOINT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);
const EXITED_DISPOSE_TTL: std::time::Duration = std::time::Duration::from_secs(90);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalColor {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTheme {
    pub foreground: TerminalColor,
    pub background: TerminalColor,
    pub cursor: TerminalColor,
}

impl Default for TerminalTheme {
    fn default() -> Self {
        Self {
            foreground: TerminalColor {
                r: 238,
                g: 242,
                b: 247,
            },
            background: TerminalColor {
                r: 14,
                g: 21,
                b: 27,
            },
            cursor: TerminalColor {
                r: 0,
                g: 106,
                b: 222,
            },
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLaunch {
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub theme: Option<TerminalTheme>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessIdentity {
    pub pid: u32,
    pub platform: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boot_id: Option<String>,
    pub start_token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateResult {
    pub id: String,
    pub title: Option<String>,
    pub os_pid: Option<u32>,
    pub process_identity: Option<ProcessIdentity>,
    pub terminal_epoch: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInspect {
    pub id: String,
    pub title: Option<String>,
    pub status: TerminalProcessStatus,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub spawn_command: Option<String>,
    pub spawn_cwd: String,
    pub os_pid: Option<u32>,
    pub process_identity: Option<ProcessIdentity>,
    pub terminal_epoch: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalProcessStatus {
    Running,
    Exited,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCheckpoint {
    #[serde(rename = "checkpointVersion")]
    pub checkpoint_version: u8,
    #[serde(rename = "terminalEpoch")]
    pub terminal_epoch: String,
    pub sequence: u64,
    pub cols: u16,
    pub rows: u16,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "syntheticBytes")]
    pub synthetic_bytes: Base64Bytes,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttach {
    pub id: String,
    pub title: Option<String>,
    pub terminal_epoch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<TerminalCheckpoint>,
    pub replay_quality: &'static str,
    pub output_chunks: Vec<Base64Bytes>,
    pub output: Base64Bytes,
    pub replay_truncated: bool,
    pub replay_needs_query_responses: bool,
    pub archive_available: bool,
    pub last_sequence: u64,
    pub cols: u16,
    pub rows: u16,
    pub status: TerminalProcessStatus,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Debug, Error)]
pub enum TerminalError {
    #[error("terminal not found: {0}")]
    NotFound(String),
    #[error("too many terminals (max 64); close a terminal before creating another")]
    Limit,
    #[error("invalid terminal input: {0}")]
    Invalid(String),
    #[error("terminal runtime failure: {0}")]
    Runtime(String),
    #[error(transparent)]
    Control(#[from] TerminalControlError),
    #[error(transparent)]
    History(#[from] HistoryError),
}

impl TerminalError {
    #[must_use]
    pub const fn wire_code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "NOT_FOUND",
            Self::Limit | Self::Invalid(_) | Self::Runtime(_) | Self::History(_) => {
                "OPERATION_FAILED"
            }
            Self::Control(error) => error.code.as_wire_code(),
        }
    }
}

#[derive(Clone)]
struct ReplayChunk {
    sequence: u64,
    data: Bytes,
}

struct EntryState {
    status: TerminalProcessStatus,
    exit_code: Option<i32>,
    signal: Option<i32>,
    sequence: u64,
    replay: VecDeque<ReplayChunk>,
    replay_bytes: usize,
    replay_truncated: bool,
    cols: u16,
    rows: u16,
    disposed: bool,
    replay_ready_clients: HashSet<String>,
    query_leftover: Vec<u8>,
    osc7_scanner: Osc7Scanner,
    terminal_theme: TerminalTheme,
    theme_updates_enabled: bool,
    live_cwd: Option<PathBuf>,
    recorder: Option<vt100::Parser>,
    checkpoint: Option<TerminalCheckpoint>,
    bytes_since_checkpoint: usize,
    last_checkpoint_at: Instant,
}

struct TerminalEntry {
    id: String,
    title: Option<String>,
    terminal_epoch: String,
    spawn_command: Option<String>,
    spawn_cwd: PathBuf,
    os_pid: Option<u32>,
    process_identity: Option<ProcessIdentity>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    state: Mutex<EntryState>,
}

pub struct TerminalHost {
    entries: Mutex<HashMap<String, Arc<TerminalEntry>>>,
    control: Mutex<TerminalControlRegistry>,
    events: Arc<EventHub>,
    next_id: AtomicU64,
    cleanup_tx: tokio::sync::mpsc::UnboundedSender<(String, String)>,
    history: TerminalHistoryArchive,
    checkpoints: bool,
}

impl TerminalHost {
    pub fn new(
        events: Arc<EventHub>,
        history_root: &Path,
        checkpoints: bool,
    ) -> Result<Arc<Self>, TerminalError> {
        let (cleanup_tx, mut cleanup_rx) = tokio::sync::mpsc::unbounded_channel();
        let host = Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            control: Mutex::new(TerminalControlRegistry::new()),
            events,
            next_id: AtomicU64::new(0),
            cleanup_tx,
            history: TerminalHistoryArchive::open(history_root)?,
            checkpoints,
        });
        let weak = Arc::downgrade(&host);
        tokio::spawn(async move {
            while let Some((id, terminal_epoch)) = cleanup_rx.recv().await {
                let weak = weak.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(EXITED_DISPOSE_TTL).await;
                    let Some(host) = weak.upgrade() else { return };
                    let current_epoch = host.inspect(&id).map(|entry| entry.terminal_epoch);
                    if current_epoch.as_deref() == Some(&terminal_epoch) {
                        let _ = host.dispose(&id);
                    }
                });
            }
        });
        Ok(host)
    }

    pub fn create(
        self: &Arc<Self>,
        cwd: &Path,
        launch: Option<TerminalLaunch>,
    ) -> Result<TerminalCreateResult, TerminalError> {
        let cwd = cwd
            .canonicalize()
            .map_err(|error| TerminalError::Invalid(error.to_string()))?;
        if !cwd.is_dir() {
            return Err(TerminalError::Invalid("cwd is not a directory".to_owned()));
        }
        {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if entries.len() >= MAX_ENTRIES {
                let exited = entries
                    .iter()
                    .find(|(_, entry)| {
                        entry
                            .state
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .status
                            == TerminalProcessStatus::Exited
                    })
                    .map(|(id, _)| id.clone());
                if let Some(id) = exited {
                    entries.remove(&id);
                }
            }
            if entries.len() >= MAX_ENTRIES {
                return Err(TerminalError::Limit);
            }
        }
        let launch = launch.unwrap_or_default();
        let terminal_theme = launch.theme.unwrap_or_default();
        let cols = launch.cols.unwrap_or(80).clamp(1, 1000);
        let rows = launch.rows.unwrap_or(24).clamp(1, 1000);
        let command = launch.command.clone().unwrap_or_else(default_shell);
        let args = if launch.command.is_some() || !launch.args.is_empty() {
            launch.args.clone()
        } else {
            default_shell_args(&command)
        };
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| TerminalError::Runtime(error.to_string()))?;
        let mut builder = CommandBuilder::new(&command);
        builder.args(args);
        builder.cwd(&cwd);
        const SANITIZED_ENV: &[&str] = &[
            "TMUX",
            "TMUX_PANE",
            "STY",
            "WINDOW",
            "WINDOWID",
            "TERMCAP",
            "COLUMNS",
            "LINES",
            "NODE_OPTIONS",
            "NODE_PATH",
        ];
        for (key, value) in env::vars() {
            if !SANITIZED_ENV.contains(&key.as_str()) {
                builder.env(key, value);
            }
        }
        builder.env("TERM", "xterm-256color");
        builder.env("COLORTERM", "truecolor");
        for (key, value) in launch.env {
            builder.env(key, value);
        }
        let child = pair
            .slave
            .spawn_command(builder)
            .map_err(|error| TerminalError::Runtime(error.to_string()))?;
        drop(pair.slave);
        let os_pid = child.process_id();
        let process_identity = os_pid.and_then(capture_process_identity);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| TerminalError::Runtime(error.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| TerminalError::Runtime(error.to_string()))?;
        let id = format!(
            "term-{}-{}",
            jiff::Timestamp::now().as_millisecond(),
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        );
        let terminal_epoch = Uuid::new_v4().to_string();
        let title = launch
            .command
            .is_none()
            .then(|| Path::new(&command).file_name()?.to_str().map(str::to_owned))
            .flatten();
        let entry = Arc::new(TerminalEntry {
            id: id.clone(),
            title: title.clone(),
            terminal_epoch: terminal_epoch.clone(),
            spawn_command: launch.command,
            spawn_cwd: cwd,
            os_pid,
            process_identity: process_identity.clone(),
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            state: Mutex::new(EntryState {
                status: TerminalProcessStatus::Running,
                exit_code: None,
                signal: None,
                sequence: 0,
                replay: VecDeque::new(),
                replay_bytes: 0,
                replay_truncated: false,
                cols,
                rows,
                disposed: false,
                replay_ready_clients: HashSet::new(),
                query_leftover: Vec::new(),
                osc7_scanner: Osc7Scanner::default(),
                terminal_theme,
                theme_updates_enabled: false,
                live_cwd: None,
                recorder: self.checkpoints.then(|| vt100::Parser::new(rows, cols, 0)),
                checkpoint: None,
                bytes_since_checkpoint: 0,
                last_checkpoint_at: Instant::now(),
            }),
        });
        self.control
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .register_terminal(&id, &terminal_epoch)?;
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.clone(), Arc::clone(&entry));

        let (output_tx, output_rx) = mpsc::sync_channel(64);
        let weak = Arc::downgrade(self);
        let owner_entry = Arc::clone(&entry);
        thread::Builder::new()
            .name(format!("yaade-terminal-owner-{id}"))
            .stack_size(1024 * 1024)
            .spawn(move || output_loop(weak, owner_entry, output_rx))
            .map_err(|error| TerminalError::Runtime(error.to_string()))?;
        thread::Builder::new()
            .name(format!("yaade-pty-reader-{id}"))
            .stack_size(256 * 1024)
            .spawn(move || pty_reader_loop(output_tx, &mut reader))
            .map_err(|error| TerminalError::Runtime(error.to_string()))?;

        Ok(TerminalCreateResult {
            id,
            title,
            os_pid,
            process_identity,
            terminal_epoch,
        })
    }

    fn entry(&self, id: &str) -> Result<Arc<TerminalEntry>, TerminalError> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| TerminalError::NotFound(id.to_owned()))
    }

    #[must_use]
    pub fn inspect(&self, id: &str) -> Option<TerminalInspect> {
        let entry = self.entry(id).ok()?;
        let state = entry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Some(TerminalInspect {
            id: entry.id.clone(),
            title: entry.title.clone(),
            status: state.status,
            exit_code: state.exit_code,
            signal: state.signal,
            spawn_command: entry.spawn_command.clone(),
            spawn_cwd: entry.spawn_cwd.display().to_string(),
            os_pid: entry.os_pid,
            process_identity: entry.process_identity.clone(),
            terminal_epoch: entry.terminal_epoch.clone(),
        })
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), TerminalError> {
        if data.len() > MAX_WRITE_BYTES {
            return Err(TerminalError::Invalid(
                "terminal write exceeds 1 MiB".to_owned(),
            ));
        }
        let entry = self.entry(id)?;
        let mut writer = entry
            .writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        writer
            .write_all(data)
            .and_then(|()| writer.flush())
            .map_err(|error| TerminalError::Runtime(error.to_string()))
    }

    pub fn write_base64(&self, id: &str, encoded: &str) -> Result<(), TerminalError> {
        let data = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|error| TerminalError::Invalid(error.to_string()))?;
        self.write(id, &data)
    }

    pub fn set_theme(&self, id: &str, theme: TerminalTheme) -> Result<(), TerminalError> {
        let entry = self.entry(id)?;
        let mut state = entry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.terminal_theme == theme {
            return Ok(());
        }
        state.terminal_theme = theme;
        if state.theme_updates_enabled
            && let Ok(mut writer) = entry.writer.lock()
        {
            let _ = write_terminal_theme_preference(&mut **writer, theme);
            let _ = writer.flush();
        }
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), TerminalError> {
        let cols = cols.clamp(1, 1000);
        let rows = rows.clamp(1, 1000);
        let entry = self.entry(id)?;
        entry
            .master
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| TerminalError::Runtime(error.to_string()))?;
        let mut state = entry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.cols = cols;
        state.rows = rows;
        if state.recorder.is_some() {
            state
                .recorder
                .as_mut()
                .expect("recorder checked")
                .screen_mut()
                .set_size(rows, cols);
            store_checkpoint(&entry.terminal_epoch, &mut state);
        }
        Ok(())
    }

    pub fn attach(
        &self,
        id: &str,
        client_id: &str,
        after_sequence: u64,
    ) -> Result<TerminalAttach, TerminalError> {
        let entry = self.entry(id)?;
        let state = entry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let replay_floor = state
            .replay
            .front()
            .map_or(state.sequence + 1, |chunk| chunk.sequence);
        let checkpoint = state
            .checkpoint
            .as_ref()
            .filter(|checkpoint| state.replay_truncated && after_sequence < checkpoint.sequence)
            .cloned();
        let raw_after = checkpoint.as_ref().map_or(after_sequence, |checkpoint| {
            after_sequence.max(checkpoint.sequence)
        });
        let truncated =
            state.replay_truncated && checkpoint.is_none() && after_sequence + 1 < replay_floor;
        let mut output_chunks = state
            .replay
            .iter()
            .filter(|chunk| chunk.sequence > raw_after)
            .map(|chunk| Base64Bytes(chunk.data.clone()))
            .collect::<Vec<_>>();
        if self.history.available(id) && raw_after < state.sequence {
            output_chunks = bounded_replay_tail(output_chunks, EXITED_REPLAY_BYTES);
        }
        Ok(TerminalAttach {
            id: entry.id.clone(),
            title: entry.title.clone(),
            terminal_epoch: entry.terminal_epoch.clone(),
            replay_quality: if checkpoint.is_some() {
                "checkpoint"
            } else if truncated {
                "degraded"
            } else {
                "exact"
            },
            checkpoint,
            output_chunks,
            output: Base64Bytes(Bytes::new()),
            replay_truncated: state.replay_truncated && after_sequence + 1 < replay_floor,
            replay_needs_query_responses: !state.replay_ready_clients.contains(client_id),
            archive_available: true,
            last_sequence: state.sequence,
            cols: state.cols,
            rows: state.rows,
            status: state.status,
            exit_code: state.exit_code,
            signal: state.signal,
        })
    }

    pub fn read_replay_page(
        &self,
        id: &str,
        after_sequence: u64,
        max_bytes: Option<usize>,
    ) -> Result<Option<TerminalHistoryPage>, TerminalError> {
        self.entry(id)?;
        self.history
            .read_page(id, after_sequence, max_bytes)
            .map_err(Into::into)
    }

    pub fn mark_replay_ready(&self, id: &str, client_id: &str) -> Result<(), TerminalError> {
        let entry = self.entry(id)?;
        entry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .replay_ready_clients
            .insert(client_id.to_owned());
        Ok(())
    }

    pub fn detach(&self, id: &str, client_id: &str) -> Result<(), TerminalError> {
        let entry = self.entry(id)?;
        entry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .replay_ready_clients
            .remove(client_id);
        Ok(())
    }

    pub fn dispose(&self, id: &str) -> Result<(), TerminalError> {
        let entry = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .cloned()
            .ok_or_else(|| TerminalError::NotFound(id.to_owned()))?;
        {
            let mut state = entry
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.disposed = true;
        }
        self.control
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .unregister_terminal(id, Some(&entry.terminal_epoch));

        // The child handle remains registered until the OS accepts the kill
        // request. History compression and quota IO can never precede or
        // prevent process termination.
        let mut child = entry
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !matches!(child.try_wait(), Ok(Some(_))) {
            child
                .kill()
                .map_err(|error| TerminalError::Runtime(error.to_string()))?;
        }
        drop(child);
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id);
        if let Err(error) = self.history.close_terminal(id) {
            eprintln!("failed to enqueue terminal history finalization for {id}: {error}");
        }
        Ok(())
    }

    pub fn stop_all(&self) {
        let ids = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            let _ = self.dispose(&id);
        }
        let _ = self.history.flush_all();
    }

    pub fn get_cwd(&self, id: &str) -> Result<String, TerminalError> {
        let entry = self.entry(id)?;
        let cwd = entry
            .os_pid
            .and_then(process_cwd)
            .or_else(|| {
                entry
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .live_cwd
                    .clone()
            })
            .unwrap_or_else(|| entry.spawn_cwd.clone());
        url::Url::from_file_path(cwd)
            .map(String::from)
            .map_err(|()| TerminalError::Runtime("could not encode cwd URI".to_owned()))
    }

    pub fn get_foreground_process(&self, id: &str) -> Result<Option<String>, TerminalError> {
        let entry = self.entry(id)?;
        let Some(pid) = entry.os_pid else {
            return Ok(None);
        };
        Ok(foreground_process(pid).or_else(|| {
            entry
                .spawn_command
                .as_deref()
                .or_else(|| entry.title.as_deref())
                .and_then(|command| Path::new(command).file_name()?.to_str().map(str::to_owned))
        }))
    }

    pub fn acquire_lease(
        &self,
        id: &str,
        principal_id: &str,
        connection_id: &str,
        mode: TerminalLeaseMode,
    ) -> Result<RuntimeTerminalLease, TerminalError> {
        let entry = self.entry(id)?;
        self.control
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .acquire(TerminalLeaseRequest {
                terminal_id: id.to_owned(),
                terminal_epoch: entry.terminal_epoch.clone(),
                principal_id: principal_id.to_owned(),
                connection_id: connection_id.to_owned(),
                mode,
            })
            .map_err(Into::into)
    }

    pub fn renew_lease(
        &self,
        id: &str,
        lease_id: &str,
        principal_id: &str,
        connection_id: &str,
    ) -> Result<RuntimeTerminalLease, TerminalError> {
        let entry = self.entry(id)?;
        self.control
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .renew(
                id,
                &entry.terminal_epoch,
                lease_id,
                principal_id,
                connection_id,
            )
            .map_err(Into::into)
    }

    pub fn release_lease(
        &self,
        id: &str,
        lease_id: &str,
        principal_id: &str,
        connection_id: &str,
    ) -> Result<(), TerminalError> {
        let entry = self.entry(id)?;
        self.control
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .release(
                id,
                &entry.terminal_epoch,
                lease_id,
                principal_id,
                connection_id,
            )
            .map_err(Into::into)
    }

    pub fn takeover(
        &self,
        id: &str,
        principal_id: &str,
        connection_id: &str,
    ) -> Result<RuntimeTerminalLease, TerminalError> {
        let entry = self.entry(id)?;
        self.control
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .force_takeover(id, &entry.terminal_epoch, principal_id, connection_id)
            .map_err(Into::into)
    }

    pub fn transfer(
        &self,
        id: &str,
        lease_id: &str,
        principal_id: &str,
        connection_id: &str,
        target_connection_id: &str,
    ) -> Result<RuntimeTerminalLease, TerminalError> {
        let entry = self.entry(id)?;
        self.control
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .transfer(
                id,
                &entry.terminal_epoch,
                lease_id,
                principal_id,
                connection_id,
                principal_id,
                target_connection_id,
            )
            .map_err(Into::into)
    }

    pub fn list_leases(&self, id: &str) -> Result<Vec<RuntimeTerminalLease>, TerminalError> {
        self.entry(id)?;
        self.control
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .list(id)
            .map_err(Into::into)
    }

    #[must_use]
    pub fn list_all_leases(&self) -> Vec<RuntimeTerminalLease> {
        self.control
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .list_all()
    }

    pub fn release_connection(&self, connection_id: &str) {
        self.control
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .release_connection(connection_id);
    }

    pub fn authorize_or_acquire(
        &self,
        id: &str,
        principal_id: &str,
        connection_id: &str,
        supplied: Option<TerminalMutationFence>,
    ) -> Result<RuntimeTerminalLease, TerminalError> {
        if let Some(mut fence) = supplied {
            fence.principal_id = principal_id.to_owned();
            fence.connection_id = connection_id.to_owned();
            return self
                .control
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .authorize_mutation(&fence)
                .map_err(Into::into);
        }
        let existing = self.list_leases(id)?.into_iter().find(|lease| {
            lease.mode == TerminalLeaseMode::Writer
                && lease.principal_id == principal_id
                && lease.connection_id == connection_id
        });
        existing.map_or_else(
            || self.acquire_lease(id, principal_id, connection_id, TerminalLeaseMode::Writer),
            Ok,
        )
    }
}

fn pty_reader_loop(output: mpsc::SyncSender<Bytes>, reader: &mut Box<dyn Read + Send>) {
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                if output
                    .send(Bytes::copy_from_slice(&buffer[..read]))
                    .is_err()
                {
                    break;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

fn output_loop(host: Weak<TerminalHost>, entry: Arc<TerminalEntry>, output: mpsc::Receiver<Bytes>) {
    while let Ok(data) = output.recv() {
        let Some(host) = host.upgrade() else {
            return;
        };
        let mut state = entry
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.disposed {
            return;
        }
        state.sequence += 1;
        let sequence = state.sequence;
        state.replay.push_back(ReplayChunk {
            sequence,
            data: data.clone(),
        });
        state.replay_bytes = state.replay_bytes.saturating_add(data.len());
        while state.replay_bytes > MAX_REPLAY_BYTES && state.replay.len() > 1 {
            if let Some(dropped) = state.replay.pop_front() {
                state.replay_bytes = state.replay_bytes.saturating_sub(dropped.data.len());
                state.replay_truncated = true;
            }
        }
        let terminal_requests = feed_terminal_requests(&mut state.query_leftover, &data);
        let terminal_theme = state.terminal_theme;
        let mut terminal_queries = Vec::new();
        for request in terminal_requests {
            match request {
                TerminalRequest::Query(query) => {
                    terminal_queries.push((query, state.theme_updates_enabled));
                }
                TerminalRequest::SetThemeUpdates(enabled) => {
                    state.theme_updates_enabled = enabled;
                }
            }
        }
        if !terminal_queries.is_empty()
            && let Ok(mut writer) = entry.writer.lock()
        {
            for (query, theme_updates_enabled) in terminal_queries {
                let _ = write_terminal_query_response(
                    &mut **writer,
                    query,
                    terminal_theme,
                    theme_updates_enabled,
                );
            }
            let _ = writer.flush();
        }
        if let Some(cwd) = state.osc7_scanner.feed(&data) {
            state.live_cwd = Some(cwd.canonicalize().unwrap_or(cwd));
        }
        if let Some(recorder) = state.recorder.as_mut() {
            recorder.process(&data);
            state.bytes_since_checkpoint = state.bytes_since_checkpoint.saturating_add(data.len());
            if state.bytes_since_checkpoint >= CHECKPOINT_BYTES
                || state.last_checkpoint_at.elapsed() >= CHECKPOINT_INTERVAL
            {
                store_checkpoint(&entry.terminal_epoch, &mut state);
            }
        }
        drop(state);
        if let Err(error) = host.history.append(&entry.id, sequence, data.clone()) {
            eprintln!("[terminal-history] {error}");
        }
        host.events
            .emit_terminal(Arc::<str>::from(entry.id.as_str()), sequence, data);
    }
    let Some(host) = host.upgrade() else {
        return;
    };
    let exit = entry
        .child
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .wait();
    let (exit_code, signal) = exit.map_or((1, None), |status| {
        (
            i32::try_from(status.exit_code()).unwrap_or(1),
            status.signal().and_then(signal_number),
        )
    });
    let mut state = entry
        .state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if state.disposed {
        return;
    }
    state.status = TerminalProcessStatus::Exited;
    state.exit_code = Some(exit_code);
    if state.recorder.is_some() {
        store_checkpoint(&entry.terminal_epoch, &mut state);
    }
    state.signal = signal;
    while state.replay_bytes > EXITED_REPLAY_BYTES && state.replay.len() > 1 {
        if let Some(dropped) = state.replay.pop_front() {
            state.replay_bytes = state.replay_bytes.saturating_sub(dropped.data.len());
            state.replay_truncated = true;
        }
    }
    drop(state);
    let mut args = vec![json!(entry.id), json!(exit_code)];
    if let Some(signal) = signal {
        args.push(json!(signal));
    }
    host.events.emit("terminal:exit", args);
    if let Err(error) = host.history.close_terminal(&entry.id) {
        eprintln!("[terminal-history] {error}");
    }
    let _ = host
        .cleanup_tx
        .send((entry.id.clone(), entry.terminal_epoch.clone()));
}

fn store_checkpoint(terminal_epoch: &str, state: &mut EntryState) {
    let Some(recorder) = state.recorder.as_ref() else {
        return;
    };
    let screen = recorder.screen();
    let (row, column) = screen.cursor_position();
    let mut ansi = Vec::with_capacity(state.cols as usize * state.rows as usize + 64);
    ansi.extend_from_slice(b"\x1b[0m\x1b[2J\x1b[H");
    if screen.alternate_screen() {
        ansi.extend_from_slice(b"\x1b[?1049h");
    } else {
        ansi.extend_from_slice(b"\x1b[?1049l");
    }
    ansi.extend_from_slice(&screen.contents_formatted());
    ansi.extend_from_slice(format!("\x1b[{};{}H", row + 1, column + 1).as_bytes());
    state.checkpoint = Some(TerminalCheckpoint {
        checkpoint_version: 1,
        terminal_epoch: terminal_epoch.to_owned(),
        sequence: state.sequence,
        cols: state.cols,
        rows: state.rows,
        created_at: crate::model::now_iso(),
        synthetic_bytes: Base64Bytes(Bytes::from(ansi)),
    });
    state.bytes_since_checkpoint = 0;
    state.last_checkpoint_at = Instant::now();
}

fn bounded_replay_tail(chunks: Vec<Base64Bytes>, max_bytes: usize) -> Vec<Base64Bytes> {
    let mut total = 0_usize;
    let mut start = chunks.len();
    for (index, chunk) in chunks.iter().enumerate().rev() {
        if start < chunks.len() && total.saturating_add(chunk.0.len()) > max_bytes {
            break;
        }
        start = index;
        total = total.saturating_add(chunk.0.len());
    }
    chunks.into_iter().skip(start).collect()
}

const OSC7_PREFIX: &[u8] = b"\x1b]7;";
const MAX_OSC7_PAYLOAD_BYTES: usize = 4096;

#[derive(Default)]
struct Osc7Scanner {
    prefix_len: usize,
    payload: Vec<u8>,
    in_payload: bool,
    saw_escape: bool,
}

impl Osc7Scanner {
    fn feed(&mut self, chunk: &[u8]) -> Option<PathBuf> {
        let mut last = None;
        for &byte in chunk {
            if !self.in_payload {
                if byte == OSC7_PREFIX[self.prefix_len] {
                    self.prefix_len += 1;
                    if self.prefix_len == OSC7_PREFIX.len() {
                        self.prefix_len = 0;
                        self.in_payload = true;
                        self.payload.clear();
                    }
                } else {
                    self.prefix_len = usize::from(byte == OSC7_PREFIX[0]);
                }
                continue;
            }
            if self.saw_escape {
                self.saw_escape = false;
                if byte == b'\\' {
                    last = self.finish().or(last);
                    continue;
                }
                if self.payload.len() < MAX_OSC7_PAYLOAD_BYTES {
                    self.payload.push(0x1b);
                }
            }
            if byte == 0x07 {
                last = self.finish().or(last);
            } else if byte == 0x1b {
                self.saw_escape = true;
            } else if self.payload.len() < MAX_OSC7_PAYLOAD_BYTES {
                self.payload.push(byte);
            } else {
                self.reset();
            }
        }
        last
    }

    fn finish(&mut self) -> Option<PathBuf> {
        let path = std::str::from_utf8(&self.payload).ok().and_then(osc7_path);
        self.reset();
        path
    }

    fn reset(&mut self) {
        self.prefix_len = 0;
        self.payload.clear();
        self.in_payload = false;
        self.saw_escape = false;
    }
}

fn osc7_path(value: &str) -> Option<PathBuf> {
    let without_scheme = value.trim().strip_prefix("file://")?;
    let pathname = if without_scheme.starts_with('/') {
        without_scheme
    } else {
        let slash = without_scheme.find('/')?;
        &without_scheme[slash..]
    };
    let decoded = percent_encoding::percent_decode_str(pathname)
        .decode_utf8()
        .ok()?;
    (!decoded.is_empty()).then(|| PathBuf::from(decoded.as_ref()))
}

fn signal_number(signal: &str) -> Option<i32> {
    match signal.trim_start_matches("SIG") {
        "HUP" => Some(1),
        "INT" => Some(2),
        "QUIT" => Some(3),
        "KILL" => Some(9),
        "TERM" => Some(15),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TerminalQuery {
    PrimaryDeviceAttributes,
    OperatingStatus,
    ForegroundColor,
    BackgroundColor,
    CursorColor,
    ThemeUpdatesMode,
    ThemePreference,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TerminalRequest {
    Query(TerminalQuery),
    SetThemeUpdates(bool),
}

const fn terminal_query(query: TerminalQuery) -> TerminalRequest {
    TerminalRequest::Query(query)
}

// Neovim enables DEC mode 2031 after DECRQM reports support, then uses the
// unsolicited 997 DSR to re-query OSC colors when the terminal palette changes.
const TERMINAL_REQUEST_SEQUENCES: [(&[u8], TerminalRequest); 13] = [
    (
        b"\x1b[?2031$p",
        terminal_query(TerminalQuery::ThemeUpdatesMode),
    ),
    (
        b"\x1b[?996n",
        terminal_query(TerminalQuery::ThemePreference),
    ),
    (b"\x1b[?2031h", TerminalRequest::SetThemeUpdates(true)),
    (b"\x1b[?2031l", TerminalRequest::SetThemeUpdates(false)),
    (
        b"\x1b[0c",
        terminal_query(TerminalQuery::PrimaryDeviceAttributes),
    ),
    (
        b"\x1b[c",
        terminal_query(TerminalQuery::PrimaryDeviceAttributes),
    ),
    (b"\x1b[5n", terminal_query(TerminalQuery::OperatingStatus)),
    (
        b"\x1b]10;?\x07",
        terminal_query(TerminalQuery::ForegroundColor),
    ),
    (
        b"\x1b]10;?\x1b\\",
        terminal_query(TerminalQuery::ForegroundColor),
    ),
    (
        b"\x1b]11;?\x07",
        terminal_query(TerminalQuery::BackgroundColor),
    ),
    (
        b"\x1b]11;?\x1b\\",
        terminal_query(TerminalQuery::BackgroundColor),
    ),
    (b"\x1b]12;?\x07", terminal_query(TerminalQuery::CursorColor)),
    (
        b"\x1b]12;?\x1b\\",
        terminal_query(TerminalQuery::CursorColor),
    ),
];

fn feed_terminal_requests(leftover: &mut Vec<u8>, chunk: &[u8]) -> Vec<TerminalRequest> {
    let mut requests = Vec::new();
    for &byte in chunk {
        if leftover.is_empty() {
            if byte == 0x1b {
                leftover.push(byte);
            }
            continue;
        }
        leftover.push(byte);
        if let Some((_, request)) = TERMINAL_REQUEST_SEQUENCES
            .iter()
            .find(|(sequence, _)| *sequence == leftover.as_slice())
        {
            requests.push(*request);
            leftover.clear();
        } else if !TERMINAL_REQUEST_SEQUENCES
            .iter()
            .any(|(sequence, _)| sequence.starts_with(leftover))
        {
            let restart = byte == 0x1b;
            leftover.clear();
            if restart {
                leftover.push(byte);
            }
        }
    }
    requests
}

fn terminal_theme_preference(theme: TerminalTheme) -> u8 {
    let background = theme.background;
    let luma = u32::from(background.r) * 299
        + u32::from(background.g) * 587
        + u32::from(background.b) * 114;
    if luma >= 128_000 { 2 } else { 1 }
}

fn write_terminal_theme_preference<W: Write + ?Sized>(
    writer: &mut W,
    theme: TerminalTheme,
) -> std::io::Result<()> {
    write!(writer, "\x1b[?997;{}n", terminal_theme_preference(theme))
}

fn write_terminal_query_response<W: Write + ?Sized>(
    writer: &mut W,
    query: TerminalQuery,
    theme: TerminalTheme,
    theme_updates_enabled: bool,
) -> std::io::Result<()> {
    match query {
        TerminalQuery::PrimaryDeviceAttributes => {
            writer.write_all(b"\x1b[?64;1;2;6;9;15;18;21;22c")
        }
        TerminalQuery::OperatingStatus => writer.write_all(b"\x1b[0n"),
        TerminalQuery::ThemeUpdatesMode => write!(
            writer,
            "\x1b[?2031;{}$y",
            if theme_updates_enabled { 1 } else { 2 },
        ),
        TerminalQuery::ThemePreference => write_terminal_theme_preference(writer, theme),
        TerminalQuery::ForegroundColor
        | TerminalQuery::BackgroundColor
        | TerminalQuery::CursorColor => {
            let (selector, color) = match query {
                TerminalQuery::ForegroundColor => (10, theme.foreground),
                TerminalQuery::BackgroundColor => (11, theme.background),
                TerminalQuery::CursorColor => (12, theme.cursor),
                TerminalQuery::PrimaryDeviceAttributes
                | TerminalQuery::OperatingStatus
                | TerminalQuery::ThemeUpdatesMode
                | TerminalQuery::ThemePreference => unreachable!(),
            };
            write!(
                writer,
                "\x1b]{selector};rgb:{:04x}/{:04x}/{:04x}\x1b\\",
                u16::from(color.r) * 0x101,
                u16::from(color.g) * 0x101,
                u16::from(color.b) * 0x101,
            )
        }
    }
}

fn command_output(command: &str, args: &[&str]) -> Option<String> {
    let output = ProcessCommand::new(command).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!value.is_empty()).then_some(value)
}

pub(crate) fn capture_process_identity(pid: u32) -> Option<ProcessIdentity> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let delimiter = stat.rfind(") ")?;
        let fields = stat[delimiter + 2..].split_whitespace().collect::<Vec<_>>();
        let start_token = fields.get(19)?.to_string();
        let boot_id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let executable_path = std::fs::read_link(format!("/proc/{pid}/exe"))
            .ok()
            .map(|path| path.display().to_string());
        return Some(ProcessIdentity {
            pid,
            platform: "linux",
            boot_id,
            start_token,
            executable_path,
        });
    }
    #[cfg(target_os = "macos")]
    {
        let pid_text = pid.to_string();
        let start_token = command_output("ps", &["-p", &pid_text, "-o", "lstart="])?
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let executable_path = command_output("ps", &["-p", &pid_text, "-o", "comm="]);
        return Some(ProcessIdentity {
            pid,
            platform: "darwin",
            boot_id: None,
            start_token,
            executable_path,
        });
    }
    #[cfg(target_os = "windows")]
    {
        let start_token = command_output(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!("(Get-Process -Id {pid}).StartTime.ToUniversalTime().Ticks"),
            ],
        )?;
        let executable_path = command_output(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!("(Get-Process -Id {pid}).Path"),
            ],
        );
        return Some(ProcessIdentity {
            pid,
            platform: "windows",
            boot_id: None,
            start_token,
            executable_path,
        });
    }
    #[allow(unreachable_code)]
    None
}

fn foreground_pid(pid: u32) -> Option<u32> {
    #[cfg(unix)]
    {
        let pid_text = pid.to_string();
        return command_output("ps", &["-p", &pid_text, "-o", "tpgid="])?
            .trim()
            .parse::<u32>()
            .ok()
            .filter(|process_group| *process_group > 0);
    }
    #[allow(unreachable_code)]
    Some(pid)
}

fn process_cwd(pid: u32) -> Option<PathBuf> {
    let foreground = foreground_pid(pid).unwrap_or(pid);
    #[cfg(target_os = "linux")]
    {
        return std::fs::read_link(format!("/proc/{foreground}/cwd")).ok();
    }
    #[cfg(target_os = "macos")]
    {
        let pid = foreground.to_string();
        for executable in ["/usr/sbin/lsof", "/usr/bin/lsof", "lsof"] {
            if let Some(output) =
                command_output(executable, &["-a", "-d", "cwd", "-p", &pid, "-Fn"])
                && let Some(cwd) = output.lines().find_map(|line| line.strip_prefix('n'))
                && !cwd.is_empty()
            {
                return Some(PathBuf::from(cwd));
            }
        }
    }
    #[allow(unreachable_code)]
    None
}

fn foreground_process(pid: u32) -> Option<String> {
    #[cfg(unix)]
    {
        let process_group = foreground_pid(pid)?.to_string();
        let command = command_output("ps", &["-p", &process_group, "-o", "comm="])?;
        return Path::new(&command).file_name()?.to_str().map(str::to_owned);
    }
    #[allow(unreachable_code)]
    None
}

fn default_shell() -> String {
    env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(windows) {
            "powershell.exe".to_owned()
        } else {
            "/bin/zsh".to_owned()
        }
    })
}

fn default_shell_args(shell: &str) -> Vec<String> {
    let basename = Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(shell);
    if basename == "zsh" || basename == "bash" {
        vec!["-il".to_owned()]
    } else {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_query_scanner_handles_da1_queries_split_across_chunks() {
        let mut leftover = Vec::new();
        assert!(feed_terminal_requests(&mut leftover, b"before\x1b[").is_empty());
        assert_eq!(leftover, b"\x1b[");
        assert_eq!(
            feed_terminal_requests(&mut leftover, b"0cafter\x1b[c"),
            vec![
                terminal_query(TerminalQuery::PrimaryDeviceAttributes),
                terminal_query(TerminalQuery::PrimaryDeviceAttributes),
            ]
        );
        assert!(leftover.is_empty());
    }

    #[test]
    fn terminal_query_scanner_handles_color_and_status_queries() {
        let mut leftover = Vec::new();
        assert!(feed_terminal_requests(&mut leftover, b"before\x1b]11;").is_empty());
        assert_eq!(leftover, b"\x1b]11;");
        assert_eq!(
            feed_terminal_requests(&mut leftover, b"?\x07\x1b[5"),
            vec![terminal_query(TerminalQuery::BackgroundColor)]
        );
        assert_eq!(leftover, b"\x1b[5");
        assert_eq!(
            feed_terminal_requests(&mut leftover, b"n\x1b]10;?\x1b"),
            vec![terminal_query(TerminalQuery::OperatingStatus)]
        );
        assert_eq!(leftover, b"\x1b]10;?\x1b");
        assert_eq!(
            feed_terminal_requests(&mut leftover, b"\\\x1b]12;?\x07"),
            vec![
                terminal_query(TerminalQuery::ForegroundColor),
                terminal_query(TerminalQuery::CursorColor),
            ]
        );
        assert!(leftover.is_empty());
    }

    #[test]
    fn terminal_query_scanner_handles_theme_update_negotiation() {
        let mut leftover = Vec::new();
        assert!(feed_terminal_requests(&mut leftover, b"\x1b[?2031").is_empty());
        assert_eq!(leftover, b"\x1b[?2031");
        assert_eq!(
            feed_terminal_requests(&mut leftover, b"$p\x1b[?2031h\x1b[?996n\x1b[?2031l"),
            vec![
                terminal_query(TerminalQuery::ThemeUpdatesMode),
                TerminalRequest::SetThemeUpdates(true),
                terminal_query(TerminalQuery::ThemePreference),
                TerminalRequest::SetThemeUpdates(false),
            ]
        );
        assert!(leftover.is_empty());
    }

    #[test]
    fn terminal_query_responses_report_the_configured_theme() {
        let theme = TerminalTheme {
            foreground: TerminalColor { r: 1, g: 2, b: 3 },
            background: TerminalColor {
                r: 16,
                g: 32,
                b: 48,
            },
            cursor: TerminalColor {
                r: 254,
                g: 253,
                b: 252,
            },
        };
        let mut response = Vec::new();
        write_terminal_query_response(&mut response, TerminalQuery::BackgroundColor, theme, false)
            .expect("background response");
        write_terminal_query_response(&mut response, TerminalQuery::OperatingStatus, theme, false)
            .expect("status response");
        write_terminal_query_response(&mut response, TerminalQuery::ThemeUpdatesMode, theme, false)
            .expect("theme mode response");
        write_terminal_query_response(&mut response, TerminalQuery::ThemePreference, theme, false)
            .expect("theme preference response");
        assert_eq!(
            response,
            b"\x1b]11;rgb:1010/2020/3030\x1b\\\x1b[0n\x1b[?2031;2$y\x1b[?997;1n"
        );
    }

    #[test]
    fn terminal_bytes_are_not_decoded_or_joined_at_read_boundaries() {
        let first = Bytes::copy_from_slice(b"ok\xffdone\xe2");
        let second = Bytes::copy_from_slice(b"\x94\x80");
        assert_eq!(first.as_ref(), b"ok\xffdone\xe2");
        assert_eq!(second.as_ref(), b"\x94\x80");
    }

    #[test]
    fn osc7_scanner_uses_the_last_report_and_decodes_only_completed_payloads() {
        let value = b"\x1b]7;file://host/tmp/first\x07\x1b]7;file:///tmp/last%20dir\x1b\\";
        let mut scanner = Osc7Scanner::default();
        let mut last = None;
        for byte in value {
            last = scanner.feed(std::slice::from_ref(byte)).or(last);
        }
        assert_eq!(last, Some(PathBuf::from("/tmp/last dir")));
    }
}
