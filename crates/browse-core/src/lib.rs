//! Browser policy, with no browser engine in it.
//!
//! Tabs, a back stack, the question of whether a typed string is an address,
//! and how to describe a load that half worked. Every one of those is a
//! decision a browser makes before an engine is involved, and every one of
//! them is a decision two applications that both embed Blitz want to agree on.
//!
//! Chuzz already draws this line — "keep browser policy separate from the
//! renderer" is the first rule in its working agreement — but it draws it
//! inside a single 1700-line module in a single binary, so agencyzero could
//! not reach it. This crate is that same line, drawn at a crate boundary
//! instead of a module boundary.
//!
//! The shape that makes it shareable is [`tabs::Load`]: the policy never
//! fetches anything. It answers "this tab, at this generation, now wants this
//! URL", the host performs the fetch with whatever net stack and engine it
//! has, and reports back with [`tabs::Tabs::finish_load`]. Nothing here
//! mentions a document, a node, or a window, which is why the whole crate is
//! testable without one — and why the tests below run in milliseconds rather
//! than needing a compositor.
//!
//! ## Adoption by chuzz
//!
//! Chuzz's `apps/chuzz/src/browser.rs` still has its own copy of this policy.
//! Replacing it is a separate, mechanical change in a separate repository, and
//! it needs this crate published first: chuzz takes every dependency as a
//! caret range from crates.io, deliberately, so a path dependency is not an
//! option there. Nothing in this crate depends on agencyzero, so that flip is
//! the only work standing between the two applications and one policy.

pub mod address;
pub mod debug_log;
pub mod history;
pub mod outcome;
pub mod tabs;

pub use address::{NEW_TAB_URL, display_title, is_internal, url_from_input};
pub use debug_log::{DebugEntry, DebugLog};
pub use history::{Entry, EntrySnapshot, History};
pub use outcome::PageOutcome;
pub use tabs::{BrowseSnapshot, Load, TabId, TabSnapshot, Tabs};
pub use url::Url;
