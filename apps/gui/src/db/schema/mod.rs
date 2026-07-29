//! One module per entity. Each declares its table and nothing else.
//!
//! Entities arrive in the order the UI needs them rather than all at once:
//! `kv` carries settings and the agent probe cache, and the project, item and
//! message tables land with the read path they serve.

pub mod kv;
pub mod message;
pub mod project;
pub mod project_item;
