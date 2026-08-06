//! The shape of the store, as one string, and what to do when it disagrees.
//!
//! Its own file because two crates need it: the app compares it at boot, and
//! `wt-migrate` diffs the stored one against it to decide which tables can be
//! copied across untouched. A second copy of this string would defeat the
//! entire point of having it.

/// Where the fingerprint of the schema this build expects is recorded.
pub const FINGERPRINT_KEY: &str = "schema-fingerprint";

/// The schema this build reads. **Bump on any column change, in the same commit.**
///
/// # Why this exists
///
/// WorkTable persists rows with rkyv, positionally, and `version()` is a fixed
/// constant the macro emits, it does not change when a column does. So adding
/// one field to a table makes every row already on disk get read through the new
/// layout, silently, with no error anywhere.
///
/// It does not look like corruption. It looks like a project whose id reads as
/// `00:00   `: delete, pin and the session write all return `NotFound` against
/// an id that does not exist, two tabs collide on one garbage key, and a single
/// composer feeds two conversations. Every one of those was reported as its own
/// bug before the cause was one line of schema.
///
/// The string is the column lists, written out. Any edit to a schema changes it,
/// which is the point, it is a human-maintained fingerprint precisely so that
/// changing a schema and not thinking about the rows on disk is impossible.
pub const SCHEMA_FINGERPRINT: &str = concat!(
    "kv(key,value,updated_at);",
    "project(id,name,status,position,dirs,pinned,moderator_enabled,forked_from,last_activity_at);",
    "project_item(id,project_id,title,status,position,reference);",
    "message(id,project_id,item_id,author,agent,moderation,model,permission,usage,stop,exit_code,body,created_at);",
    "task_log(id,tool_call_id,project_id,item_id,label,tool,ok,output,duration_ms,exit_code,finished_at);",
    "agent_io_row(id,project_id,at,direction,kind,detail);",
    // Tables appended after first ship go at the end: `check_schema` treats a
    // stored fingerprint that is a prefix of this one as a match, because a
    // brand-new table has no rows on disk to misread.
    "usage_ledger(id,at,day,project_id,model,cost_micro,input_tokens,output_tokens);",
    "approval_rule(id,project_id,signature,created_at);",
    "pull_request(id,project_id,url,repo,number,branch,state,additions,deletions,ci,dismissed,updated_at);",
    "study_event(id,study_id,at,project_id,turn_id,interaction_id,agent,pathway,operation,stage,outcome,code,target_kind,target_id,latency_ms,detail,app_version,parser_version,protocol_version);",
    "question(id,project_id,text,urgency,item_id,issue_url,answered,created_at);",
    "message_chunk(id,message_id,project_id,seq,text);",
    "usage_cache(id,day,project_id,model,cache_read_tokens,cache_write_tokens,input_tokens,at);",
    "question_reply(id,project_id,question_id,message_id,created_at);",
    "reply_checkpoint(id,project_id,payload,created_at);",
);

/// What opening the tables found, so the caller can say something useful.
#[derive(Debug, PartialEq, Eq)]
pub enum SchemaState {
    /// First run, or a store this build wrote.
    Match,
    /// Written by a build with a different schema. The rows cannot be trusted.
    Mismatch { found: String },
}

/// Compare the fingerprint on disk with the one this build expects.
///
/// Returns `Mismatch` rather than deciding what to do: refusing to start and
/// silently wiping someone's transcripts are both wrong, and the caller is the
/// one that can say which.
#[must_use]
pub fn check_schema(stored: Option<&str>) -> SchemaState {
    match stored {
        // First run. Nothing on disk to misread.
        None => SchemaState::Match,
        Some(found) if found == SCHEMA_FINGERPRINT => SchemaState::Match,
        /*
         * The store predates a table this build added. Every table it does
         * know is unchanged, additions append to the fingerprint, and a
         * new table has no rows on disk to misread, so this is not the
         * silent-corruption case the fingerprint exists to catch. Boot
         * restamps, upgrading the marker to the full string.
         */
        Some(found) if SCHEMA_FINGERPRINT.starts_with(found) => SchemaState::Match,
        Some(found) => SchemaState::Mismatch {
            found: found.to_string(),
        },
    }
}
