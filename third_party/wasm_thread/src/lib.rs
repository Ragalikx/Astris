#![cfg_attr(target_family = "wasm", feature(stdarch_wasm_atomic_wait))]

// Import reusable APIs from std
pub use std::thread::{current, sleep, Result, Thread, ThreadId};

#[cfg(target_family = "wasm")]
mod wasm32;

#[cfg(not(target_family = "wasm"))]
pub use std::thread::*;

#[cfg(target_family = "wasm")]
pub use wasm32::*;
