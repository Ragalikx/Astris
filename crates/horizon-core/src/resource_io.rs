//! Platform boundary for prepared resources. Decoders keep their existing Read/Seek API.
//! Browser startup mounts downloaded bytes before the original resource loaders run.
#[cfg(not(target_family = "wasm"))]
pub use std::fs::*;

#[cfg(not(target_family = "wasm"))]
pub fn is_dir(path: impl AsRef<std::path::Path>) -> bool {
    path.as_ref().is_dir()
}

#[cfg(any(target_family = "wasm", test))]
pub mod mounted {
    use std::{
        collections::BTreeMap,
        io,
        path::{Component, Path, PathBuf},
        sync::{Arc, OnceLock, RwLock, RwLockReadGuard, RwLockWriteGuard, TryLockError},
    };

    const LIMIT: usize = 256 * 1024 * 1024;
    #[derive(Default)]
    struct Store {
        bytes: usize,
        files: BTreeMap<PathBuf, Arc<[u8]>>,
    }
    static STORE: OnceLock<RwLock<Store>> = OnceLock::new();
    fn store() -> &'static RwLock<Store> {
        STORE.get_or_init(Default::default)
    }
    // The browser's main thread mounts too (the sounds, at the first Audio) while the
    // resource loader Worker reads: a blocking lock there is Atomics.wait, which the
    // main thread may not call. The lock is only held for map work, so it is retried.
    fn read_store() -> io::Result<RwLockReadGuard<'static, Store>> {
        loop {
            match store().try_read() {
                Ok(guard) => return Ok(guard),
                Err(TryLockError::WouldBlock) => std::hint::spin_loop(),
                Err(TryLockError::Poisoned(_)) => return Err(io::Error::other("resource store poisoned")),
            }
        }
    }
    fn write_store() -> io::Result<RwLockWriteGuard<'static, Store>> {
        loop {
            match store().try_write() {
                Ok(guard) => return Ok(guard),
                Err(TryLockError::WouldBlock) => std::hint::spin_loop(),
                Err(TryLockError::Poisoned(_)) => return Err(io::Error::other("resource store poisoned")),
            }
        }
    }
    fn path(path: &Path) -> io::Result<PathBuf> {
        let mut out = PathBuf::new();
        for part in path.components() {
            match part {
                Component::Normal(name) => out.push(name),
                Component::CurDir => {}
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "resource paths must be relative and cannot traverse parents",
                    ));
                }
            }
        }
        Ok(out)
    }
    /// Takes ownership of one fetched resource. Replacing an existing mount is rejected:
    /// open readers can retain its bytes, so replacement would defeat budget accounting.
    pub fn mount(name: impl AsRef<Path>, bytes: Vec<u8>) -> io::Result<()> {
        let name = path(name.as_ref())?;
        let mut store = write_store()?;
        if store.files.contains_key(&name) {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "resource already mounted",
            ));
        }
        if bytes.len() > LIMIT.saturating_sub(store.bytes) {
            return Err(io::Error::new(
                io::ErrorKind::OutOfMemory,
                "browser resource budget exceeded",
            ));
        }
        let bytes: Arc<[u8]> = bytes.into();
        store.bytes += bytes.len();
        store.files.insert(name, bytes);
        Ok(())
    }
    pub struct File(io::Cursor<Arc<[u8]>>);
    pub fn is_dir(name: impl AsRef<Path>) -> bool {
        let Ok(name) = path(name.as_ref()) else {
            return false;
        };
        read_store().is_ok_and(|s| {
            s.files
                .range(name.clone()..)
                .take_while(|(p, _)| p.starts_with(&name))
                .any(|(p, _)| p != &name)
        })
    }
    pub fn read(name: impl AsRef<Path>) -> io::Result<Vec<u8>> {
        use io::Read;
        let mut bytes = Vec::new();
        File::open(name)?.read_to_end(&mut bytes)?;
        Ok(bytes)
    }
    pub fn read_to_string(name: impl AsRef<Path>) -> io::Result<String> {
        String::from_utf8(read(name)?).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }
    pub struct DirEntry(PathBuf);
    impl DirEntry {
        pub fn path(&self) -> PathBuf {
            self.0.clone()
        }
        pub fn file_name(&self) -> std::ffi::OsString {
            self.0.file_name().unwrap_or_default().to_owned()
        }
        pub fn file_type(&self) -> io::Result<FileType> {
            Ok(FileType(is_dir(&self.0)))
        }
        pub fn metadata(&self) -> io::Result<Metadata> {
            let directory = is_dir(&self.0);
            let s = read_store()?;
            Ok(Metadata {
                bytes: s.files.get(&self.0).map_or(0, |b| b.len() as u64),
                directory,
            })
        }
    }
    pub struct Metadata {
        bytes: u64,
        directory: bool,
    }
    impl Metadata {
        pub fn is_dir(&self) -> bool {
            self.directory
        }
        pub fn is_file(&self) -> bool {
            !self.directory
        }
        pub fn len(&self) -> u64 {
            self.bytes
        }
        pub fn modified(&self) -> io::Result<std::time::SystemTime> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "mounted resources have no filesystem timestamp",
            ))
        }
    }
    pub struct FileType(bool);
    impl FileType {
        pub fn is_dir(&self) -> bool {
            self.0
        }
        pub fn is_symlink(&self) -> bool {
            false
        }
        pub fn is_file(&self) -> bool {
            !self.0
        }
    }
    pub fn read_dir(
        name: impl AsRef<Path>,
    ) -> io::Result<std::vec::IntoIter<io::Result<DirEntry>>> {
        let name = path(name.as_ref())?;
        let s = read_store()?;
        let mut children = std::collections::BTreeSet::new();
        // Path ordering groups descendants together. Starting at the directory
        // avoids scanning every mounted file for each recursive atlas lookup.
        for (p, _) in s
            .files
            .range(name.clone()..)
            .take_while(|(p, _)| p.starts_with(&name))
        {
            if let Ok(rest) = p.strip_prefix(&name) {
                if let Some(c) = rest.components().next() {
                    children.insert(name.join(c));
                }
            }
        }
        if children.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "resource directory absent",
            ));
        }
        Ok(children
            .into_iter()
            .map(|p| Ok(DirEntry(p)))
            .collect::<Vec<_>>()
            .into_iter())
    }
    impl File {
        pub fn metadata(&self) -> io::Result<Metadata> {
            Ok(Metadata {
                bytes: self.0.get_ref().len() as u64,
                directory: false,
            })
        }
        pub fn open(name: impl AsRef<Path>) -> io::Result<Self> {
            let name = path(name.as_ref())?;
            let store = read_store()?;
            let bytes = store.files.get(&name).cloned().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("resource not mounted: {}", name.display()),
                )
            })?;
            Ok(Self(io::Cursor::new(bytes)))
        }
    }
    impl io::Read for File {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            io::Read::read(&mut self.0, bytes)
        }
    }
    impl io::Seek for File {
        fn seek(&mut self, pos: io::SeekFrom) -> io::Result<u64> {
            io::Seek::seek(&mut self.0, pos)
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        use std::io::{Read, Seek};
        #[test]
        fn readers_have_independent_positions_and_paths_cannot_escape() {
            mount("test/table.bin", vec![1, 2, 3]).unwrap();
            let mut a = File::open("test/table.bin").unwrap();
            let mut b = File::open("test/table.bin").unwrap();
            a.seek(io::SeekFrom::Start(2)).unwrap();
            let mut byte = [0];
            a.read_exact(&mut byte).unwrap();
            assert_eq!(byte, [3]);
            b.read_exact(&mut byte).unwrap();
            assert_eq!(byte, [1]);
            assert!(mount("../escape", vec![]).is_err());
            assert!(mount("test/table.bin", vec![]).is_err());
            mount("test/sub/second.bin", vec![4]).unwrap();
            let names: Vec<_> = read_dir("test")
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect();
            assert_eq!(
                names,
                vec![
                    std::ffi::OsString::from("sub"),
                    std::ffi::OsString::from("table.bin")
                ]
            );
            assert!(is_dir("test/sub"));
            assert!(!is_dir("test/table.bin"));
            assert_eq!(read("test/sub/second.bin").unwrap(), vec![4]);
            mount("test/submarine/third.bin", vec![5]).unwrap();
            mount("test/sub-zero.bin", vec![6]).unwrap();
            assert!(!is_dir("test/su"));
            assert!(read_dir("test/su").is_err());
            let files: Vec<_> = read_dir("test/sub")
                .unwrap()
                .map(|e| e.unwrap().path())
                .collect();
            assert_eq!(files, vec![PathBuf::from("test/sub/second.bin")]);
        }
    }
}
#[cfg(target_family = "wasm")]
pub use mounted::File;
#[cfg(target_family = "wasm")]
pub use mounted::{DirEntry, Metadata, is_dir, read, read_dir, read_to_string};

/// Virtual working directory of the browser session; native paths are unchanged.
pub fn current_dir() -> std::io::Result<std::path::PathBuf> {
    #[cfg(target_family = "wasm")]
    {
        Ok(std::path::PathBuf::from("."))
    }
    #[cfg(not(target_family = "wasm"))]
    {
        std::env::current_dir()
    }
}

/// Used only for per-process temporary names; browser files belong to one session.
pub fn process_id() -> u32 {
    #[cfg(target_family = "wasm")]
    {
        1
    }
    #[cfg(not(target_family = "wasm"))]
    {
        std::process::id()
    }
}

/// Keep filesystem timestamp types while sourcing the browser clock from JS.
pub fn system_time_now() -> std::time::SystemTime {
    #[cfg(target_family = "wasm")]
    {
        std::time::UNIX_EPOCH
            + web_time::SystemTime::now()
                .duration_since(web_time::UNIX_EPOCH)
                .unwrap_or_default()
    }
    #[cfg(not(target_family = "wasm"))]
    {
        std::time::SystemTime::now()
    }
}
