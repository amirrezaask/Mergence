use std::{
    path::Path,
    sync::{Arc, mpsc},
    thread,
    time::Duration,
};

use rusqlite::Connection;
use thiserror::Error;

const QUEUE_CAPACITY: usize = 64;
const BUSY_TIMEOUT: Duration = Duration::from_secs(8);

type Job = Box<dyn FnOnce(&mut Connection) + Send + 'static>;

#[derive(Debug, Error)]
pub enum DatabaseError {
    #[error("database worker stopped")]
    Stopped,
    #[error("database failure: {0}")]
    Sql(#[from] rusqlite::Error),
}

/// A bounded, dedicated SQLite owner. The `Connection` never crosses this
/// module's seam and all operations execute in FIFO order on one worker.
#[derive(Clone)]
pub struct DatabaseOwner {
    sender: mpsc::SyncSender<Job>,
}

impl DatabaseOwner {
    pub fn open(path: &Path) -> Result<Self, DatabaseError> {
        let mut connection = Connection::open(path)?;
        connection.busy_timeout(BUSY_TIMEOUT)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let quick_check: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if quick_check != "ok" {
            return Err(DatabaseError::Sql(rusqlite::Error::InvalidQuery));
        }
        let (sender, receiver) = mpsc::sync_channel::<Job>(QUEUE_CAPACITY);
        thread::Builder::new()
            .name("yaade-sqlite".to_owned())
            .stack_size(512 * 1024)
            .spawn(move || {
                while let Ok(job) = receiver.recv() {
                    job(&mut connection);
                }
            })
            .map_err(|_| DatabaseError::Stopped)?;
        Ok(Self { sender })
    }

    pub fn call<T, F>(&self, operation: F) -> Result<T, DatabaseError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> rusqlite::Result<T> + Send + 'static,
    {
        let (result_sender, result_receiver) = mpsc::sync_channel(1);
        self.sender
            .send(Box::new(move |connection| {
                let _ = result_sender.send(operation(connection));
            }))
            .map_err(|_| DatabaseError::Stopped)?;
        result_receiver
            .recv()
            .map_err(|_| DatabaseError::Stopped)?
            .map_err(Into::into)
    }

    pub fn apply_migration(&self, name: &str, sql: &str) -> Result<bool, DatabaseError> {
        let name = name.to_owned();
        let sql = sql.to_owned();
        self.call(move |connection| {
            connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS schema_migrations(
                    name TEXT PRIMARY KEY,
                    applied_at TEXT NOT NULL
                );",
            )?;
            let exists = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name=?)",
                [&name],
                |row| row.get::<_, bool>(0),
            )?;
            if exists {
                return Ok(false);
            }
            let transaction = connection.transaction()?;
            transaction.execute_batch(&sql)?;
            transaction.execute(
                "INSERT INTO schema_migrations(name,applied_at) VALUES(?,?)",
                rusqlite::params![name, crate::model::now_iso()],
            )?;
            transaction.commit()?;
            Ok(true)
        })
    }

    #[cfg(test)]
    fn queue_capacity() -> usize { QUEUE_CAPACITY }
}

impl From<Arc<DatabaseOwner>> for DatabaseOwner {
    fn from(owner: Arc<DatabaseOwner>) -> Self {
        (*owner).clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_migrations_apply_once_and_failed_transactions_roll_back() {
        let dir = tempfile::tempdir().expect("temp dir");
        let owner = DatabaseOwner::open(&dir.path().join("db.sqlite3")).expect("owner");
        assert!(owner.apply_migration("one", "CREATE TABLE sample(value TEXT);").expect("migration"));
        assert!(!owner.apply_migration("one", "CREATE TABLE ignored(value TEXT);").expect("once"));
        assert!(owner.apply_migration("broken", "CREATE TABLE transient(value TEXT); INVALID SQL;").is_err());
        let transient = owner.call(|database| {
            database.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='transient')",
                [],
                |row| row.get::<_, bool>(0),
            )
        }).expect("query");
        assert!(!transient);
        assert_eq!(DatabaseOwner::queue_capacity(), 64);
    }

    #[test]
    fn operations_execute_in_fifo_order() {
        let owner = DatabaseOwner::open(Path::new(":memory:")).expect("owner");
        owner.call(|db| db.execute_batch("CREATE TABLE values_table(value INTEGER);")).expect("schema");
        for value in 0..100 {
            owner.call(move |db| db.execute("INSERT INTO values_table(value) VALUES(?)", [value])).expect("insert");
        }
        let values = owner.call(|db| {
            let mut statement = db.prepare("SELECT value FROM values_table ORDER BY rowid")?;
            statement.query_map([], |row| row.get::<_, i64>(0))?.collect::<rusqlite::Result<Vec<_>>>()
        }).expect("values");
        assert_eq!(values, (0..100).collect::<Vec<_>>());
    }
}
