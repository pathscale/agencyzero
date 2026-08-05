//! Overflow for a message body too large to fit one page.
//!
//! A WorkTable row must fit a single ~16 KB data page, so a message body over
//! the inline cap cannot live in the `message` row. Rather than truncate it —
//! which lost the tail of long replies and, worse, of long user messages — the
//! head stays inline on the message row and the remainder spills here, one
//! ordered chunk per row, keyed by the message id. The read path stitches the
//! head and the chunks back into the whole body; nothing else knows the split
//! happened.
//!
//! `seq` orders the chunks after the inline head (seq 0 is the first overflow
//! piece, not the head). Deleting a message deletes its chunks by the same
//! `message_id`, so no orphan survives its row.

use worktable::prelude::*;
use worktable::worktable;

worktable!(
    name: MessageChunk,
    persist: true,
    columns: {
        // `<message id>#<seq>`, unique per chunk, so the primary key is a real
        // key rather than the message id repeated.
        id: String primary_key,
        message_id: String,
        project_id: String,
        // Order after the inline head. 0 is the first overflow chunk.
        seq: u32,
        // A page-bounded slice of the body's tail, in byte order.
        text: String,
    },
    indexes: {
        chunk_message_idx: message_id,
        chunk_project_idx: project_id,
    },
    queries: {
        delete: {
            ByMessage() by message_id,
            ByProject() by project_id,
        }
    }
);
