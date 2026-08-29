use std::{
    collections::{HashMap, HashSet, VecDeque},
    env,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command as ProcessCommand,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicU64, Ordering},
    },
    thread,
};

use base64::Engine as _;
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
    wire::{TerminalLeaseMode, TerminalMutationFence},
};

const MAX_ENTRIES: usize = 64;
const MAX_REPLAY_BYTES: usize = 2 * 1024 * 1024;
const EXITED_REPLAY_BYTES: usize = 256 * 1024;
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const EXITED_DISPOSE_TTL: std::time::Duration = std::time::Duration::from_secs(90);

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
    pub protocol_version: u8,
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
    pub protocol_version: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalProcessStatus {
    Running,
    Exited,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttach {
    pub id: String,
    pub title: Option<String>,
    pub terminal_epoch: String,
    pub protocol_version: u8,
    pub replay_quality: &'static str,
    pub output_chunks: Vec<String>,
    pub output: String,
    pub replay_truncated: bool,
    pub replay_needs_query_responses: bool,
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
}

impl TerminalError {
    #[must_use]
    pub const fn wire_code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "NOT_FOUND",
            Self::Limit | Self::Invalid(_) | Self::Runtime(_) => "OPERATION_FAILED",
            Self::Control(error) => error.code.as_wire_code(),
        }
    }
}

#[derive(Clone)]
struct ReplayChunk {
    sequence: u64,
    data: String,
    bytes: usize,
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
    da1_leftover: String,
    live_cwd: Option<PathBuf>,
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
}

