//! Browser session files. Native builds retain the real filesystem unchanged.
//! Browser writes are bounded RAM files. Every change is also recorded in a journal
//! (changed byte ranges, created folders, removals) that the host page drains with
//! [`drain`] and applies to the Origin Private File System, so persisting a world
//! copies only what changed instead of serialising every save file.
#[cfg(not(target_family = "wasm"))]
pub use std::fs::*;
#[cfg(not(target_family = "wasm"))]
pub fn is_dir(p: impl AsRef<std::path::Path>) -> bool {
    p.as_ref().is_dir()
}
#[cfg(not(target_family = "wasm"))]
pub fn is_file(p: impl AsRef<std::path::Path>) -> bool {
    p.as_ref().is_file()
}
#[cfg(not(target_family = "wasm"))]
pub fn exists(p: impl AsRef<std::path::Path>) -> bool {
    p.as_ref().exists()
}
#[cfg(target_family = "wasm")]
pub use memory::*;

#[cfg(any(target_family = "wasm", test))]
mod memory {
    use std::{
        collections::{BTreeMap, BTreeSet},
        io::{self, Read, Seek, SeekFrom, Write},
        path::{Component, Path, PathBuf},
        sync::{
            Arc, Mutex, MutexGuard, OnceLock,
            atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        },
    };

