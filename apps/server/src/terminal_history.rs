use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, mpsc},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use serde::{Deserialize, Serialize};
use thiserror::Error;

const DEFAULT_BLOCK_BYTES: usize = 512 * 1024;
const DEFAULT_PAGE_BYTES: usize = 256 * 1024;
const MAX_TERMINAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const CLOSED_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryRecord {
    sequence: u64,
    data: String,
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
    pub chunks: Vec<String>,
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

enum FinalizeCommand {
    Close(String),
    Barrier(mpsc::Sender<Result<(), String>>),
    Shutdown(mpsc::Sender<Result<(), String>>),
}

struct HistoryShared {
    root: PathBuf,
    block_bytes: usize,
    page_bytes: usize,
    states: Mutex<HashMap<String, ArchiveState>>,
    pending_closes: Mutex<HashSet<String>>,
    background_errors: Mutex<Vec<String>>,
}

/// Durable block-compressed PTY history. Live appends stay synchronous on PTY
/// reader threads. Closed-history compression, manifests, and global quota
/// maintenance are serialized on a dedicated finalizer thread.
pub struct TerminalHistoryArchive {
    shared: Arc<HistoryShared>,
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
        });
        if cleanup {
            shared.cleanup_expired()?;
        }
        let (finalize_tx, finalize_rx) = mpsc::channel();
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("yaade-history-finalizer".to_owned())
            .spawn(move || run_finalizer(&worker_shared, finalize_rx))
            .map_err(HistoryError::Io)?;
        Ok(Self {
            shared,
            finalize_tx,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub fn append(&self, terminal_id: &str, sequence: u64, data: &str) -> Result<(), HistoryError> {
        if sequence == 0 || data.is_empty() {
            return Ok(());
        }
        if self.shared.pending_closes().contains(terminal_id) {
            return Err(HistoryError::Corrupt(format!(
                "append after close for {terminal_id}"
            )));
        }
        let mut states = self.shared.states();
        let state = self.shared.state_for(&mut states, terminal_id)?;
        if state.manifest.closed_at.is_some() {
            return Err(HistoryError::Corrupt(format!(
                "append after completed close for {terminal_id}"
            )));
        }
        state.pending_bytes = state.pending_bytes.saturating_add(data.len());
        state.pending.push(HistoryRecord {
            sequence,
            data: data.to_owned(),
        });
        state.manifest.updated_at = now_millis();
        if state.pending_bytes >= self.shared.block_bytes {
            flush_state(state)?;
            enforce_terminal_quota(state)?;
        }
        Ok(())
    }

    pub fn read_page(
        &self,
        terminal_id: &str,
        after_sequence: u64,
        max_bytes: Option<usize>,
    ) -> Result<Option<TerminalHistoryPage>, HistoryError> {
        let mut states = self.shared.states();
        let dir = self.shared.terminal_dir(terminal_id);
        if !dir.exists() && !states.contains_key(terminal_id) {
            return Ok(None);
        }
        let state = self.shared.state_for(&mut states, terminal_id)?;
        flush_state(state)?;
        let limit = max_bytes
            .unwrap_or(self.shared.page_bytes)
            .clamp(1, self.shared.page_bytes);
        let mut chunks = Vec::new();
        let mut bytes = 0_usize;
        let mut first_sequence = 0_u64;
        let mut last_sequence = after_sequence;
        for block in &state.manifest.blocks {
            if block.last_sequence <= after_sequence {
                continue;
            }
            let records = read_block(&state.dir.join(&block.file))?;
            for record in records {
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
                chunks.push(record.data);
            }
        }
        let newest = state
            .manifest
            .blocks
            .last()
            .map_or(after_sequence, |block| block.last_sequence);
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
        if self
            .finalize_tx
            .send(FinalizeCommand::Close(terminal_id.to_owned()))
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
        self.finalize_tx
            .send(FinalizeCommand::Barrier(tx))
            .map_err(|_| HistoryError::Corrupt("history finalizer stopped".to_owned()))?;
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
        let _ = self.finalize_tx.send(FinalizeCommand::Shutdown(tx));
        let _ = rx.recv();
        let _ = worker.join();
    }
}

impl HistoryShared {
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
            let manifest = read_manifest(&dir)?.unwrap_or_else(|| ArchiveManifest {
                version: 1,
                terminal_id: terminal_id.to_owned(),
                created_at: now_millis(),
                updated_at: now_millis(),
                closed_at: None,
                blocks: Vec::new(),
            });
            if manifest.version != 1 || manifest.terminal_id != terminal_id {
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

fn run_finalizer(shared: &HistoryShared, receiver: mpsc::Receiver<FinalizeCommand>) {
    while let Ok(command) = receiver.recv() {
        let mut closes = Vec::new();
        let mut barriers = Vec::new();
        let mut shutdown = false;
        match command {
            FinalizeCommand::Close(id) => closes.push(id),
            FinalizeCommand::Barrier(sender) => barriers.push(sender),
            FinalizeCommand::Shutdown(sender) => {
                barriers.push(sender);
                shutdown = true;
            }
        }
        while let Ok(command) = receiver.try_recv() {
            match command {
                FinalizeCommand::Close(id) => closes.push(id),
                FinalizeCommand::Barrier(sender) => barriers.push(sender),
                FinalizeCommand::Shutdown(sender) => {
                    barriers.push(sender);
                    shutdown = true;
                }
            }
        }
        for id in closes {
            if let Err(error) = shared.finalize_terminal(&id) {
                shared.record_error(&error);
            }
            shared.pending_closes().remove(&id);
        }
        if let Err(error) = shared.enforce_total_quota() {
            shared.record_error(&error);
        }
        if !barriers.is_empty() {
            let result = shared.take_errors();
            for sender in barriers {
                let _ = sender.send(result.clone());
            }
        }
        if shutdown {
            break;
        }
    }
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
    let file = format!("{first_sequence:012}-{last_sequence:012}.json.gz");
    let encoded = serde_json::to_vec(&records)?;
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

fn read_block(path: &Path) -> Result<Vec<HistoryRecord>, HistoryError> {
    let mut decoder = GzDecoder::new(File::open(path)?);
    let mut encoded = Vec::new();
    decoder.read_to_end(&mut encoded)?;
    Ok(serde_json::from_slice(&encoded)?)
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
        archive.append("term-1", 1, "one").expect("append");
        archive.append("term-1", 2, "two").expect("append");
        archive.append("term-1", 3, "three").expect("append");
        let first = archive
            .read_page("term-1", 0, None)
            .expect("read")
            .expect("page");
        assert_eq!(first.chunks, vec!["one"]);
        assert!(!first.complete);
        let second = archive
            .read_page("term-1", first.next_sequence, None)
            .expect("read")
            .expect("page");
        assert_eq!(second.chunks, vec!["two"]);
        drop(archive);

        let reopened = TerminalHistoryArchive::with_limits(&root, 4, 5).expect("reopen");
        let final_page = reopened
            .read_page("term-1", second.next_sequence, None)
            .expect("read")
            .expect("page");
        assert_eq!(final_page.chunks, vec!["three"]);
        assert!(final_page.complete);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn close_is_enqueued_and_barrier_drains_it() {
        let root = temp_dir();
        let archive = TerminalHistoryArchive::with_limits(&root, 1024, 1024).expect("archive");
        archive.append("term-1", 1, "pending").expect("append");
        archive.close_terminal("term-1").expect("enqueue close");
        assert!(archive.append("term-1", 2, "late").is_err());
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
