use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, MutexGuard, mpsc},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use bytes::Bytes;
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use serde::{Deserialize, Serialize, Serializer};
use thiserror::Error;

const DEFAULT_BLOCK_BYTES: usize = 512 * 1024;
const DEFAULT_PAGE_BYTES: usize = 256 * 1024;
const MAX_TERMINAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const CLOSED_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const ARCHIVE_VERSION: u8 = 2;
const BLOCK_MAGIC: &[u8; 8] = b"YAADEH02";
const BLOCK_HEADER_BYTES: usize = 16;
const RECORD_HEADER_BYTES: usize = 12;
const MAX_RECORD_BYTES: usize = 64 * 1024;
const MAX_BLOCK_RECORDS: usize = 1_000_000;
const INGEST_MAX_MESSAGES: usize = 1024;
const INGEST_MAX_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Base64Bytes(pub Bytes);

impl Serialize for Base64Bytes {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&STANDARD.encode(&self.0))
    }
}

#[derive(Clone, Debug)]
struct HistoryRecord {
    sequence: u64,
    data: Bytes,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveBlock {
    file: String,
    first_sequence: u64,
    last_sequence: u64,
    uncompressed_bytes: u64,
    stored_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveManifest {
    version: u8,
    terminal_id: String,
    created_at: u64,
    updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    closed_at: Option<u64>,
    blocks: Vec<ArchiveBlock>,
}

struct ArchiveState {
    dir: PathBuf,
    manifest: ArchiveManifest,
    pending: Vec<HistoryRecord>,
    pending_bytes: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHistoryPage {
    pub chunks: Vec<Base64Bytes>,
    pub first_sequence: u64,
    pub last_sequence: u64,
    pub next_sequence: u64,
    pub complete: bool,
}

#[derive(Debug, Error)]
pub enum HistoryError {
    #[error("terminal history failure: {0}")]
    Io(#[from] std::io::Error),
    #[error("terminal history failure: {0}")]
    Json(#[from] serde_json::Error),
    #[error("terminal history is corrupt: {0}")]
    Corrupt(String),
}

struct AppendCommand {
    terminal_id: String,
    sequence: u64,
    data: Bytes,
}

enum IngestCommand {
    Append(AppendCommand),
    Snapshot(mpsc::Sender<Result<(), String>>),
    Barrier(mpsc::Sender<Result<(), String>>),
    Shutdown(mpsc::Sender<Result<(), String>>),
}

enum FinalizeCommand {
    Close {
        terminal_id: String,
        through_sequence: u64,
    },
}

struct IngestBudget {
    bytes: Mutex<usize>,
    available: Condvar,
}

struct HistoryShared {
    root: PathBuf,
    block_bytes: usize,
    page_bytes: usize,
    states: Mutex<HashMap<String, ArchiveState>>,
    pending_closes: Mutex<HashSet<String>>,
    background_errors: Mutex<Vec<String>>,
    accepted_sequences: Mutex<HashMap<String, u64>>,
    budget: IngestBudget,
}

/// Durable block-compressed PTY history. Live appends stay synchronous on PTY
/// reader threads. Closed-history compression, manifests, and global quota
/// maintenance are serialized on a dedicated finalizer thread.
pub struct TerminalHistoryArchive {
    shared: Arc<HistoryShared>,
    ingest_tx: mpsc::SyncSender<IngestCommand>,
    finalize_tx: mpsc::Sender<FinalizeCommand>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

impl TerminalHistoryArchive {
    pub fn open(root: &Path) -> Result<Self, HistoryError> {
        Self::open_with_limits(root, DEFAULT_BLOCK_BYTES, DEFAULT_PAGE_BYTES, true)
    }

    #[cfg(test)]
    pub fn with_limits(
        root: &Path,
        block_bytes: usize,
        page_bytes: usize,
    ) -> Result<Self, HistoryError> {
        Self::open_with_limits(root, block_bytes.max(1), page_bytes.max(1), false)
    }

    fn open_with_limits(
        root: &Path,
        block_bytes: usize,
        page_bytes: usize,
        cleanup: bool,
    ) -> Result<Self, HistoryError> {
        fs::create_dir_all(root)?;
        let shared = Arc::new(HistoryShared {
            root: root.to_owned(),
            block_bytes,
            page_bytes,
            states: Mutex::new(HashMap::new()),
            pending_closes: Mutex::new(HashSet::new()),
            background_errors: Mutex::new(Vec::new()),
            accepted_sequences: Mutex::new(HashMap::new()),
            budget: IngestBudget {
                bytes: Mutex::new(0),
                available: Condvar::new(),
            },
        });
        if cleanup {
            shared.cleanup_expired()?;
        }
        let (ingest_tx, ingest_rx) = mpsc::sync_channel(INGEST_MAX_MESSAGES);
        let (finalize_tx, finalize_rx) = mpsc::channel();
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("yaade-history-owner".to_owned())
            .spawn(move || run_history_owner(&worker_shared, ingest_rx, finalize_rx))
            .map_err(HistoryError::Io)?;
        Ok(Self {
            shared,
            ingest_tx,
            finalize_tx,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub fn append(
        &self,
        terminal_id: &str,
        sequence: u64,
        data: Bytes,
    ) -> Result<(), HistoryError> {
        if sequence == 0 || data.is_empty() {
            return Ok(());
        }
        if data.len() > MAX_RECORD_BYTES {
            return Err(HistoryError::Corrupt(format!(
                "history record exceeds {MAX_RECORD_BYTES} bytes"
            )));
        }
        {
            let mut accepted = self
                .shared
                .accepted_sequences
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if self.shared.pending_closes().contains(terminal_id) {
                return Err(HistoryError::Corrupt(format!(
                    "append after close for {terminal_id}"
                )));
            }
            let previous = accepted.get(terminal_id).copied().unwrap_or(0);
            if sequence <= previous {
                return Err(HistoryError::Corrupt(format!(
                    "history sequence {sequence} does not follow {previous}"
                )));
            }
            accepted.insert(terminal_id.to_owned(), sequence);
        }
        self.shared.reserve_ingest_bytes(data.len());
        let bytes = data.len();
        if self
            .ingest_tx
            .send(IngestCommand::Append(AppendCommand {
                terminal_id: terminal_id.to_owned(),
                sequence,
                data,
            }))
            .is_err()
        {
            self.shared.release_ingest_bytes(bytes);
            return Err(HistoryError::Corrupt("history owner stopped".to_owned()));
        }
        Ok(())
    }

    pub fn read_page(
        &self,
        terminal_id: &str,
        after_sequence: u64,
        max_bytes: Option<usize>,
    ) -> Result<Option<TerminalHistoryPage>, HistoryError> {
        let (snapshot_tx, snapshot_rx) = mpsc::channel();
        self.ingest_tx
            .send(IngestCommand::Snapshot(snapshot_tx))
            .map_err(|_| HistoryError::Corrupt("history owner stopped".to_owned()))?;
        match snapshot_rx.recv() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(HistoryError::Corrupt(error)),
            Err(_) => return Err(HistoryError::Corrupt("history owner stopped".to_owned())),
        }
        let (dir, blocks, pending, newest) = {
            let mut states = self.shared.states();
            let dir = self.shared.terminal_dir(terminal_id);
            if !dir.exists() && !states.contains_key(terminal_id) {
                return Ok(None);
            }
            let state = self.shared.state_for(&mut states, terminal_id)?;
            let newest = state
                .pending
                .last()
                .map(|record| record.sequence)
                .or_else(|| {
                    state
                        .manifest
                        .blocks
                        .last()
                        .map(|block| block.last_sequence)
                })
                .unwrap_or(after_sequence);
            (
                state.dir.clone(),
                state.manifest.blocks.clone(),
                state.pending.clone(),
                newest,
            )
        };
        let limit = max_bytes
            .unwrap_or(self.shared.page_bytes)
            .clamp(1, self.shared.page_bytes);
        let mut chunks = Vec::new();
        let mut bytes = 0_usize;
        let mut first_sequence = 0_u64;
        let mut last_sequence = after_sequence;
        let mut selected = Vec::new();
        for block in &blocks {
            if block.last_sequence > after_sequence {
                selected.extend(read_block(&dir.join(&block.file))?);
            }
        }
        selected.extend(pending);
        for record in selected {
            if record.sequence <= after_sequence {
                continue;
            }
            let size = record.data.len();
            if !chunks.is_empty() && bytes.saturating_add(size) > limit {
                return Ok(Some(TerminalHistoryPage {
                    chunks,
                    first_sequence,
                    last_sequence,
                    next_sequence: last_sequence,
                    complete: false,
                }));
            }
            if first_sequence == 0 {
                first_sequence = record.sequence;
            }
            bytes = bytes.saturating_add(size);
            last_sequence = record.sequence;
            chunks.push(Base64Bytes(record.data));
        }
        Ok(Some(TerminalHistoryPage {
            chunks,
            first_sequence,
            last_sequence,
            next_sequence: last_sequence,
            complete: last_sequence >= newest,
        }))
    }

    /// Enqueue idempotent finalization. The PTY termination path never waits on
    /// compression, manifest IO, or archive-wide quota scans.
    pub fn close_terminal(&self, terminal_id: &str) -> Result<(), HistoryError> {
        {
            let mut pending = self.shared.pending_closes();
            if !pending.insert(terminal_id.to_owned()) {
                return Ok(());
            }
        }
        let through_sequence = self
            .shared
            .accepted_sequences
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(terminal_id)
            .copied()
            .unwrap_or(0);
        if self
            .finalize_tx
            .send(FinalizeCommand::Close {
                terminal_id: terminal_id.to_owned(),
                through_sequence,
            })
            .is_err()
        {
            self.shared.pending_closes().remove(terminal_id);
            return Err(HistoryError::Corrupt(
                "history finalizer stopped".to_owned(),
            ));
        }
        Ok(())
    }

    pub fn delete_terminal(&self, terminal_id: &str) -> Result<(), HistoryError> {
        self.shared.pending_closes().remove(terminal_id);
        self.shared.states().remove(terminal_id);
        let dir = self.shared.terminal_dir(terminal_id);
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
        Ok(())
    }

    /// Drain accepted close work, then flush live archives. Background failures
    /// are reported at this explicit shutdown/test barrier.
    pub fn flush_all(&self) -> Result<(), HistoryError> {
        let (tx, rx) = mpsc::channel();
        self.ingest_tx
            .send(IngestCommand::Barrier(tx))
            .map_err(|_| HistoryError::Corrupt("history owner stopped".to_owned()))?;
        match rx.recv() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(HistoryError::Corrupt(error)),
            Err(_) => {
                return Err(HistoryError::Corrupt(
                    "history finalizer stopped".to_owned(),
                ));
            }
        }
        self.shared.flush_live()
    }

    #[must_use]
    pub fn available(&self, terminal_id: &str) -> bool {
        self.shared.states().contains_key(terminal_id)
            || self
                .shared
                .terminal_dir(terminal_id)
                .join("index.json")
                .is_file()
    }
}

impl Drop for TerminalHistoryArchive {
    fn drop(&mut self) {
        let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        else {
            return;
        };
        let (tx, rx) = mpsc::channel();
        let _ = self.ingest_tx.send(IngestCommand::Shutdown(tx));
        let _ = rx.recv();
        let _ = worker.join();
    }
}

impl HistoryShared {
    fn reserve_ingest_bytes(&self, bytes: usize) {
        let mut used = self
            .budget
            .bytes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while used.saturating_add(bytes) > INGEST_MAX_BYTES {
            used = self
                .budget
                .available
                .wait(used)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        *used = used.saturating_add(bytes);
    }

    fn release_ingest_bytes(&self, bytes: usize) {
        let mut used = self
            .budget
            .bytes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *used = used.saturating_sub(bytes);
        drop(used);
        self.budget.available.notify_all();
    }

    fn append_owned(&self, command: AppendCommand) -> Result<(), HistoryError> {
        let mut states = self.states();
        let state = self.state_for(&mut states, &command.terminal_id)?;
        if state.manifest.closed_at.is_some() {
            return Err(HistoryError::Corrupt(format!(
                "append after completed close for {}",
                command.terminal_id
            )));
        }
        let last_sequence = state
            .pending
            .last()
            .map(|record| record.sequence)
            .or_else(|| {
                state
                    .manifest
                    .blocks
                    .last()
                    .map(|block| block.last_sequence)
            })
            .unwrap_or(0);
        if command.sequence <= last_sequence {
            return Err(HistoryError::Corrupt(format!(
                "history sequence {} does not follow {last_sequence}",
                command.sequence
            )));
        }
        state.pending_bytes = state.pending_bytes.saturating_add(command.data.len());
        state.pending.push(HistoryRecord {
            sequence: command.sequence,
            data: command.data,
        });
        state.manifest.updated_at = now_millis();
        if state.pending_bytes >= self.block_bytes {
            flush_state(state)?;
            enforce_terminal_quota(state)?;
        }
        Ok(())
    }

    fn written_sequence(&self, terminal_id: &str) -> u64 {
        self.states().get(terminal_id).map_or(0, |state| {
            state
                .pending
                .last()
                .map(|record| record.sequence)
                .or_else(|| {
                    state
                        .manifest
                        .blocks
                        .last()
                        .map(|block| block.last_sequence)
                })
                .unwrap_or(0)
        })
    }

    fn states(&self) -> MutexGuard<'_, HashMap<String, ArchiveState>> {
        self.states
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn pending_closes(&self) -> MutexGuard<'_, HashSet<String>> {
        self.pending_closes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn state_for<'a>(
        &self,
        states: &'a mut HashMap<String, ArchiveState>,
        terminal_id: &str,
    ) -> Result<&'a mut ArchiveState, HistoryError> {
        if !states.contains_key(terminal_id) {
            let dir = self.terminal_dir(terminal_id);
            fs::create_dir_all(&dir)?;
            let manifest = match read_manifest(&dir)? {
                Some(manifest) if manifest.version == ARCHIVE_VERSION => manifest,
                Some(_) => {
                    // Development history has no compatibility promise yet. An
                    // old lossy JSON archive is quarantined by resetting its
                    // terminal directory instead of pretending it is exact.
                    fs::remove_dir_all(&dir)?;
                    fs::create_dir_all(&dir)?;
                    new_manifest(terminal_id)
                }
                None => new_manifest(terminal_id),
            };
            if manifest.terminal_id != terminal_id {
                return Err(HistoryError::Corrupt(terminal_id.to_owned()));
            }
            states.insert(
                terminal_id.to_owned(),
                ArchiveState {
                    dir,
                    manifest,
                    pending: Vec::new(),
                    pending_bytes: 0,
                },
            );
        }
        states
            .get_mut(terminal_id)
            .ok_or_else(|| HistoryError::Corrupt(terminal_id.to_owned()))
    }

    fn finalize_terminal(&self, terminal_id: &str) -> Result<(), HistoryError> {
        let mut states = self.states();
        if let Some(state) = states.get_mut(terminal_id) {
            flush_state(state)?;
            enforce_terminal_quota(state)?;
            if state.manifest.closed_at.is_none() {
                state.manifest.closed_at = Some(now_millis());
                write_manifest(state)?;
            }
            states.remove(terminal_id);
            return Ok(());
        }
        let dir = self.terminal_dir(terminal_id);
        if let Some(mut manifest) = read_manifest(&dir)?
            && manifest.closed_at.is_none()
        {
            manifest.closed_at = Some(now_millis());
            write_manifest_value(&dir, &manifest)?;
        }
        Ok(())
    }

    fn flush_live(&self) -> Result<(), HistoryError> {
        let mut states = self.states();
        for state in states.values_mut() {
            flush_state(state)?;
            enforce_terminal_quota(state)?;
        }
        drop(states);
        self.enforce_total_quota()
    }

    fn terminal_dir(&self, terminal_id: &str) -> PathBuf {
        self.root
            .join(URL_SAFE_NO_PAD.encode(terminal_id.as_bytes()))
    }

    fn cleanup_expired(&self) -> Result<(), HistoryError> {
        let now = now_millis();
        for item in fs::read_dir(&self.root)? {
            let item = item?;
            if !item.file_type()?.is_dir() {
                continue;
            }
            let dir = item.path();
            let Some(mut manifest) = read_manifest(&dir)? else {
                fs::remove_dir_all(dir)?;
                continue;
            };
            match manifest.closed_at {
                None => {
                    manifest.closed_at = Some(now);
                    write_manifest_value(&dir, &manifest)?;
                }
                Some(closed)
                    if now.saturating_sub(closed) > CLOSED_RETENTION.as_millis() as u64 =>
                {
                    fs::remove_dir_all(dir)?;
                }
                Some(_) => {}
            }
        }
        self.enforce_total_quota()
    }

    fn enforce_total_quota(&self) -> Result<(), HistoryError> {
        let mut archives = Vec::new();
        let mut total = 0_u64;
        for item in fs::read_dir(&self.root)? {
            let item = item?;
            if !item.file_type()?.is_dir() {
                continue;
            }
            let dir = item.path();
            let Some(manifest) = read_manifest(&dir)? else {
                continue;
            };
            let bytes = manifest
                .blocks
                .iter()
                .map(|block| block.stored_bytes)
                .sum::<u64>();
            total = total.saturating_add(bytes);
            archives.push((manifest.updated_at, bytes, dir));
        }
        archives.sort_by_key(|(updated, _, _)| *updated);
        for (_, bytes, dir) in archives {
            if total <= MAX_TOTAL_BYTES {
                break;
            }
            if !self.states().values().any(|state| state.dir == dir) {
                fs::remove_dir_all(dir)?;
                total = total.saturating_sub(bytes);
            }
        }
        Ok(())
    }

    fn record_error(&self, error: &HistoryError) {
        eprintln!("{error}");
        self.background_errors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(error.to_string());
    }

    fn take_errors(&self) -> Result<(), String> {
        let mut errors = self
            .background_errors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if errors.is_empty() {
            Ok(())
        } else {
            Err(std::mem::take(&mut *errors).join("; "))
        }
    }
}

fn run_history_owner(
    shared: &HistoryShared,
    ingest: mpsc::Receiver<IngestCommand>,
    finalize: mpsc::Receiver<FinalizeCommand>,
) {
    let mut closes = Vec::<(String, u64)>::new();
    loop {
        while let Ok(FinalizeCommand::Close {
            terminal_id,
            through_sequence,
        }) = finalize.try_recv()
        {
            closes.push((terminal_id, through_sequence));
        }
        finalize_ready(shared, &mut closes);

        let command = match ingest.recv_timeout(std::time::Duration::from_millis(5)) {
            Ok(command) => command,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        match command {
            IngestCommand::Append(command) => {
                let bytes = command.data.len();
                if let Err(error) = shared.append_owned(command) {
                    shared.record_error(&error);
                }
                shared.release_ingest_bytes(bytes);
            }
            IngestCommand::Snapshot(sender) => {
                let _ = sender.send(shared.take_errors());
            }
            IngestCommand::Barrier(sender) => {
                while let Ok(FinalizeCommand::Close {
                    terminal_id,
                    through_sequence,
                }) = finalize.try_recv()
                {
                    closes.push((terminal_id, through_sequence));
                }
                finalize_ready(shared, &mut closes);
                if let Err(error) = shared.flush_live() {
                    shared.record_error(&error);
                }
                if let Err(error) = shared.enforce_total_quota() {
                    shared.record_error(&error);
                }
                let _ = sender.send(shared.take_errors());
            }
            IngestCommand::Shutdown(sender) => {
                while let Ok(FinalizeCommand::Close {
                    terminal_id,
                    through_sequence,
                }) = finalize.try_recv()
                {
                    closes.push((terminal_id, through_sequence));
                }
                finalize_ready(shared, &mut closes);
                if let Err(error) = shared.flush_live() {
                    shared.record_error(&error);
                }
                if let Err(error) = shared.enforce_total_quota() {
                    shared.record_error(&error);
                }
                let _ = sender.send(shared.take_errors());
                break;
            }
        }
    }
}

fn finalize_ready(shared: &HistoryShared, closes: &mut Vec<(String, u64)>) {
    let mut waiting = Vec::new();
    for (terminal_id, through_sequence) in closes.drain(..) {
        if shared.written_sequence(&terminal_id) < through_sequence {
            waiting.push((terminal_id, through_sequence));
            continue;
        }
        if let Err(error) = shared.finalize_terminal(&terminal_id) {
            shared.record_error(&error);
        }
        shared.pending_closes().remove(&terminal_id);
    }
    *closes = waiting;
}

fn flush_state(state: &mut ArchiveState) -> Result<(), HistoryError> {
    if state.pending.is_empty() {
        return Ok(());
    }
    let records = std::mem::take(&mut state.pending);
    let uncompressed_bytes = std::mem::take(&mut state.pending_bytes) as u64;
    let first_sequence = records.first().map_or(0, |record| record.sequence);
    let last_sequence = records
        .last()
        .map_or(first_sequence, |record| record.sequence);
    let file = format!("{first_sequence:012}-{last_sequence:012}.bin.gz");
    let encoded = encode_records(&records)?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(6));
    encoder.write_all(&encoded)?;
    let compressed = encoder.finish()?;
    let temporary = state.dir.join(format!("{file}.tmp"));
    fs::write(&temporary, &compressed)?;
    fs::rename(temporary, state.dir.join(&file))?;
    state.manifest.blocks.push(ArchiveBlock {
        file,
        first_sequence,
        last_sequence,
        uncompressed_bytes,
        stored_bytes: compressed.len() as u64,
    });
    state.manifest.updated_at = now_millis();
    write_manifest(state)
}

fn enforce_terminal_quota(state: &mut ArchiveState) -> Result<(), HistoryError> {
    let mut bytes = state
        .manifest
        .blocks
        .iter()
        .map(|block| block.stored_bytes)
        .sum::<u64>();
    while bytes > MAX_TERMINAL_BYTES && state.manifest.blocks.len() > 1 {
        let block = state.manifest.blocks.remove(0);
        bytes = bytes.saturating_sub(block.stored_bytes);
        let path = state.dir.join(block.file);
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    write_manifest(state)
}

fn encode_records(records: &[HistoryRecord]) -> Result<Vec<u8>, HistoryError> {
    if records.is_empty() || records.len() > MAX_BLOCK_RECORDS {
        return Err(HistoryError::Corrupt(
            "invalid history block record count".to_owned(),
        ));
    }
    let count = u32::try_from(records.len())
        .map_err(|_| HistoryError::Corrupt("history block record count overflow".to_owned()))?;
    let capacity = BLOCK_HEADER_BYTES.saturating_add(
        records
            .iter()
            .map(|record| RECORD_HEADER_BYTES.saturating_add(record.data.len()))
            .sum::<usize>(),
    );
    let mut encoded = Vec::with_capacity(capacity);
    encoded.extend_from_slice(BLOCK_MAGIC);
    encoded.push(ARCHIVE_VERSION);
    encoded.extend_from_slice(&[0_u8; 3]);
    encoded.extend_from_slice(&count.to_be_bytes());
    let mut previous = 0_u64;
    for record in records {
        if record.sequence == 0 || record.sequence <= previous {
            return Err(HistoryError::Corrupt(
                "non-increasing history sequence".to_owned(),
            ));
        }
        if record.data.is_empty() || record.data.len() > MAX_RECORD_BYTES {
            return Err(HistoryError::Corrupt(
                "invalid history payload length".to_owned(),
            ));
        }
        let length = u32::try_from(record.data.len())
            .map_err(|_| HistoryError::Corrupt("history payload length overflow".to_owned()))?;
        encoded.extend_from_slice(&record.sequence.to_be_bytes());
        encoded.extend_from_slice(&length.to_be_bytes());
        encoded.extend_from_slice(&record.data);
        previous = record.sequence;
    }
    Ok(encoded)
}

fn decode_records(encoded: &[u8]) -> Result<Vec<HistoryRecord>, HistoryError> {
    if encoded.len() < BLOCK_HEADER_BYTES || &encoded[..8] != BLOCK_MAGIC {
        return Err(HistoryError::Corrupt(
            "invalid history block header".to_owned(),
        ));
    }
    if encoded[8] != ARCHIVE_VERSION || encoded[9..12] != [0_u8; 3] {
        return Err(HistoryError::Corrupt(
            "unsupported history block version".to_owned(),
        ));
    }
    let count = u32::from_be_bytes(
        encoded[12..16]
            .try_into()
            .map_err(|_| HistoryError::Corrupt("truncated history count".to_owned()))?,
    ) as usize;
    if count == 0 || count > MAX_BLOCK_RECORDS {
        return Err(HistoryError::Corrupt(
            "invalid history block record count".to_owned(),
        ));
    }
    let mut cursor = BLOCK_HEADER_BYTES;
    let mut previous = 0_u64;
    let mut records = Vec::with_capacity(count);
    for _ in 0..count {
        let header_end = cursor.saturating_add(RECORD_HEADER_BYTES);
        if header_end > encoded.len() {
            return Err(HistoryError::Corrupt(
                "truncated history record header".to_owned(),
            ));
        }
        let sequence = u64::from_be_bytes(
            encoded[cursor..cursor + 8]
                .try_into()
                .map_err(|_| HistoryError::Corrupt("truncated history sequence".to_owned()))?,
        );
        let length = u32::from_be_bytes(
            encoded[cursor + 8..header_end]
                .try_into()
                .map_err(|_| HistoryError::Corrupt("truncated history length".to_owned()))?,
        ) as usize;
        if sequence == 0 || sequence <= previous || length == 0 || length > MAX_RECORD_BYTES {
            return Err(HistoryError::Corrupt("invalid history record".to_owned()));
        }
        cursor = header_end;
        let payload_end = cursor.saturating_add(length);
        if payload_end > encoded.len() {
            return Err(HistoryError::Corrupt(
                "truncated history payload".to_owned(),
            ));
        }
        records.push(HistoryRecord {
            sequence,
            data: Bytes::copy_from_slice(&encoded[cursor..payload_end]),
        });
        cursor = payload_end;
        previous = sequence;
    }
    if cursor != encoded.len() {
        return Err(HistoryError::Corrupt(
            "trailing history block bytes".to_owned(),
        ));
    }
    Ok(records)
}

fn read_block(path: &Path) -> Result<Vec<HistoryRecord>, HistoryError> {
    let mut decoder = GzDecoder::new(File::open(path)?);
    let mut encoded = Vec::new();
    decoder.read_to_end(&mut encoded)?;
    decode_records(&encoded)
}

fn new_manifest(terminal_id: &str) -> ArchiveManifest {
    ArchiveManifest {
        version: ARCHIVE_VERSION,
        terminal_id: terminal_id.to_owned(),
        created_at: now_millis(),
        updated_at: now_millis(),
        closed_at: None,
        blocks: Vec::new(),
    }
}

fn read_manifest(dir: &Path) -> Result<Option<ArchiveManifest>, HistoryError> {
    let path = dir.join("index.json");
    if !path.is_file() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice::<ArchiveManifest>(&fs::read(
        path,
    )?)?))
}

fn write_manifest(state: &ArchiveState) -> Result<(), HistoryError> {
    write_manifest_value(&state.dir, &state.manifest)
}

fn write_manifest_value(dir: &Path, manifest: &ArchiveManifest) -> Result<(), HistoryError> {
    let target = dir.join("index.json");
    let temporary = dir.join("index.json.tmp");
    fs::write(&temporary, serde_json::to_vec(manifest)?)?;
    fs::rename(temporary, target)?;
    Ok(())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let path = std::env::temp_dir().join(format!("yaade-history-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).expect("temp dir");
        path
    }

    #[test]
    fn durable_history_is_paged_by_sequence() {
        let root = temp_dir();
        let archive = TerminalHistoryArchive::with_limits(&root, 4, 5).expect("archive");
        archive
            .append("term-1", 1, Bytes::from_static(b"one"))
            .expect("append");
        archive
            .append("term-1", 2, Bytes::from_static(b"two"))
            .expect("append");
        archive
            .append("term-1", 3, Bytes::from_static(b"three"))
            .expect("append");
        let first = archive
            .read_page("term-1", 0, None)
            .expect("read")
            .expect("page");
        assert_eq!(first.chunks, vec![Base64Bytes(Bytes::from_static(b"one"))]);
        assert!(!first.complete);
        let second = archive
            .read_page("term-1", first.next_sequence, None)
            .expect("read")
            .expect("page");
        assert_eq!(second.chunks, vec![Base64Bytes(Bytes::from_static(b"two"))]);
        drop(archive);

        let reopened = TerminalHistoryArchive::with_limits(&root, 4, 5).expect("reopen");
        let final_page = reopened
            .read_page("term-1", second.next_sequence, None)
            .expect("read")
            .expect("page");
        assert_eq!(
            final_page.chunks,
            vec![Base64Bytes(Bytes::from_static(b"three"))]
        );
        assert!(final_page.complete);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn close_is_enqueued_and_barrier_drains_it() {
        let root = temp_dir();
        let archive = TerminalHistoryArchive::with_limits(&root, 1024, 1024).expect("archive");
        archive
            .append("term-1", 1, Bytes::from_static(b"pending"))
            .expect("append");
        archive.close_terminal("term-1").expect("enqueue close");
        assert!(
            archive
                .append("term-1", 2, Bytes::from_static(b"late"))
                .is_err()
        );
        archive.flush_all().expect("drain");
        let manifest = read_manifest(&archive.shared.terminal_dir("term-1"))
            .expect("manifest")
            .expect("closed manifest");
        assert!(manifest.closed_at.is_some());
        archive.close_terminal("term-1").expect("idempotent close");
        archive.flush_all().expect("second drain");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn binary_codec_preserves_invalid_bytes_and_rejects_corruption() {
        let records = vec![
            HistoryRecord {
                sequence: 1,
                data: Bytes::from_static(b"ok\xff"),
            },
            HistoryRecord {
                sequence: 2,
                data: Bytes::from_static(b"\xe2"),
            },
        ];
        let encoded = encode_records(&records).expect("encode");
        assert_eq!(
            decode_records(&encoded).expect("decode")[0].data.as_ref(),
            b"ok\xff"
        );
        assert!(decode_records(&encoded[..encoded.len() - 1]).is_err());
        let mut trailing = encoded.clone();
        trailing.push(0);
        assert!(decode_records(&trailing).is_err());
        let duplicate = vec![
            HistoryRecord {
                sequence: 1,
                data: Bytes::from_static(b"a"),
            },
            HistoryRecord {
                sequence: 1,
                data: Bytes::from_static(b"b"),
            },
        ];
        assert!(encode_records(&duplicate).is_err());
    }

    #[test]
    fn missing_history_returns_null() {
        let root = temp_dir();
        let archive = TerminalHistoryArchive::with_limits(&root, 4, 5).expect("archive");
        assert!(
            archive
                .read_page("missing", 0, None)
                .expect("read")
                .is_none()
        );
        fs::remove_dir_all(root).expect("cleanup");
    }
}