    #[cfg(target_family = "wasm")]
    fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        loop {
            match mutex.try_lock() {
                Ok(guard) => return guard,
                Err(std::sync::TryLockError::Poisoned(error)) => return error.into_inner(),
                // These guards protect short in-memory map/byte operations.
                // The UI thread must never enter std's Atomics.wait parking path.
                Err(std::sync::TryLockError::WouldBlock) => std::hint::spin_loop(),
            }
        }
    }
    #[cfg(not(target_family = "wasm"))]
    fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex.lock().unwrap()
    }
    // Session files live in wasm memory, but only those in use: a world's region files
    // that reached the host's store are let go past `KEEP` and read back when needed
    // (`evict`, `resident`), so a world may be far larger than memory. `LIMIT` bounds
    // what is held at once: what is being written and what is in use (the 32-bit build
    // shares 4 GiB with the game; the 64-bit one has room to spare).
    #[cfg(target_pointer_width = "64")]
    const LIMIT: usize = 2048 * 1024 * 1024;
    #[cfg(not(target_pointer_width = "64"))]
    const LIMIT: usize = 1024 * 1024 * 1024;
    #[cfg(target_pointer_width = "64")]
    const KEEP: usize = 512 * 1024 * 1024;
    #[cfg(not(target_pointer_width = "64"))]
    const KEEP: usize = 256 * 1024 * 1024;
    /// Bumped on every mutation so the host persists only when something changed.
    static REV: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    static SETTINGS_REV: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    static WORLD_REV: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    fn touch_path(in_saves: bool) {
        REV.fetch_add(1, Ordering::Relaxed);
        if in_saves {
            WORLD_REV.fetch_add(1, Ordering::Relaxed);
        } else {
            SETTINGS_REV.fetch_add(1, Ordering::Relaxed);
        }
    }
    pub fn revision() -> u64 {
        REV.load(Ordering::Relaxed)
    }
    pub fn settings_revision() -> u64 {
        SETTINGS_REV.load(Ordering::Relaxed)
    }
    pub fn world_revision() -> u64 {
        WORLD_REV.load(Ordering::Relaxed)
    }
    static USED: AtomicUsize = AtomicUsize::new(0);
    /// Byte ranges of a file changed since the host last persisted it. Lock order:
    /// `Data::bytes`, then `Data::dirty`, then the journal.
    #[derive(Default)]
    struct Dirty {
        /// The host must rewrite the whole file (new, renamed or too many ranges).
        full: bool,
        /// Sorted, non-overlapping `[start, end)` ranges.
        ranges: Vec<(usize, usize)>,
    }
    impl Dirty {
        const MAX_RANGES: usize = 256;
        fn add(&mut self, start: usize, end: usize) {
            if self.full || start >= end {
                return;
            }
            let at = self.ranges.partition_point(|r| r.1 < start);
            let mut merged = (start, end);
            let mut last = at;
            while last < self.ranges.len() && self.ranges[last].0 <= end {
                merged.0 = merged.0.min(self.ranges[last].0);
                merged.1 = merged.1.max(self.ranges[last].1);
                last += 1;
            }
            self.ranges.splice(at..last, [merged]);
            if self.ranges.len() > Self::MAX_RANGES {
                self.full = true;
                self.ranges.clear();
            }
        }
    }
    struct Data {
        bytes: Mutex<Vec<u8>>,
        dirty: Mutex<Dirty>,
        locked: AtomicBool,
        in_saves: AtomicBool,
        /// Not in memory: the bytes are only in the host's store, `stored` long.
        /// Changed only with `bytes` locked.
        evicted: AtomicBool,
        stored: AtomicUsize,
        /// The drain that last sent this file to the host (0: it came from the host).
        drained: AtomicU64,
        /// When it was last used ([`TICK`]), so the longest unused goes first.
        used: AtomicU64,
    }
    impl Data {
        /// A file the host has not stored yet: its first persist writes all of it.
        fn fresh(in_saves: bool, bytes: Vec<u8>) -> Self {
            Self::with_dirty(in_saves, bytes, true)
        }
        fn with_dirty(in_saves: bool, bytes: Vec<u8>, full: bool) -> Self {
            Self {
                bytes: Mutex::new(bytes),
                dirty: Mutex::new(Dirty {
                    full,
                    ranges: Vec::new(),
                }),
                locked: AtomicBool::new(false),
                in_saves: AtomicBool::new(in_saves),
                evicted: AtomicBool::new(false),
                stored: AtomicUsize::new(0),
                drained: AtomicU64::new(0),
                used: AtomicU64::new(TICK.fetch_add(1, Ordering::Relaxed)),
            }
        }
        /// The length, without reading an evicted file back.
        fn len(&self) -> usize {
            let bytes = lock(&self.bytes);
            if self.evicted.load(Ordering::Acquire) {
                self.stored.load(Ordering::Relaxed)
            } else {
                bytes.len()
            }
        }
    }
    impl Drop for Data {
        fn drop(&mut self) {
            if !*self.evicted.get_mut() {
                USED.fetch_sub(self.bytes.get_mut().unwrap().len(), Ordering::Relaxed);
            }
        }
    }
    static TICK: AtomicU64 = AtomicU64::new(1);
    /// The last drain handed to the host, and the last the host confirmed stored.
    static DRAINED: AtomicU64 = AtomicU64::new(0);
    static APPLIED: AtomicU64 = AtomicU64::new(0);
    /// Set when the host failed to store a batch: what it holds may be behind memory,
    /// so nothing is let go any more.
    static UNSAFE: AtomicBool = AtomicBool::new(false);

    /// The file's bytes, read back from the host's store first if it was let go.
    fn resident<'a>(data: &'a Data, name: &Path) -> io::Result<MutexGuard<'a, Vec<u8>>> {
        let mut bytes = lock(&data.bytes);
        data.used
            .store(TICK.fetch_add(1, Ordering::Relaxed), Ordering::Relaxed);
        if data.evicted.load(Ordering::Acquire) {
            let len = data.stored.load(Ordering::Relaxed);
            let mut loaded = vec![0; len];
            host::read(name, &mut loaded)?;
            USED.fetch_add(len, Ordering::Relaxed);
            *bytes = loaded;
            data.evicted.store(false, Ordering::Release);
        }
        Ok(bytes)
    }

    /// Lets go of region files (`.mca`) the host has stored until at most `target`
    /// bytes are held, the longest unused first. A file is let go only when every
    /// change to it is in a batch the host confirmed (none waiting in the journal), and
    /// not while it is in use.
    fn evict(target: usize) -> usize {
        if USED.load(Ordering::Relaxed) <= target || UNSAFE.load(Ordering::Relaxed) {
            return 0;
        }
        let applied = APPLIED.load(Ordering::Acquire);
        let mut candidates: Vec<(u64, Arc<Data>)> = lock(store())
            .files
            .iter()
            .filter(|(p, d)| {
                p.extension().is_some_and(|e| e == "mca") && !d.evicted.load(Ordering::Relaxed)
            })
            .map(|(_, d)| (d.used.load(Ordering::Relaxed), d.clone()))
            .collect();
        candidates.sort_unstable_by_key(|(used, _)| *used);
        let mut freed = 0;
        for (_, data) in candidates {
            if USED.load(Ordering::Relaxed) <= target {
                break;
            }
            let Ok(mut bytes) = data.bytes.try_lock() else {
                continue;
            };
            if data.evicted.load(Ordering::Acquire)
                || data.drained.load(Ordering::Relaxed) > applied
            {
                continue;
            }
            {
                let dirty = lock(&data.dirty);
                if dirty.full || !dirty.ranges.is_empty() {
                    continue;
                }
            }
            let len = bytes.len();
            data.stored.store(len, Ordering::Relaxed);
            *bytes = Vec::new();
            USED.fetch_sub(len, Ordering::Relaxed);
            data.evicted.store(true, Ordering::Release);
            freed += len;
        }
        freed
    }

    /// The host stored every batch up to `seq` (from [`drained`]): what they held may
    /// be let go.
    pub fn applied(seq: u64) {
        APPLIED.fetch_max(seq, Ordering::AcqRel);
        evict(KEEP);
    }
    /// The number of the last batch [`drain`] handed over.
    pub fn drained() -> u64 {
        DRAINED.load(Ordering::Acquire)
    }
    /// The host could not store a batch: from now on every file stays in memory.
    pub fn store_failed() {
        UNSAFE.store(true, Ordering::Relaxed);
    }
    /// Bytes of session files held in memory.
    pub fn resident_bytes() -> usize {
        USED.load(Ordering::Relaxed)
    }

    /// Reading a file back from the host's store, synchronously, on any thread.
    #[cfg(target_family = "wasm")]
    mod host {
        use std::{
            io,
            path::Path,
            sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering},
        };
        /// One request at a time, in shared memory, which the host's file Worker polls
        /// (every millisecond while reads come in): 1 asks, 2 answers done, 3 failed; the asker
        /// sets 0 again. Then the name's address and length, where to put the bytes, and
        /// how many (all u64, little endian).
        #[repr(C, align(8))]
        pub struct Channel {
            state: AtomicI32,
            _pad: i32,
            name: AtomicU64,
            name_len: AtomicU64,
            dst: AtomicU64,
            len: AtomicU64,
        }
        pub static CHANNEL: Channel = Channel {
            state: AtomicI32::new(0),
            _pad: 0,
            name: AtomicU64::new(0),
            name_len: AtomicU64::new(0),
            dst: AtomicU64::new(0),
            len: AtomicU64::new(0),
        };
        static BUSY: AtomicBool = AtomicBool::new(false);
        static MAIN: std::sync::OnceLock<std::thread::ThreadId> = std::sync::OnceLock::new();
        /// Called once on the page's main thread, which may never sleep.
        pub fn set_main_thread() {
            let _ = MAIN.set(std::thread::current().id());
        }
        fn is_main_thread() -> bool {
            // Unknown: taken as the main thread, which only costs spinning.
            MAIN.get().is_none_or(|id| *id == std::thread::current().id())
        }

        pub fn read(name: &Path, out: &mut [u8]) -> io::Result<()> {
            let name = name.to_string_lossy();
            let main = is_main_thread();
            while BUSY
                .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
                .is_err()
            {
                if main {
                    std::hint::spin_loop();
                } else {
                    std::thread::sleep(std::time::Duration::from_micros(250));
                }
            }
            CHANNEL.name.store(name.as_ptr() as u64, Ordering::Relaxed);
            CHANNEL.name_len.store(name.len() as u64, Ordering::Relaxed);
            CHANNEL.dst.store(out.as_mut_ptr() as u64, Ordering::Relaxed);
            CHANNEL.len.store(out.len() as u64, Ordering::Relaxed);
            CHANNEL.state.store(1, Ordering::SeqCst);
            // Worker threads sleep between looks; the page's main thread may not block
            // (Atomics.wait) and spins. Dozens of Workers spinning at once took every
            // core from the file Worker that answers, and reads took seconds.
            let main = is_main_thread();
            let state = loop {
                let state = CHANNEL.state.load(Ordering::SeqCst);
                if state != 1 {
                    break state;
                }
                if main {
                    std::hint::spin_loop();
                } else {
                    std::thread::sleep(std::time::Duration::from_micros(250));
                }
            };
            CHANNEL.state.store(0, Ordering::SeqCst);
            BUSY.store(false, Ordering::Release);
            if state == 2 {
                Ok(())
            } else {
                Err(io::Error::other(format!(
                    "session file {name} could not be read back from the browser's store"
                )))
            }
        }
    }
    /// Tests stand in for the host with a map of what it "stored".
    #[cfg(not(target_family = "wasm"))]
    mod host {
        use std::{collections::BTreeMap, io, path::Path, path::PathBuf, sync::Mutex};
        pub static STORED: Mutex<BTreeMap<PathBuf, Vec<u8>>> = Mutex::new(BTreeMap::new());
        pub fn read(name: &Path, out: &mut [u8]) -> io::Result<()> {
            let stored = STORED.lock().unwrap();
            let bytes = stored.get(name).ok_or(io::ErrorKind::NotFound)?;
            if bytes.len() != out.len() {
                return Err(io::ErrorKind::InvalidData.into());
            }
            out.copy_from_slice(bytes);
            Ok(())
        }
    }
    /// Marks the calling thread as the page's main thread (it never sleeps waiting).
    #[cfg(target_family = "wasm")]
    pub fn set_main_thread() {
        host::set_main_thread();
    }
    /// Where the read-back requests are, for the host's file Worker.
    #[cfg(target_family = "wasm")]
    pub fn read_channel() -> usize {
        &host::CHANNEL as *const host::Channel as usize
    }
    #[derive(Default)]
    struct Store {
        files: BTreeMap<PathBuf, Arc<Data>>,
        dirs: BTreeSet<PathBuf>,
    }
    fn store() -> &'static Mutex<Store> {
        static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
        STORE.get_or_init(Default::default)
    }
    /// What changed since the host last drained: names only; contents are read at drain time.
    #[derive(Default)]
    struct Journal {
        files: BTreeSet<PathBuf>,
        dirs: BTreeSet<PathBuf>,
        /// Removed paths in order; `true` removes a whole folder.
        removed: Vec<(PathBuf, bool)>,
    }
    fn journal() -> &'static Mutex<Journal> {
        static JOURNAL: OnceLock<Mutex<Journal>> = OnceLock::new();
        JOURNAL.get_or_init(Default::default)
    }
    fn note_file(name: &Path) {
        lock(journal()).files.insert(name.to_owned());
    }
    fn note_range(name: &Path, data: &Data, start: usize, end: usize) {
        lock(&data.dirty).add(start, end);
        note_file(name);
    }
    fn note_full(name: &Path, data: &Data) {
        let mut dirty = lock(&data.dirty);
        dirty.full = true;
        dirty.ranges.clear();
        drop(dirty);
        note_file(name);
    }
    fn note_removed(p: &Path, tree: bool) {
        lock(journal()).removed.push((p.to_owned(), tree));
    }
    /// True when [`drain`] has something for the host to persist.
    pub fn pending() -> bool {
        let j = lock(journal());
        !(j.files.is_empty() && j.dirs.is_empty() && j.removed.is_empty())
    }
    fn path(p: impl AsRef<Path>) -> io::Result<PathBuf> {
        let mut out = PathBuf::new();
        for c in p.as_ref().components() {
            match c {
                Component::Normal(n) => out.push(n),
                Component::CurDir => {}
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "session path must be relative",
                    ));
                }
            }
        }
        Ok(out)
    }
    fn writable(p: &Path) -> io::Result<()> {
        if p.starts_with("resources") {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "prepared resources are immutable",
            ))
        } else {
            Ok(())
        }
    }
    fn resize(data: &mut Vec<u8>, len: usize, in_saves: bool) -> io::Result<()> {
        touch_path(in_saves);
        if len > data.len() {
            let delta = len - data.len();
            USED.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
                n.checked_add(delta).filter(|n| *n <= LIMIT)
            })
            .map_err(|_| {
                io::Error::new(
                    io::ErrorKind::OutOfMemory,
                    "browser session file budget exceeded",
                )
            })?;
        } else {
            USED.fetch_sub(data.len() - len, Ordering::Relaxed);
        }
        data.resize(len, 0);
        Ok(())
    }
    enum Backing {
        Resource(crate::resource_io::mounted::File),
        Session(Arc<Data>),
    }
    pub struct File {
        backing: Backing,
        /// The session path this handle was opened with (the journal's key).
        name: PathBuf,
        at: u64,
        write: bool,
    }
    #[derive(Default)]
    pub struct OpenOptions {
        read: bool,
        write: bool,
        create: bool,
        create_new: bool,
        truncate: bool,
        append: bool,
    }
    impl OpenOptions {
        pub fn new() -> Self {
            Self::default()
        }
        pub fn read(&mut self, v: bool) -> &mut Self {
            self.read = v;
            self
        }
        pub fn write(&mut self, v: bool) -> &mut Self {
            self.write = v;
            self
        }
        pub fn create(&mut self, v: bool) -> &mut Self {
            self.create = v;
            self
        }
        pub fn create_new(&mut self, v: bool) -> &mut Self {
            self.create_new = v;
            self
        }
        pub fn truncate(&mut self, v: bool) -> &mut Self {
            self.truncate = v;
            self
        }
        pub fn append(&mut self, v: bool) -> &mut Self {
            self.append = v;
            self.write |= v;
            self
        }
        pub fn open(&self, name: impl AsRef<Path>) -> io::Result<File> {
            let name = path(name)?;
            if name.starts_with("resources")
                && !self.write
                && !self.create
                && !self.create_new
                && !self.truncate
            {
                return Ok(File {
                    backing: Backing::Resource(crate::resource_io::mounted::File::open(&name)?),
                    name,
                    at: 0,
                    write: false,
                });
            }
            if self.write || self.create || self.create_new || self.truncate {
                writable(&name)?;
            }
            let mut s = lock(store());
            if self.create_new && s.files.contains_key(&name) {
                return Err(io::ErrorKind::AlreadyExists.into());
            }
            let in_saves = name.starts_with("saves") || name.starts_with(".horizon-remote-unused");
            let data = match s.files.get(&name) {
                Some(d) => Some(d.clone()),
                None if self.create || self.create_new => {
                    let d = Arc::new(Data::fresh(in_saves, Vec::new()));
                    s.files.insert(name.clone(), d.clone());
                    note_file(&name);
                    Some(d)
                }
                None => None,
            };
            drop(s);
            if let Some(data) = data {
                let mut at = 0;
                if self.truncate || self.append {
                    let mut bytes = resident(&data, &name)?;
                    if self.truncate && !bytes.is_empty() {
                        let old = bytes.len();
                        resize(&mut bytes, 0, in_saves)?;
                        note_range(&name, &data, 0, old);
                    }
                    if self.append {
                        at = bytes.len() as u64;
                    }
                }
                Ok(File {
                    backing: Backing::Session(data),
                    name,
                    at,
                    write: self.write,
                })
            } else if !self.write {
                Ok(File {
                    backing: Backing::Resource(crate::resource_io::mounted::File::open(&name)?),
                    name,
                    at: 0,
                    write: false,
                })
            } else {
                Err(io::ErrorKind::NotFound.into())
            }
        }
    }
    impl File {
        pub fn open(p: impl AsRef<Path>) -> io::Result<Self> {
            OpenOptions::new().read(true).open(p)
        }
        pub fn create(p: impl AsRef<Path>) -> io::Result<Self> {
            OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(p)
        }
        pub fn set_len(&self, len: u64) -> io::Result<()> {
            match &self.backing {
                Backing::Session(d) if self.write => {
                    let len = usize::try_from(len).map_err(|_| io::ErrorKind::InvalidInput)?;
                    let mut bytes = resident(d, &self.name)?;
                    let old = bytes.len();
                    resize(&mut bytes, len, d.in_saves.load(Ordering::Relaxed))?;
                    // A shrink then a regrow must rewrite the zeroed tail, so record both.
                    note_range(&self.name, d, old.min(len), old.max(len));
                    Ok(())
                }
                _ => Err(io::ErrorKind::PermissionDenied.into()),
            }
        }
        pub fn sync_all(&self) -> io::Result<()> {
            Ok(())
        }
        pub fn sync_data(&self) -> io::Result<()> {
            Ok(())
        }
        pub fn metadata(&self) -> io::Result<Metadata> {
            Ok(Metadata {
                len: match &self.backing {
                    Backing::Resource(f) => f.metadata()?.len(),
                    Backing::Session(d) => d.len() as u64,
                },
                dir: false,
            })
        }
        pub fn try_lock(&self) -> io::Result<()> {
            match &self.backing {
                Backing::Session(d) => d
                    .locked
                    .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
                    .map(|_| ())
                    .map_err(|_| io::ErrorKind::WouldBlock.into()),
                _ => Err(io::ErrorKind::Unsupported.into()),
            }
        }
        /// Waits for the advisory lock. Holders are other handles in this page, which
        /// keep it for a short write, so this spins rather than parking the UI thread.
        pub fn lock(&self) -> io::Result<()> {
            loop {
                match self.try_lock() {
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => std::hint::spin_loop(),
                    other => return other,
                }
            }
        }
        pub fn unlock(&self) -> io::Result<()> {
            if let Backing::Session(d) = &self.backing {
                d.locked.store(false, Ordering::Release);
            }
            Ok(())
        }
    }
    impl Read for File {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            match &mut self.backing {
                Backing::Resource(f) => f.read(out),
                Backing::Session(d) => {
                    let bytes = resident(d, &self.name)?;
                    let at = (self.at as usize).min(bytes.len());
                    let n = out.len().min(bytes.len() - at);
                    out[..n].copy_from_slice(&bytes[at..at + n]);
                    self.at += n as u64;
                    Ok(n)
                }
            }
        }
    }
    impl Write for File {
        fn write(&mut self, input: &[u8]) -> io::Result<usize> {
            if !self.write {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            match &self.backing {
                Backing::Session(d) => {
                    let mut bytes = resident(d, &self.name)?;
                    let in_saves = d.in_saves.load(Ordering::Relaxed);
                    let at = usize::try_from(self.at).map_err(|_| io::ErrorKind::InvalidInput)?;
                    let end = at
                        .checked_add(input.len())
                        .ok_or(io::ErrorKind::InvalidInput)?;
                    let old = bytes.len();
                    if end > old {
                        resize(&mut bytes, end, in_saves)?;
                    }
                    bytes[at..end].copy_from_slice(input);
                    // Bytes zero-filled between the old end and `at` changed too.
                    note_range(&self.name, d, at.min(old), end);
                    touch_path(in_saves);
                    self.at = end as u64;
                    Ok(input.len())
                }
                _ => Err(io::ErrorKind::PermissionDenied.into()),
            }
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl Seek for File {
        fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
            if let Backing::Resource(f) = &mut self.backing {
                return f.seek(pos);
            }
            let next = match pos {
                SeekFrom::Start(n) => n as i128,
                SeekFrom::Current(n) => self.at as i128 + n as i128,
                SeekFrom::End(n) => self.metadata()?.len as i128 + n as i128,
            };
            self.at = u64::try_from(next).map_err(|_| io::ErrorKind::InvalidInput)?;
            Ok(self.at)
        }
    }
    pub struct Metadata {
        len: u64,
        dir: bool,
    }
    impl Metadata {
        pub fn len(&self) -> u64 {
            self.len
        }
        pub fn is_dir(&self) -> bool {
            self.dir
        }
        pub fn is_file(&self) -> bool {
            !self.dir
        }
        pub fn modified(&self) -> io::Result<std::time::SystemTime> {
            Ok(std::time::UNIX_EPOCH)
        }
        pub fn created(&self) -> io::Result<std::time::SystemTime> {
            Err(io::ErrorKind::Unsupported.into())
        }
        /// The session store has no links: a hard link is a second name for the same bytes.
        pub fn is_symlink(&self) -> bool {
            false
        }
    }
    pub fn metadata(p: impl AsRef<Path>) -> io::Result<Metadata> {
        if is_dir(&p) {
            Ok(Metadata { len: 0, dir: true })
        } else {
            File::open(p)?.metadata()
        }
    }
    pub fn symlink_metadata(p: impl AsRef<Path>) -> io::Result<Metadata> {
        metadata(p)
    }
    pub fn read_link(p: impl AsRef<Path>) -> io::Result<PathBuf> {
        path(p)?;
        Err(io::Error::new(io::ErrorKind::InvalidInput, "not a symbolic link"))
    }
    pub fn is_dir(p: impl AsRef<Path>) -> bool {
        let Ok(p) = path(p) else { return false };
        p.as_os_str().is_empty()
            || lock(store()).dirs.contains(&p)
            || crate::resource_io::mounted::is_dir(p)
    }
    pub fn is_file(p: impl AsRef<Path>) -> bool {
        File::open(p).is_ok()
    }
    pub fn exists(p: impl AsRef<Path>) -> bool {
        is_dir(&p) || is_file(p)
    }
    pub fn read(p: impl AsRef<Path>) -> io::Result<Vec<u8>> {
        let mut out = Vec::new();
        File::open(p)?.read_to_end(&mut out)?;
        Ok(out)
    }
    pub fn read_to_string(p: impl AsRef<Path>) -> io::Result<String> {
        String::from_utf8(read(p)?).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }
    pub fn write(p: impl AsRef<Path>, data: impl AsRef<[u8]>) -> io::Result<()> {
        File::create(p)?.write_all(data.as_ref())
    }
    pub fn create_dir_all(p: impl AsRef<Path>) -> io::Result<()> {
        let p = path(p)?;
        writable(&p)?;
        let mut s = lock(store());
        if s.dirs.contains(&p) {
            return Ok(());
        }
        touch_path(p.starts_with("saves"));
        for a in p.ancestors() {
            s.dirs.insert(a.to_owned());
        }
        drop(s);
        if !p.as_os_str().is_empty() {
            lock(journal()).dirs.insert(p);
        }
        Ok(())
    }
    pub fn create_dir(p: impl AsRef<Path>) -> io::Result<()> {
        if exists(&p) {
            return Err(io::ErrorKind::AlreadyExists.into());
        }
        create_dir_all(p)
    }
    pub fn remove_file(p: impl AsRef<Path>) -> io::Result<()> {
        let p = path(p)?;
        writable(&p)?;
        touch_path(p.starts_with("saves"));
        lock(store())
            .files
            .remove(&p)
            .ok_or(io::Error::from(io::ErrorKind::NotFound))?;
        note_removed(&p, false);
        Ok(())
    }
    pub fn remove_dir_all(p: impl AsRef<Path>) -> io::Result<()> {
        let p = path(p)?;
        writable(&p)?;
        touch_path(p.starts_with("saves"));
        let mut s = lock(store());
        s.files.retain(|n, _| !n.starts_with(&p));
        s.dirs.retain(|n| !n.starts_with(&p));
        drop(s);
        note_removed(&p, true);
        Ok(())
    }
    pub fn remove_dir(p: impl AsRef<Path>) -> io::Result<()> {
        if read_dir(&p)?.next().is_some() {
            return Err(io::ErrorKind::DirectoryNotEmpty.into());
        }
        remove_dir_all(p)
    }
    pub fn copy(a: impl AsRef<Path>, b: impl AsRef<Path>) -> io::Result<u64> {
        let bytes = read(a)?;
        write(b, &bytes)?;
        Ok(bytes.len() as u64)
    }
    pub fn hard_link(a: impl AsRef<Path>, b: impl AsRef<Path>) -> io::Result<()> {
        let (a, b) = (path(a)?, path(b)?);
        writable(&b)?;
        let mut s = lock(store());
        if s.files.contains_key(&b) {
            return Err(io::ErrorKind::AlreadyExists.into());
        }
        let d = s.files.get(&a).cloned().ok_or(io::ErrorKind::NotFound)?;
        drop(s);
        drop(resident(&d, &a)?);
        let mut s = lock(store());
        s.files.insert(b.clone(), d.clone());
        drop(s);
        // The host has no links: it stores the second name as its own copy.
        note_full(&b, &d);
        Ok(())
    }
    pub fn rename(a: impl AsRef<Path>, b: impl AsRef<Path>) -> io::Result<()> {
        let (a, b) = (path(a)?, path(b)?);
        writable(&a)?;
        writable(&b)?;
        touch_path(a.starts_with("saves") || b.starts_with("saves"));
        // The host holds an evicted file under its old name: read it back first.
        let old = lock(store()).files.get(&a).cloned();
        if let Some(old) = old {
            drop(resident(&old, &a)?);
        }
        let mut s = lock(store());
        let d = s.files.remove(&a).ok_or(io::ErrorKind::NotFound)?;
        d.in_saves.store(b.starts_with("saves"), Ordering::Relaxed);
        s.files.insert(b.clone(), d.clone());
        drop(s);
        note_removed(&a, false);
        note_full(&b, &d);
        Ok(())
    }
    pub fn canonicalize(p: impl AsRef<Path>) -> io::Result<PathBuf> {
        let p = path(p)?;
        if exists(&p) {
            Ok(p)
        } else {
            Err(io::ErrorKind::NotFound.into())
        }
    }
    pub struct DirEntry(PathBuf);
    impl DirEntry {
        pub fn path(&self) -> PathBuf {
            self.0.clone()
        }
        pub fn file_name(&self) -> std::ffi::OsString {
            self.0.file_name().unwrap_or_default().to_owned()
        }
        pub fn metadata(&self) -> io::Result<Metadata> {
            metadata(&self.0)
        }
        pub fn file_type(&self) -> io::Result<FileType> {
            Ok(FileType(is_dir(&self.0)))
        }
    }
    pub struct FileType(bool);
    impl FileType {
        pub fn is_dir(&self) -> bool {
            self.0
        }
        pub fn is_file(&self) -> bool {
            !self.0
        }
        pub fn is_symlink(&self) -> bool {
            false
        }
    }
    pub fn read_dir(p: impl AsRef<Path>) -> io::Result<std::vec::IntoIter<io::Result<DirEntry>>> {
        let p = path(p)?;
        let mut entries = BTreeSet::new();
        if let Ok(dir) = crate::resource_io::mounted::read_dir(&p) {
            for e in dir {
                entries.insert(e?.path());
            }
        }
        let s = lock(store());
        let found = s.dirs.contains(&p);
        for n in s.files.keys().chain(s.dirs.iter()) {
            if let Ok(rest) = n.strip_prefix(&p) {
                if let Some(c) = rest.components().next() {
                    entries.insert(p.join(c));
                }
            }
        }
        if entries.is_empty() && !found {
            return Err(io::ErrorKind::NotFound.into());
        }
        Ok(entries
            .into_iter()
            .map(|p| Ok(DirEntry(p)))
            .collect::<Vec<_>>()
            .into_iter())
    }

    const MAGIC: &[u8; 8] = b"HZSNAP01";
    /// Serialises every browser-written file (not the immutable resources) so
    /// the host can store it durably.
    pub fn snapshot() -> Vec<u8> {
        let s = lock(store());
        let mut out = Vec::from(&MAGIC[..]);
        out.extend((s.dirs.len() as u32).to_le_bytes());
        for d in &s.dirs {
            let n = d.to_string_lossy();
            out.extend((n.len() as u32).to_le_bytes());
            out.extend(n.as_bytes());
        }
        out.extend((s.files.len() as u32).to_le_bytes());
        for (p, data) in &s.files {
            let n = p.to_string_lossy();
            let bytes = resident(data, p).map(|b| b.clone()).unwrap_or_default();
            out.extend((n.len() as u32).to_le_bytes());
            out.extend(n.as_bytes());
            out.extend((bytes.len() as u64).to_le_bytes());
            out.extend(bytes.iter());
        }
        out
    }
    /// Serialises only non-world files (`options.txt`, `horizon-graphics.txt`,
    /// imported resource/shader packs) so option changes persist in microseconds
    /// without copying 150+ MiB of world region files on the main thread.
    pub fn settings_snapshot() -> Vec<u8> {
        let s = lock(store());
        let is_world =
            |p: &PathBuf| p.starts_with("saves") || p.starts_with(".horizon-remote-unused");
        let dirs: Vec<_> = s.dirs.iter().filter(|d| !is_world(d)).collect();
        let files: Vec<_> = s.files.iter().filter(|(p, _)| !is_world(p)).collect();
        let mut out = Vec::from(&MAGIC[..]);
        out.extend((dirs.len() as u32).to_le_bytes());
        for d in dirs {
            let n = d.to_string_lossy();
            out.extend((n.len() as u32).to_le_bytes());
            out.extend(n.as_bytes());
        }
        out.extend((files.len() as u32).to_le_bytes());
        for (p, data) in files {
            let n = p.to_string_lossy();
            let bytes = resident(data, p).map(|b| b.clone()).unwrap_or_default();
            out.extend((n.len() as u32).to_le_bytes());
            out.extend(n.as_bytes());
            out.extend((bytes.len() as u64).to_le_bytes());
            out.extend(bytes.iter());
        }
        out
    }
    /// Restores a [`snapshot`]; malformed input changes nothing.
    pub fn restore(blob: &[u8]) -> io::Result<()> {
        fn bad() -> io::Error {
            io::Error::new(io::ErrorKind::InvalidData, "corrupt session snapshot")
        }
        struct R<'a>(&'a [u8]);
        impl<'a> R<'a> {
            fn take(&mut self, n: usize) -> io::Result<&'a [u8]> {
                if n > self.0.len() {
                    return Err(bad());
                }
                let (a, b) = self.0.split_at(n);
                self.0 = b;
                Ok(a)
            }
            fn u32(&mut self) -> io::Result<usize> {
                Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()) as usize)
            }
            fn name(&mut self) -> io::Result<PathBuf> {
                let n = self.u32()?;
                let s = std::str::from_utf8(self.take(n)?).map_err(|_| bad())?;
                let p = path(s)?;
                writable(&p)?;
                Ok(p)
            }
        }
        let mut r = R(blob);
        if r.take(8)? != MAGIC {
            return Err(bad());
        }
        let mut dirs = Vec::new();
        for _ in 0..r.u32()? {
            dirs.push(r.name()?);
        }
        let mut files = Vec::new();
        let mut total = 0usize;
        for _ in 0..r.u32()? {
            let p = r.name()?;
            let len = u64::from_le_bytes(r.take(8)?.try_into().unwrap()) as usize;
            total = total
                .checked_add(len)
                .filter(|t| *t <= LIMIT)
                .ok_or_else(bad)?;
            files.push((p, r.take(len)?));
        }
        let mut s = lock(store());
        // Replaced files release their old budget when dropped, so only check headroom.
        let replaced: usize = files
            .iter()
            .filter_map(|(p, _)| s.files.get(p))
            .map(|d| if d.evicted.load(Ordering::Acquire) { 0 } else { d.len() })
            .sum();
        USED.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
            n.checked_add(total)
                .filter(|m| m - replaced.min(*m) <= LIMIT)
        })
        .map_err(|_| io::Error::new(io::ErrorKind::OutOfMemory, "snapshot exceeds budget"))?;
        for d in &dirs {
            for a in d.ancestors() {
                s.dirs.insert(a.to_owned());
            }
        }
        let names: Vec<PathBuf> = files.iter().map(|(p, _)| p.clone()).collect();
        for (p, b) in files {
            let in_saves = p.starts_with("saves");
            s.files.insert(p, Arc::new(Data::fresh(in_saves, b.to_vec())));
        }
        drop(s);
        // A legacy snapshot is not in the host's file store yet: persist all of it.
        let mut j = lock(journal());
        j.dirs
            .extend(dirs.into_iter().filter(|d| !d.as_os_str().is_empty()));
        j.files.extend(names);
        Ok(())
    }

    /// Adds a file the host restored from its own store. It is already persisted, so it
    /// is not journaled. Replaces a file of the same name.
    pub fn put_file(name: &str, bytes: Vec<u8>) -> io::Result<()> {
        let p = path(name)?;
        writable(&p)?;
        let len = bytes.len();
        USED.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| {
            n.checked_add(len).filter(|n| *n <= LIMIT)
        })
        .map_err(|_| {
            io::Error::new(
                io::ErrorKind::OutOfMemory,
                "browser session file budget exceeded",
            )
        })?;
        let in_saves = p.starts_with("saves") || p.starts_with(".horizon-remote-unused");
        let mut s = lock(store());
        if let Some(parent) = p.parent() {
            for a in parent.ancestors() {
                s.dirs.insert(a.to_owned());
            }
        }
        s.files
            .insert(p, Arc::new(Data::with_dirty(in_saves, bytes, false)));
        Ok(())
    }
    /// Adds a file the host holds without reading it: its bytes are read back from the
    /// host's store when first used (the start of a big world reads only its size).
    pub fn put_stored(name: &str, len: usize) -> io::Result<()> {
        let p = path(name)?;
        writable(&p)?;
        let in_saves = p.starts_with("saves") || p.starts_with(".horizon-remote-unused");
        let data = Data::with_dirty(in_saves, Vec::new(), false);
        data.evicted.store(true, Ordering::Relaxed);
        data.stored.store(len, Ordering::Relaxed);
        data.used.store(0, Ordering::Relaxed);
        let mut s = lock(store());
        if let Some(parent) = p.parent() {
            for a in parent.ancestors() {
                s.dirs.insert(a.to_owned());
            }
        }
        s.files.insert(p, Arc::new(data));
        Ok(())
    }
    /// Adds a folder the host restored (empty folders matter: a world is a folder).
    pub fn put_dir(name: &str) -> io::Result<()> {
        let p = path(name)?;
        writable(&p)?;
        let mut s = lock(store());
        for a in p.ancestors() {
            s.dirs.insert(a.to_owned());
        }
        Ok(())
    }

    const JOURNAL_MAGIC: &[u8; 8] = b"HZJRNL01";
    /// Takes up to about `budget` bytes of changes for the host to persist:
    ///
    /// ```text
    /// "HZJRNL01" u8 more
    /// u32 removals { u8 tree, u32 len, name }
    /// u32 dirs     { u32 len, name }
    /// u32 files    { u32 len, name, u64 file_len, u8 full, u32 ranges { u64 at, u32 len, bytes } }
    /// ```
    ///
    /// The host applies removals, then folders, then files, so a file written again after
    /// its folder was removed lands after the removal. `more` is 1 while changes remain;
    /// a file that alone exceeds `budget` is still sent whole.
    pub fn drain(budget: usize) -> Vec<u8> {
        fn name(out: &mut Vec<u8>, p: &Path) {
            let n = p.to_string_lossy();
            out.extend((n.len() as u32).to_le_bytes());
            out.extend(n.as_bytes());
        }
        let (files, dirs, removed) = {
            let mut j = lock(journal());
            (
                std::mem::take(&mut j.files),
                std::mem::take(&mut j.dirs),
                std::mem::take(&mut j.removed),
            )
        };
        let seq = DRAINED.fetch_add(1, Ordering::AcqRel) + 1;
        let mut out = Vec::from(&JOURNAL_MAGIC[..]);
        out.push(0);
        out.extend((removed.len() as u32).to_le_bytes());
        for (p, tree) in &removed {
            out.push(*tree as u8);
            name(&mut out, p);
        }
        let s = lock(store());
        let live_dirs: Vec<_> = dirs.iter().filter(|d| s.dirs.contains(*d)).collect();
        out.extend((live_dirs.len() as u32).to_le_bytes());
        for d in live_dirs {
            name(&mut out, d);
        }
        let count_at = out.len();
        out.extend(0u32.to_le_bytes());
        let mut count = 0u32;
        let mut left = BTreeSet::new();
        for p in files {
            if out.len() >= budget && count > 0 {
                left.insert(p);
                continue;
            }
            // Removed since it was journaled: the removal is in this batch or an earlier one.
            let Some(data) = s.files.get(&p) else {
                continue;
            };
            let Ok(bytes) = resident(data, &p) else {
                left.insert(p);
                continue;
            };
            data.drained.store(seq, Ordering::Relaxed);
            let dirty = std::mem::take(&mut *lock(&data.dirty));
            let len = bytes.len();
            let ranges: Vec<(usize, usize)> = if dirty.full {
                vec![(0, len)]
            } else {
                dirty
                    .ranges
                    .into_iter()
                    .filter_map(|(a, b)| (a < len).then_some((a, b.min(len))))
                    .collect()
            };
            name(&mut out, &p);
            out.extend((len as u64).to_le_bytes());
            out.push(dirty.full as u8);
            out.extend((ranges.len() as u32).to_le_bytes());
            for (a, b) in ranges {
                out.extend((a as u64).to_le_bytes());
                out.extend(((b - a) as u32).to_le_bytes());
                out.extend(&bytes[a..b]);
            }
            count += 1;
        }
        drop(s);
        out[count_at..count_at + 4].copy_from_slice(&count.to_le_bytes());
        if !left.is_empty() {
            out[8] = 1;
            lock(journal()).files.extend(left);
        }
        out
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        /// The store is global: tests that use it run one at a time.
        static SERIAL: Mutex<()> = Mutex::new(());
        #[test]
        fn region_style_random_access_and_atomic_save_rename() {
            let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
            create_dir_all("saves/session-test/region").unwrap();
            let mut f = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open("saves/session-test/region/r.0.0.mca")
                .unwrap();
            f.seek(SeekFrom::Start(8192)).unwrap();
            f.write_all(&[1, 2, 3]).unwrap();
            f.seek(SeekFrom::Start(8191)).unwrap();
            let mut got = [9; 4];
            f.read_exact(&mut got).unwrap();
            assert_eq!(got, [0, 1, 2, 3]);
            f.try_lock().unwrap();
            assert!(f.try_lock().is_err());
            f.unlock().unwrap();
            write("saves/session-test/level.dat_new", b"nbt").unwrap();
            rename(
                "saves/session-test/level.dat_new",
                "saves/session-test/level.dat",
            )
            .unwrap();
            assert_eq!(read("saves/session-test/level.dat").unwrap(), b"nbt");
            assert!(write("resources/immutable", b"bad").is_err());
            assert!(write("../escape", b"bad").is_err());
            let blob = snapshot();
            remove_dir_all("saves/session-test").unwrap();
            assert!(!exists("saves/session-test/level.dat"));
            restore(&blob).unwrap();
            assert_eq!(read("saves/session-test/level.dat").unwrap(), b"nbt");
            assert!(restore(b"junk").is_err());
            remove_dir_all("saves/session-test").unwrap();
        }

        #[test]
        fn stored_region_files_are_let_go_and_read_back() {
            let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
            put_dir("saves/evict-test/region").unwrap();
            let name = "saves/evict-test/region/r.1.1.mca";
            let mut f = OpenOptions::new()
                .read(true)
                .write(true)
                .create_new(true)
                .open(name)
                .unwrap();
            f.write_all(&[5; 4096]).unwrap();
            // Not stored by the host yet: kept.
            evict(0);
            assert!(!lock(store()).files[&path(name).unwrap()].evicted.load(Ordering::Relaxed));
            let _ = drain(usize::MAX);
            host::STORED
                .lock()
                .unwrap()
                .insert(path(name).unwrap(), vec![5; 4096]);
            // Sent, but the host has not confirmed it: kept.
            evict(0);
            assert!(!lock(store()).files[&path(name).unwrap()].evicted.load(Ordering::Relaxed));
            APPLIED.fetch_max(drained(), Ordering::AcqRel);
            evict(0);
            let data = lock(store()).files[&path(name).unwrap()].clone();
            assert!(data.evicted.load(Ordering::Relaxed));
            assert_eq!(metadata(name).unwrap().len(), 4096, "the size without reading back");
            // Read back on use, through the handle opened before it was let go.
            f.seek(SeekFrom::Start(100)).unwrap();
            let mut got = [0; 3];
            f.read_exact(&mut got).unwrap();
            assert_eq!(got, [5; 3]);
            assert!(!data.evicted.load(Ordering::Relaxed));
            // Changed again: kept until that change is stored too.
            f.write_all(&[9]).unwrap();
            evict(0);
            assert!(!data.evicted.load(Ordering::Relaxed));
            // A file the host holds, added by size only.
            host::STORED
                .lock()
                .unwrap()
                .insert(path("saves/evict-test/region/r.2.2.mca").unwrap(), vec![7; 10]);
            put_stored("saves/evict-test/region/r.2.2.mca", 10).unwrap();
            assert_eq!(read("saves/evict-test/region/r.2.2.mca").unwrap(), vec![7; 10]);
            drop(f);
            remove_dir_all("saves/evict-test").unwrap();
            let _ = drain(usize::MAX);
        }

        #[test]
        fn dirty_ranges_merge() {
            let mut d = Dirty::default();
            d.add(10, 20);
            d.add(30, 40);
            d.add(15, 31);
            d.add(50, 50);
            assert_eq!(d.ranges, [(10, 40)]);
            d.add(0, 5);
            d.add(40, 45);
            assert_eq!(d.ranges, [(0, 5), (10, 45)]);
            for i in 0..300 {
                d.add(100 + i * 10, 101 + i * 10);
            }
            assert!(d.full && d.ranges.is_empty());
        }

        #[test]
        fn journal_reports_only_changed_ranges() {
            let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
            put_dir("saves/journal-test").unwrap();
            put_file("saves/journal-test/r.0.0.mca", vec![7; 8192]).unwrap();
            let mut f = OpenOptions::new()
                .read(true)
                .write(true)
                .open("saves/journal-test/r.0.0.mca")
                .unwrap();
            f.seek(SeekFrom::Start(4096)).unwrap();
            f.write_all(&[1, 2, 3]).unwrap();
            let batch = drain(usize::MAX);
            // Names are written as the platform spells paths (`/` in the browser).
            let needle = path("saves/journal-test/r.0.0.mca").unwrap();
            let needle = needle.to_string_lossy();
            let needle = needle.as_bytes();
            let at = batch
                .windows(needle.len())
                .position(|w| w == needle)
                .unwrap()
                + needle.len();
            let u32_at = |i: usize| u32::from_le_bytes(batch[i..i + 4].try_into().unwrap());
            let u64_at = |i: usize| u64::from_le_bytes(batch[i..i + 8].try_into().unwrap());
            assert_eq!(u64_at(at), 8192);
            assert_eq!(batch[at + 8], 0, "a range, not a full rewrite");
            assert_eq!(u32_at(at + 9), 1);
            assert_eq!(u64_at(at + 13), 4096);
            assert_eq!(u32_at(at + 21), 3);
            assert_eq!(&batch[at + 25..at + 28], &[1, 2, 3]);
            rename(
                "saves/journal-test/r.0.0.mca",
                "saves/journal-test/r.0.1.mca",
            )
            .unwrap();
            let batch = drain(usize::MAX);
            assert!(batch.windows(needle.len()).any(|w| w == needle), "old name removed");
            assert!(batch.windows(8).any(|w| w == [7; 8]), "new name written whole");
            remove_dir_all("saves/journal-test").unwrap();
            let _ = drain(usize::MAX);
        }
    }
}
