//! Prepared-resource boundary shared by client, worldgen and Workers.
pub use horizon_core::resource_io::*;
#[cfg(target_family = "wasm")]
pub mod browser;
