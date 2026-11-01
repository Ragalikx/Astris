//! Players joining a world hosted in a browser, and a browser joining one, over WebRTC.
//!
//! A browser has no TCP: the page carries each connection over a WebRTC data channel and
//! moves its bytes in and out of one end of an in-memory pipe (`push`, `take`), which it
//! polls from the page's main thread. The other end is an ordinary connection: on the host
//! it is served like a guest from the network (`Lan::accept_peers`), on a guest it is the
//! connection the game joins with (the address `peer:<id>`, `take_dialed`). The pipes are
//! marked remote, so the connection is compressed as one over TCP.
use crate::lan::Shared;
use horizon_protocol::connection::Pipe;
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU32, Ordering},
    },
};

/// The address prefix of a connection the page dialed: `peer:<id>`.
pub const PREFIX: &str = "peer:";

/// The page's main thread uses these: never parked (Atomics.wait), only spun, and held
/// only for map work.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    loop {
        match mutex.try_lock() {
            Ok(guard) => return guard,
            Err(std::sync::TryLockError::Poisoned(error)) => return error.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => std::hint::spin_loop(),
        }
    }
}

/// The world accepting guests from the page, while it is open to them.
static HOST: Mutex<Option<Arc<Shared>>> = Mutex::new(None);
/// The page's end of each connection, by id.
static BRIDGES: Mutex<Option<HashMap<u32, Pipe>>> = Mutex::new(None);
/// A dialed connection's game end, until the game takes it to join.
static DIALED: Mutex<Option<HashMap<u32, Pipe>>> = Mutex::new(None);
static NEXT: AtomicU32 = AtomicU32::new(1);

/// The open world guests from the page join (`None` closes it to them).
pub fn set_host(shared: Option<Arc<Shared>>) {
    *lock(&HOST) = shared;
}

/// Whether a world is open to guests from the page.
pub fn hosting() -> bool {
    lock(&HOST).is_some()
}

/// A guest arrived on a data channel: its connection is served by the open world, on a
/// thread of its own. The id the page passes to `push`, `take` and `close`, or `None`
/// when no world is open to guests.
pub fn accept() -> Option<u32> {
    let shared = lock(&HOST).clone()?;
    let (page, server) = Pipe::remote_pair();
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let thread = horizon_threads::thread::Builder::new()
        .name(format!("horizon-peer-{id}"))
        .spawn(move || {
            if let Err(e) = crate::lan::conn::serve_peer(server, id, shared) {
                log::info!("Horizon: peer {id} left: {e}");
            }
        });
    if thread.is_err() {
        return None;
    }
    lock(&BRIDGES).get_or_insert_with(HashMap::new).insert(id, page);
    log::info!("Horizon: a guest joined over WebRTC (peer {id})");
    Some(id)
}

/// The page opened a data channel to a host: a connection whose game end waits for the
/// game to join `peer:<id>`.
pub fn dial() -> u32 {
    let (page, game) = Pipe::remote_pair();
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    lock(&BRIDGES).get_or_insert_with(HashMap::new).insert(id, page);
    lock(&DIALED).get_or_insert_with(HashMap::new).insert(id, game);
    id
}

/// The game end of a dialed connection, once.
pub fn take_dialed(id: u32) -> Option<Pipe> {
    lock(&DIALED).as_mut()?.remove(&id)
}

/// Bytes that arrived on the data channel, for the game; false once the connection closed.
pub fn push(id: u32, data: &[u8]) -> bool {
    lock(&BRIDGES).as_ref().and_then(|b| b.get(&id)).is_some_and(|pipe| pipe.push(data))
}

/// Up to `max` bytes the game sent, for the data channel, and whether the connection
/// closed with nothing left to send.
pub fn take(id: u32, max: usize) -> (Vec<u8>, bool) {
    match lock(&BRIDGES).as_ref().and_then(|b| b.get(&id)) {
        Some(pipe) => pipe.take_available(max),
        None => (Vec::new(), true),
    }
}

/// The data channel closed: the connection ends on the game's side too.
pub fn close(id: u32) {
    let pipe = lock(&BRIDGES).as_mut().and_then(|b| b.remove(&id));
    if let Some(pipe) = pipe {
        pipe.shutdown();
    }
    lock(&DIALED).as_mut().map(|d| d.remove(&id));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn a_dialed_connection_carries_bytes_both_ways() {
        let id = dial();
        let mut game = take_dialed(id).expect("dialed");
        assert!(take_dialed(id).is_none(), "taken once");
        game.write_all(b"hello").unwrap();
        assert_eq!(take(id, 1024), (b"hello".to_vec(), false));
        assert!(push(id, b"world"));
        let mut got = [0; 5];
        game.read_exact(&mut got).unwrap();
        assert_eq!(&got, b"world");
        close(id);
        assert!(!push(id, b"late"));
        assert_eq!(take(id, 1024), (Vec::new(), true));
    }
}