impl TerminalHost {
    #[must_use]
    pub fn new(events: Arc<EventHub>) -> Arc<Self> {
        let (cleanup_tx, mut cleanup_rx) = tokio::sync::mpsc::unbounded_channel();
        let host = Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            control: Mutex::new(TerminalControlRegistry::new()),
            events,
            next_id: AtomicU64::new(0),
            cleanup_tx,
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
        host
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
        let cols = launch.cols.unwrap_or(80).clamp(1, 1000);
        let rows = launch.rows.unwrap_or(24).clamp(1, 1000);
        let command = launch.command.clone().unwrap_or_else(default_shell);
        let args = if launch.command.is_some() {
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
                da1_leftover: String::new(),
                live_cwd: None,
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

        let weak = Arc::downgrade(self);
        let thread_name = format!("yaade-pty-{id}");
        thread::Builder::new()
            .name(thread_name)
            .stack_size(256 * 1024)
            .spawn(move || output_loop(weak, entry, &mut reader))
            .map_err(|error| TerminalError::Runtime(error.to_string()))?;

        Ok(TerminalCreateResult {
            id,
            title,
            os_pid,
            process_identity,
            terminal_epoch,
            protocol_version: 2,
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
            protocol_version: 2,
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
        let truncated = state.replay_truncated && after_sequence + 1 < replay_floor;
        Ok(TerminalAttach {
            id: entry.id.clone(),
            title: entry.title.clone(),
            terminal_epoch: entry.terminal_epoch.clone(),
            protocol_version: 2,
            replay_quality: if truncated { "degraded" } else { "exact" },
            output_chunks: state
                .replay
                .iter()
                .filter(|chunk| chunk.sequence > after_sequence)
                .map(|chunk| chunk.data.clone())
                .collect(),
            output: String::new(),
            replay_truncated: truncated,
            replay_needs_query_responses: !state.replay_ready_clients.contains(client_id),
            last_sequence: state.sequence,
            cols: state.cols,
            rows: state.rows,
            status: state.status,
            exit_code: state.exit_code,
            signal: state.signal,
        })
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
            .remove(id)
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
        entry
            .child
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .kill()
            .map_err(|error| TerminalError::Runtime(error.to_string()))
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

fn output_loop(
    host: Weak<TerminalHost>,
    entry: Arc<TerminalEntry>,
    reader: &mut Box<dyn Read + Send>,
) {
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                let Some(host) = host.upgrade() else {
                    return;
                };
                let data = String::from_utf8_lossy(&buffer[..read]).into_owned();
                let mut state = entry
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if state.disposed {
                    return;
                }
                state.sequence += 1;
                let sequence = state.sequence;
                let bytes = data.len();
                state.replay.push_back(ReplayChunk {
                    sequence,
                    data: data.clone(),
                    bytes,
                });
                state.replay_bytes += bytes;
                while state.replay_bytes > MAX_REPLAY_BYTES && state.replay.len() > 1 {
                    if let Some(dropped) = state.replay.pop_front() {
                        state.replay_bytes = state.replay_bytes.saturating_sub(dropped.bytes);
                        state.replay_truncated = true;
                    }
                }
                let da1_queries = feed_da1_queries(&mut state.da1_leftover, &data);
                if let Some(cwd) = parse_osc7_cwd(&data) {
                    state.live_cwd = Some(cwd.canonicalize().unwrap_or(cwd));
                }
                drop(state);
                if da1_queries > 0
                    && let Ok(mut writer) = entry.writer.lock()
                {
                    for _ in 0..da1_queries {
                        let _ = writer.write_all(b"\x1b[?64;1;2;6;9;15;18;21;22c");
                    }
                    let _ = writer.flush();
                }
                host.events.emit(
                    "terminal:data",
                    vec![json!(entry.id), json!(data), json!(sequence)],
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
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
    state.signal = signal;
    while state.replay_bytes > EXITED_REPLAY_BYTES && state.replay.len() > 1 {
        if let Some(dropped) = state.replay.pop_front() {
            state.replay_bytes = state.replay_bytes.saturating_sub(dropped.bytes);
            state.replay_truncated = true;
        }
    }
    drop(state);
    let mut args = vec![json!(entry.id), json!(exit_code)];
    if let Some(signal) = signal {
        args.push(json!(signal));
    }
    host.events.emit("terminal:exit", args);
    let _ = host
        .cleanup_tx
        .send((entry.id.clone(), entry.terminal_epoch.clone()));
}

fn parse_osc7_cwd(chunk: &str) -> Option<PathBuf> {
    let mut remaining = chunk;
    let mut last = None;
    while let Some(start) = remaining.find("\u{1b}]7;") {
        let payload = &remaining[start + 4..];
        let bel = payload.find('\u{7}');
        let st = payload.find("\u{1b}\\");
        let end = match (bel, st) {
            (Some(left), Some(right)) => left.min(right),
            (Some(end), None) | (None, Some(end)) => end,
            (None, None) => break,
        };
        let value = payload[..end].trim();
        if let Some(without_scheme) = value.strip_prefix("file://") {
            let pathname = if without_scheme.starts_with('/') {
                Some(without_scheme)
            } else {
                without_scheme
                    .find('/')
                    .map(|slash| &without_scheme[slash..])
            };
            if let Some(pathname) = pathname
                && let Ok(decoded) = percent_encoding::percent_decode_str(pathname).decode_utf8()
                && !decoded.is_empty()
            {
                last = Some(PathBuf::from(decoded.as_ref()));
            }
        }
        remaining = &payload[end + if st == Some(end) { 2 } else { 1 }..];
    }
    last
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

fn feed_da1_queries(leftover: &mut String, chunk: &str) -> usize {
    let data = std::mem::take(leftover) + chunk;
    let mut queries = 0;
    let mut cursor = 0;
    while let Some(offset) = data[cursor..].find('\u{1b}') {
        let escape = cursor + offset;
        let rest = &data[escape..];
        if matches!(rest, "\u{1b}" | "\u{1b}[" | "\u{1b}[0") {
            *leftover = rest.to_owned();
            break;
        }
        if rest.starts_with("\u{1b}[c") {
            queries += 1;
            cursor = escape + 3;
        } else if rest.starts_with("\u{1b}[0c") {
            queries += 1;
            cursor = escape + 4;
        } else {
            cursor = escape + 1;
        }
        if cursor >= data.len() {
            break;
        }
    }
    queries
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
    fn da1_scanner_handles_queries_split_across_chunks() {
        let mut leftover = String::new();
        assert_eq!(feed_da1_queries(&mut leftover, "before\u{1b}["), 0);
        assert_eq!(leftover, "\u{1b}[");
        assert_eq!(feed_da1_queries(&mut leftover, "0cafter\u{1b}[c"), 2);
        assert!(leftover.is_empty());
    }

    #[test]
    fn osc7_parser_uses_the_last_report_and_decodes_paths() {
        let value = "\u{1b}]7;file://host/tmp/first\u{7}\u{1b}]7;file:///tmp/last%20dir\u{1b}\\";
        assert_eq!(parse_osc7_cwd(value), Some(PathBuf::from("/tmp/last dir")));
    }
}
