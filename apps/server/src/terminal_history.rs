use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
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

/// Durable block-compressed PTY history. The interface is synchronous because
/// PTY append calls run on their dedicated reader threads; RPC callers execute
/// reads through Tokio's blocking pool.
pub struct TerminalHistoryArchive {
    root: PathBuf,
    block_bytes: usize,
    page_bytes: usize,
    states: Mutex<HashMap<String, ArchiveState>>,
}

impl TerminalHistoryArchive {
    pub fn open(root: &Path) -> Result<Self, HistoryError> {
        fs::create_dir_all(root)?;
        let archive = Self {
            root: root.to_owned(),
            block_bytes: DEFAULT_BLOCK_BYTES,
            page_bytes: DEFAULT_PAGE_BYTES,
            states: Mutex::new(HashMap::new()),
        };
        archive.cleanup_expired()?;
        Ok(archive)
    }

    #[cfg(test)]
    pub fn with_limits(
        root: &Path,
        block_bytes: usize,
        page_bytes: usize,
    ) -> Result<Self, HistoryError> {
        fs::create_dir_all(root)?;
        Ok(Self {
            root: root.to_owned(),
            block_bytes: block_bytes.max(1),
            page_bytes: page_bytes.max(1),
            states: Mutex::new(HashMap::new()),
        })
    }

    pub fn append(&self, terminal_id: &str, sequence: u64, data: &str) -> Result<(), HistoryError> {
        if sequence == 0 || data.is_empty() {
            return Ok(());
        }
        let mut states = self.states();
        let state = self.state_for(&mut states, terminal_id)?;
        state.pending_bytes = state.pending_bytes.saturating_add(data.len());
        state.pending.push(HistoryRecord {
            sequence,
            data: data.to_owned(),
        });
        state.manifest.updated_at = now_millis();
        if state.pending_bytes >= self.block_bytes {
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
        let mut states = self.states();
        let dir = self.terminal_dir(terminal_id);
        if !dir.exists() && !states.contains_key(terminal_id) {
            return Ok(None);
        }
        let state = self.state_for(&mut states, terminal_id)?;
        flush_state(state)?;
        let limit = max_bytes
            .unwrap_or(self.page_bytes)
            .clamp(1, self.page_bytes);
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

    pub fn close_terminal(&self, terminal_id: &str) -> Result<(), HistoryError> {
        let mut states = self.states();
        let state = self.state_for(&mut states, terminal_id)?;
        flush_state(state)?;
        state.manifest.closed_at = Some(now_millis());
        write_manifest(state)?;
        drop(states);
        self.enforce_total_quota()
    }

    pub fn delete_terminal(&self, terminal_id: &str) -> Result<(), HistoryError> {
        self.states().remove(terminal_id);
        let dir = self.terminal_dir(terminal_id);
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
        Ok(())
    }

    pub fn flush_all(&self) -> Result<(), HistoryError> {
        let mut states = self.states();
        for state in states.values_mut() {
            flush_state(state)?;
            enforce_terminal_quota(state)?;
        }
        drop(states);
        self.enforce_total_quota()
    }

    #[must_use]
    pub fn available(&self, terminal_id: &str) -> bool {
        self.states().contains_key(terminal_id)
            || self.terminal_dir(terminal_id).join("index.json").is_file()
    }

    fn states(&self) -> MutexGuard<'_, HashMap<String, ArchiveState>> {
        self.states
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
                    manifest: ArchiveManifest {
                        closed_at: None,
                        ..manifest
                    },
                    pending: Vec::new(),
                    pending_bytes: 0,
                },
            );
        }
        states
            .get_mut(terminal_id)
            .ok_or_else(|| HistoryError::Corrupt(terminal_id.to_owned()))
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
    let manifest = serde_json::from_slice::<ArchiveManifest>(&fs::read(path)?)?;
    Ok(Some(manifest))
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
