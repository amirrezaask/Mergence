//! Rust implementation of the YAADE host runtime.
//!
//! The TypeScript executable remains the release entry point until the Rust
//! implementation passes the same protocol, persistence, PTY, security, and
//! lifecycle suites. Keeping both implementations in `apps/server` preserves
//! the existing application boundary during the parity migration.

pub mod config;
pub mod event_hub;
pub mod terminal_control;
pub mod wire;
