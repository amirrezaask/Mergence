use std::{borrow::Cow, path::PathBuf};

use anyhow::Result;
use gpui::{AssetSource, SharedString};

pub struct YaadeAssets {
    root: PathBuf,
}

impl YaadeAssets {
    pub fn bundled() -> Self {
        Self {
            root: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("assets"),
        }
    }
}

impl AssetSource for YaadeAssets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        std::fs::read(self.root.join(path))
            .map(|bytes| Some(Cow::Owned(bytes)))
            .map_err(Into::into)
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        std::fs::read_dir(self.root.join(path))?
            .map(|entry| {
                entry
                    .and_then(|entry| {
                        entry.file_name().into_string().map_err(|_| {
                            std::io::Error::new(std::io::ErrorKind::InvalidData, "non-UTF-8 asset")
                        })
                    })
                    .map(SharedString::from)
                    .map_err(Into::into)
            })
            .collect()
    }
}
