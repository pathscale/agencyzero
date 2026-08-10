//! Read-only discovery and parsing of local provider transcripts.
//!
//! Provider files are inputs, never stores AgencyZero writes back to. Import
//! resolves an opaque `(source, session id)` against a fixed allowlisted root;
//! the webview cannot supply an arbitrary filesystem path.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;

const MAX_DISCOVERED_FILES: usize = 500;
const MAX_VISIBLE_SESSIONS: usize = 100;
/// Discovery reads only enough of a rollout to identify its owner and preview.
/// Selected imports still stream the complete file.
const CODEX_DISCOVERY_BYTES: u64 = 128 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub source: String,
    pub label: String,
    pub available: bool,
    pub note: String,
    pub sessions: Vec<SessionSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    pub messages: usize,
    pub importable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImportedMessage {
    pub role: String,
    pub text: String,
    pub at: String,
    pub model: String,
    /// Already in the webview's camelCase usage shape; empty when unavailable.
    pub usage: String,
}

#[derive(Clone, Debug)]
pub struct ImportedChat {
    pub source: String,
    pub session_id: String,
    pub title: String,
    pub cwd: Option<String>,
    pub messages: Vec<ImportedMessage>,
    /// Native producer recorded in the rollout metadata, when one exists.
    pub originator: String,
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "the home directory is unavailable".to_string())
}

fn collect(root: &Path, extension: &str) -> Vec<PathBuf> {
    fn visit(dir: &Path, extension: &str, depth: usize, out: &mut Vec<PathBuf>) {
        if depth > 8 || out.len() >= MAX_DISCOVERED_FILES {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if out.len() >= MAX_DISCOVERED_FILES {
                break;
            }
            let path = entry.path();
            if path.is_dir() {
                visit(&path, extension, depth + 1, out);
            } else if path.extension().and_then(|value| value.to_str()) == Some(extension) {
                out.push(path);
            }
        }
    }

    let mut files = Vec::new();
    visit(root, extension, 0, &mut files);
    files.sort_by_key(|path| {
        std::cmp::Reverse(path.metadata().and_then(|meta| meta.modified()).ok())
    });
    files
}

fn text_content(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.trim().to_string(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .filter_map(|part| {
                let kind = part.get("type").and_then(serde_json::Value::as_str)?;
                matches!(kind, "text" | "input_text" | "output_text")
                    .then(|| part.get("text").and_then(serde_json::Value::as_str))
                    .flatten()
            })
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

fn title_from(messages: &[ImportedMessage], fallback: &str) -> String {
    let first = messages
        .iter()
        .find(|message| message.role == "user")
        .map(|message| message.text.as_str())
        .unwrap_or(fallback)
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(fallback)
        .trim();
    title_from_text(first, fallback)
}

fn title_from_text(first: &str, fallback: &str) -> String {
    let title: String = first.chars().take(72).collect();
    if first.chars().count() > 72 {
        format!("{title}…")
    } else if title.is_empty() {
        fallback.to_string()
    } else {
        title
    }
}

fn claude_usage(message: &serde_json::Value) -> String {
    let Some(usage) = message.get("usage") else {
        return String::new();
    };
    let count = |key: &str| usage.get(key).and_then(serde_json::Value::as_u64);
    let input = count("input_tokens");
    let cache_reads = count("cache_read_input_tokens");
    let cache_writes = count("cache_creation_input_tokens");
    let output = count("output_tokens");
    if input.is_none() && cache_reads.is_none() && cache_writes.is_none() && output.is_none() {
        return String::new();
    }
    let context = input
        .unwrap_or(0)
        .saturating_add(cache_reads.unwrap_or(0))
        .saturating_add(cache_writes.unwrap_or(0));
    serde_json::json!({
        "tokens": context.saturating_add(output.unwrap_or(0)),
        "inputTokens": input,
        "outputTokens": output,
        "contextTokens": context,
        "contextWindow": null,
        "cacheReads": cache_reads,
        "cacheWrites": cache_writes,
        "reasoningTokens": null,
        "costUsd": null,
        "premiumRequests": null,
        "durationMs": null
    })
    .to_string()
}

fn parse_claude(path: &Path) -> Result<ImportedChat, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut messages: Vec<ImportedMessage> = Vec::new();
    let mut positions: HashMap<String, usize> = HashMap::new();
    let mut session_id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_string();
    let mut cwd = None;

    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let role = value
            .get("message")
            .and_then(|message| message.get("role"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if !matches!(role, "user" | "assistant") {
            continue;
        }
        let text = value
            .get("message")
            .and_then(|message| message.get("content"))
            .map(text_content)
            .unwrap_or_default();
        if text.is_empty() {
            continue;
        }
        if let Some(found) = value.get("sessionId").and_then(serde_json::Value::as_str) {
            session_id = found.to_string();
        }
        if cwd.is_none() {
            cwd = value
                .get("cwd")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
        }
        let key = value
            .get("message")
            .and_then(|message| message.get("id"))
            .or_else(|| value.get("uuid"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("line-{}", messages.len()));
        let usage = value.get("message").map(claude_usage).unwrap_or_default();
        if let Some(index) = positions.get(&key).copied() {
            let existing = &mut messages[index];
            if !existing.text.contains(&text) {
                existing.text.push_str("\n\n");
                existing.text.push_str(&text);
            }
            if !usage.is_empty() {
                existing.usage = usage;
            }
            continue;
        }
        positions.insert(key, messages.len());
        messages.push(ImportedMessage {
            role: role.to_string(),
            text,
            at: value
                .get("timestamp")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            model: value
                .get("message")
                .and_then(|message| message.get("model"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("claude")
                .to_string(),
            usage,
        });
    }
    let title = title_from(&messages, "Imported Claude chat");
    Ok(ImportedChat {
        source: "claude-code".into(),
        session_id,
        title,
        cwd,
        messages,
        originator: String::new(),
    })
}

fn codex_usage(value: &serde_json::Value) -> String {
    let Some(info) = value.get("info") else {
        return String::new();
    };
    let Some(last) = info.get("last_token_usage") else {
        return String::new();
    };
    let count = |key: &str| last.get(key).and_then(serde_json::Value::as_u64);
    let input = count("input_tokens");
    let cache_reads = count("cached_input_tokens");
    let cache_writes = count("cache_write_input_tokens");
    let uncached = input.map(|tokens| {
        tokens.saturating_sub(
            cache_reads
                .unwrap_or(0)
                .saturating_add(cache_writes.unwrap_or(0)),
        )
    });
    let output = count("output_tokens");
    let tokens = count("total_tokens").unwrap_or_else(|| {
        uncached.unwrap_or(0)
            + cache_reads.unwrap_or(0)
            + cache_writes.unwrap_or(0)
            + output.unwrap_or(0)
    });
    serde_json::json!({
        "tokens": tokens,
        "inputTokens": uncached,
        "outputTokens": output,
        "contextTokens": info
            .get("total_token_usage")
            .and_then(|usage| usage.get("total_tokens"))
            .and_then(serde_json::Value::as_u64),
        "contextWindow": info.get("model_context_window").and_then(serde_json::Value::as_u64),
        "cacheReads": cache_reads,
        "cacheWrites": cache_writes,
        "reasoningTokens": count("reasoning_output_tokens"),
        "costUsd": null,
        "premiumRequests": null,
        "durationMs": null
    })
    .to_string()
}

fn parse_codex(path: &Path) -> Result<ImportedChat, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut messages = Vec::new();
    let mut fallback_messages = Vec::new();
    let mut session_id = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("unknown")
        .to_string();
    let mut cwd = None;
    let mut originator = String::new();
    let mut current_model = "codex".to_string();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(serde_json::Value::as_str) == Some("session_meta") {
            if let Some(found) = value
                .get("payload")
                .and_then(|payload| payload.get("id").or_else(|| payload.get("session_id")))
                .and_then(serde_json::Value::as_str)
            {
                session_id = found.to_string();
            }
            cwd = value
                .get("payload")
                .and_then(|payload| payload.get("cwd"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            originator = value
                .get("payload")
                .and_then(|payload| payload.get("originator"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string();
            continue;
        }
        if value.get("type").and_then(serde_json::Value::as_str) == Some("turn_context") {
            if let Some(model) = value
                .get("payload")
                .and_then(|payload| payload.get("model"))
                .and_then(serde_json::Value::as_str)
                .filter(|model| !model.is_empty())
            {
                current_model = model.to_string();
            }
            continue;
        }
        if value.get("type").and_then(serde_json::Value::as_str) == Some("event_msg") {
            let payload = &value["payload"];
            let kind = payload
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if matches!(kind, "user_message" | "agent_message") {
                let text = payload
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !text.is_empty() {
                    messages.push(ImportedMessage {
                        role: if kind == "agent_message" {
                            "assistant".into()
                        } else {
                            "user".into()
                        },
                        text,
                        at: value
                            .get("timestamp")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        model: current_model.clone(),
                        usage: String::new(),
                    });
                }
            } else if kind == "token_count"
                && let Some(message) = messages
                    .iter_mut()
                    .rev()
                    .find(|message| message.role == "assistant")
            {
                message.usage = codex_usage(payload);
            }
            continue;
        }
        if value.get("type").and_then(serde_json::Value::as_str) != Some("response_item")
            || value
                .get("payload")
                .and_then(|payload| payload.get("type"))
                .and_then(serde_json::Value::as_str)
                != Some("message")
        {
            continue;
        }
        let payload = &value["payload"];
        let role = payload
            .get("role")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if !matches!(role, "user" | "assistant") {
            continue;
        }
        let text = payload.get("content").map(text_content).unwrap_or_default();
        if text.is_empty() {
            continue;
        }
        fallback_messages.push(ImportedMessage {
            role: role.to_string(),
            text,
            at: value
                .get("timestamp")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            model: current_model.clone(),
            usage: String::new(),
        });
    }
    // Modern rollouts persist the exact visible UI messages as events. They
    // exclude the developer/environment payloads that response records carry.
    // Older rollouts without those events retain the response-item fallback.
    if messages.is_empty() {
        messages = fallback_messages;
    }
    let title = title_from(&messages, "Imported Codex chat");
    Ok(ImportedChat {
        source: "codex".into(),
        session_id,
        title,
        cwd,
        messages,
        originator,
    })
}

fn summary(chat: &ImportedChat) -> SessionSummary {
    SessionSummary {
        id: chat.session_id.clone(),
        title: chat.title.clone(),
        updated_at: chat
            .messages
            .last()
            .map(|message| message.at.clone())
            .unwrap_or_default(),
        messages: chat.messages.len(),
        importable: !chat.messages.is_empty(),
    }
}

fn status_for_jsonl(source: &str, label: &str, root: PathBuf) -> SourceStatus {
    if !root.is_dir() {
        return SourceStatus {
            source: source.into(),
            label: label.into(),
            available: false,
            note: format!("No local store at {}", root.display()),
            sessions: Vec::new(),
        };
    }
    let parser = if source == "codex" {
        parse_codex
    } else {
        parse_claude
    };
    let mut sessions: Vec<SessionSummary> = collect(&root, "jsonl")
        .into_iter()
        .filter_map(|path| parser(&path).ok())
        .map(|chat| summary(&chat))
        .filter(|chat| chat.importable)
        .take(MAX_VISIBLE_SESSIONS)
        .collect();
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    SourceStatus {
        source: source.into(),
        label: label.into(),
        available: true,
        note: format!("{} importable local session(s)", sessions.len()),
        sessions,
    }
}

/// Identify a Codex rollout without loading its potentially enormous tool and
/// image records. The session metadata and first visible owner message are at
/// the head of modern rollouts; 128 KiB is ample for both and bounds Settings'
/// discovery work independently of session size.
fn summarize_codex(path: &Path) -> Option<(SessionSummary, String)> {
    let file = File::open(path).ok()?;
    let mut session_id = path.file_stem()?.to_str()?.to_string();
    let mut originator = String::new();
    let mut updated_at = String::new();
    let mut title = String::new();

    for line in BufReader::new(file)
        .take(CODEX_DISCOVERY_BYTES)
        .lines()
        .map_while(Result::ok)
    {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(serde_json::Value::as_str) == Some("session_meta") {
            let payload = &value["payload"];
            if let Some(id) = payload
                .get("id")
                .or_else(|| payload.get("session_id"))
                .and_then(serde_json::Value::as_str)
            {
                session_id = id.to_string();
            }
            originator = payload
                .get("originator")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string();
            updated_at = value
                .get("timestamp")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string();
            continue;
        }
        if value.get("type").and_then(serde_json::Value::as_str) == Some("event_msg")
            && value
                .get("payload")
                .and_then(|payload| payload.get("type"))
                .and_then(serde_json::Value::as_str)
                == Some("user_message")
        {
            title = value
                .get("payload")
                .and_then(|payload| payload.get("message"))
                .and_then(serde_json::Value::as_str)
                .map(|text| title_from_text(text, "Imported Codex chat"))
                .unwrap_or_default();
            break;
        }
    }
    if title.is_empty() {
        return None;
    }
    Some((
        SessionSummary {
            id: session_id,
            title,
            updated_at,
            // Exact counts require scanning the entire rollout. Discovery is
            // intentionally constant-work; the selected import reads it once.
            messages: 0,
            importable: true,
        },
        originator,
    ))
}

fn codex_statuses(root: PathBuf) -> (SourceStatus, SourceStatus) {
    if !root.is_dir() {
        let unavailable = |source: &str, label: &str| SourceStatus {
            source: source.into(),
            label: label.into(),
            available: false,
            note: format!("No local store at {}", root.display()),
            sessions: Vec::new(),
        };
        return (
            unavailable("chatgpt-desktop", "ChatGPT Desktop · Work/Codex"),
            unavailable("codex", "Codex CLI / IDE"),
        );
    }
    let (desktop, cli): (Vec<_>, Vec<_>) = collect(&root, "jsonl")
        .into_iter()
        .filter_map(|path| summarize_codex(&path))
        .partition(|(_, originator)| originator == "Codex Desktop");
    let finish = |source: &str, label: &str, mut found: Vec<(SessionSummary, String)>| {
        found.sort_by(|left, right| right.0.updated_at.cmp(&left.0.updated_at));
        let sessions: Vec<_> = found
            .into_iter()
            .map(|(summary, _)| summary)
            .take(MAX_VISIBLE_SESSIONS)
            .collect();
        SourceStatus {
            source: source.into(),
            label: label.into(),
            available: true,
            note: format!(
                "{} local session(s); message counts load only for the selected import",
                sessions.len()
            ),
            sessions,
        }
    };
    (
        finish("chatgpt-desktop", "ChatGPT Desktop · Work/Codex", desktop),
        finish("codex", "Codex CLI / IDE", cli),
    )
}

fn claude_desktop_status(home: &Path) -> SourceStatus {
    let root = home.join("Library/Application Support/Claude/claude-code-sessions");
    if !root.is_dir() {
        return SourceStatus {
            source: "claude-desktop".into(),
            label: "Claude Desktop".into(),
            available: false,
            note: "No local-agent session index found; cloud chats remain in opaque IndexedDB"
                .into(),
            sessions: Vec::new(),
        };
    }
    let mut sessions = Vec::new();
    for path in collect(&root, "json")
        .into_iter()
        .take(MAX_VISIBLE_SESSIONS)
    {
        let Ok(raw) = std::fs::read_to_string(path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(id) = value.get("sessionId").and_then(serde_json::Value::as_str) else {
            continue;
        };
        sessions.push(SessionSummary {
            id: id.to_string(),
            title: value
                .get("title")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("Claude Desktop local session")
                .to_string(),
            updated_at: value
                .get("lastActivityAt")
                .and_then(serde_json::Value::as_i64)
                .and_then(chrono::DateTime::from_timestamp_millis)
                .map(|at| at.to_rfc3339())
                .unwrap_or_default(),
            messages: value
                .get("completedTurns")
                .and_then(serde_json::Value::as_u64)
                .and_then(|count| usize::try_from(count.saturating_mul(2)).ok())
                .unwrap_or(0),
            importable: value
                .get("cliSessionId")
                .and_then(serde_json::Value::as_str)
                .is_some(),
        });
    }
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    SourceStatus {
        source: "claude-desktop".into(),
        label: "Claude Desktop".into(),
        available: true,
        note: "Local-agent chats are importable; cloud-only chats remain in opaque IndexedDB"
            .into(),
        sessions,
    }
}

pub fn discover() -> Result<Vec<SourceStatus>, String> {
    let home = home()?;
    let claude_code = status_for_jsonl("claude-code", "Claude Code", home.join(".claude/projects"));
    let codex_root = home.join(".codex/sessions");
    let (chatgpt_desktop, codex) = codex_statuses(codex_root);
    let claude_desktop = claude_desktop_status(&home);
    Ok(vec![claude_desktop, claude_code, chatgpt_desktop, codex])
}

/// The working directory a Claude Code session was recorded in.
///
/// Claude Code scopes a session to the directory it was created in: resuming
/// from anywhere else answers `No conversation found with session ID`, which
/// fails the turn outright rather than starting a fresh one. The transcript
/// records the directory on every line, so the session itself is the authority
/// on where it can be resumed.
///
/// `None` when no transcript exists or it names no directory, which callers
/// must read as "resume wherever the project would have run anyway" rather
/// than as an error.
#[must_use]
pub fn claude_session_cwd(session_id: &str) -> Option<String> {
    let home = home().ok()?;
    let transcript = find_session(&home.join(".claude/projects"), "jsonl", session_id)?;
    let file = std::fs::File::open(transcript).ok()?;
    // The first line that names one wins: a session cannot move, and reading
    // the whole transcript to answer this would cost megabytes per run.
    for line in std::io::BufRead::lines(std::io::BufReader::new(file)).take(64) {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let cwd = value
            .get("cwd")
            .or_else(|| value.get("payload").and_then(|payload| payload.get("cwd")))
            .and_then(serde_json::Value::as_str);
        if let Some(cwd) = cwd.filter(|cwd| !cwd.is_empty()) {
            return Some(cwd.to_string());
        }
    }
    None
}

fn find_session(root: &Path, extension: &str, id: &str) -> Option<PathBuf> {
    collect(root, extension).into_iter().find(|path| {
        path.file_stem()
            .and_then(|value| value.to_str())
            .is_some_and(|stem| stem == id || stem.ends_with(id))
    })
}

fn find_json_value(root: &Path, key: &str, expected: &str) -> Option<PathBuf> {
    collect(root, "json").into_iter().find(|path| {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|value| {
                value
                    .get(key)
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
            .is_some_and(|value| value == expected)
    })
}

pub fn load(source: &str, id: &str) -> Result<ImportedChat, String> {
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("invalid session id".into());
    }
    let home = home()?;
    match source {
        "claude-code" => {
            let root = home.join(".claude/projects");
            let path = find_session(&root, "jsonl", id)
                .ok_or_else(|| format!("Claude Code session {id} was not found"))?;
            parse_claude(&path)
        }
        "codex" => {
            let root = home.join(".codex/sessions");
            let path = find_session(&root, "jsonl", id)
                .ok_or_else(|| format!("Codex session {id} was not found"))?;
            parse_codex(&path)
        }
        "chatgpt-desktop" => {
            let root = home.join(".codex/sessions");
            let path = find_session(&root, "jsonl", id)
                .ok_or_else(|| format!("ChatGPT Desktop session {id} was not found"))?;
            let mut chat = parse_codex(&path)?;
            if chat.originator != "Codex Desktop" {
                return Err("the selected session was not created by ChatGPT Desktop".into());
            }
            chat.source = "chatgpt-desktop".into();
            Ok(chat)
        }
        "claude-desktop" => {
            let metadata_root =
                home.join("Library/Application Support/Claude/claude-code-sessions");
            let metadata = find_json_value(&metadata_root, "sessionId", id)
                .ok_or_else(|| format!("Claude Desktop session {id} was not found"))?;
            let raw = std::fs::read_to_string(metadata).map_err(|error| error.to_string())?;
            let value: serde_json::Value =
                serde_json::from_str(&raw).map_err(|error| error.to_string())?;
            let cli_id = value
                .get("cliSessionId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    "this Claude Desktop chat has no local CLI transcript".to_string()
                })?;
            let transcript = find_session(&home.join(".claude/projects"), "jsonl", cli_id)
                .ok_or_else(|| format!("Claude CLI transcript {cli_id} was not found"))?;
            let mut chat = parse_claude(&transcript)?;
            chat.source = "claude-desktop".into();
            chat.title = value
                .get("title")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(&chat.title)
                .to_string();
            Ok(chat)
        }
        _ => Err(format!("unknown chat source {source}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_extracts_only_human_visible_text_blocks() {
        let value = serde_json::json!([
            {"type": "thinking", "text": "secret"},
            {"type": "text", "text": "visible"},
            {"type": "tool_result", "content": "noise"},
            {"type": "output_text", "text": "answer"}
        ]);
        assert_eq!(text_content(&value), "visible\n\nanswer");
    }

    #[test]
    fn session_ids_cannot_escape_the_allowlisted_roots() {
        assert!(load("codex", "../../etc/passwd").is_err());
    }

    #[test]
    fn claude_blocks_are_grouped_into_one_visible_agent_message() {
        let dir = std::env::temp_dir().join(format!("az-claude-import-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("session-1.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"uuid\":\"u1\",\"sessionId\":\"session-1\",\"timestamp\":\"2026-08-07T00:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n",
                "{\"type\":\"assistant\",\"sessionId\":\"session-1\",\"timestamp\":\"2026-08-07T00:00:01Z\",\"message\":{\"id\":\"a1\",\"role\":\"assistant\",\"model\":\"opus\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"hidden\"}]}}\n",
                "{\"type\":\"assistant\",\"sessionId\":\"session-1\",\"timestamp\":\"2026-08-07T00:00:01Z\",\"message\":{\"id\":\"a1\",\"role\":\"assistant\",\"model\":\"opus\",\"content\":[{\"type\":\"text\",\"text\":\"world\"}],\"usage\":{\"input_tokens\":2,\"cache_creation_input_tokens\":100,\"cache_read_input_tokens\":50,\"output_tokens\":8}}}\n"
            ),
        )
        .expect("fixture writes");
        let parsed = parse_claude(&path).expect("fixture parses");
        assert_eq!(parsed.session_id, "session-1");
        assert_eq!(parsed.messages.len(), 2);
        assert_eq!(parsed.messages[1].text, "world");
        let usage: serde_json::Value =
            serde_json::from_str(&parsed.messages[1].usage).expect("usage serializes");
        assert_eq!(usage["inputTokens"], 2);
        assert_eq!(usage["cacheReads"], 50);
        assert_eq!(usage["cacheWrites"], 100);
        assert_eq!(usage["outputTokens"], 8);
        assert_eq!(usage["contextTokens"], 152);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_import_excludes_developer_and_reasoning_records() {
        let dir = std::env::temp_dir().join(format!("az-codex-import-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("rollout-session-2.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"timestamp\":\"2026-08-07T00:00:00Z\",\"payload\":{\"id\":\"session-2\",\"cwd\":\"/tmp\"}}\n",
                "{\"type\":\"response_item\",\"timestamp\":\"2026-08-07T00:00:00Z\",\"payload\":{\"type\":\"message\",\"role\":\"developer\",\"content\":[{\"type\":\"input_text\",\"text\":\"hidden\"}]}}\n",
                "{\"type\":\"response_item\",\"timestamp\":\"2026-08-07T00:00:01Z\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"question\"}]}}\n",
                "{\"type\":\"response_item\",\"timestamp\":\"2026-08-07T00:00:02Z\",\"payload\":{\"type\":\"reasoning\",\"summary\":[]}}\n",
                "{\"type\":\"response_item\",\"timestamp\":\"2026-08-07T00:00:03Z\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"answer\"}]}}\n"
            ),
        )
        .expect("fixture writes");
        let parsed = parse_codex(&path).expect("fixture parses");
        assert_eq!(parsed.session_id, "session-2");
        assert_eq!(parsed.messages.len(), 2);
        assert_eq!(parsed.messages[0].text, "question");
        assert_eq!(parsed.messages[1].text, "answer");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn desktop_import_uses_visible_events_and_keeps_token_metadata() {
        let dir = std::env::temp_dir().join(format!(
            "az-desktop-import-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("scratch creates");
        let path = dir.join("rollout-desktop-session.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"timestamp\":\"2026-08-07T00:00:00Z\",\"payload\":{\"id\":\"desktop-session\",\"cwd\":\"/tmp\",\"originator\":\"Codex Desktop\"}}\n",
                "{\"type\":\"response_item\",\"timestamp\":\"2026-08-07T00:00:00Z\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hidden environment payload\"}]}}\n",
                "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.6-sol\",\"effort\":\"low\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-08-07T00:00:01Z\",\"payload\":{\"type\":\"user_message\",\"message\":\"visible question\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-08-07T00:00:02Z\",\"payload\":{\"type\":\"agent_message\",\"message\":\"visible answer\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-08-07T00:00:03Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":100,\"cached_input_tokens\":60,\"cache_write_input_tokens\":10,\"output_tokens\":20,\"reasoning_output_tokens\":5,\"total_tokens\":120},\"total_token_usage\":{\"total_tokens\":500},\"model_context_window\":258000}}}\n"
            ),
        )
        .expect("fixture writes");

        let parsed = parse_codex(&path).expect("desktop rollout parses");
        assert_eq!(parsed.originator, "Codex Desktop");
        assert_eq!(parsed.messages.len(), 2);
        assert_eq!(parsed.messages[0].text, "visible question");
        assert_eq!(parsed.messages[1].text, "visible answer");
        assert_eq!(parsed.messages[1].model, "gpt-5.6-sol");
        assert!(
            !parsed
                .messages
                .iter()
                .any(|message| message.text.contains("hidden"))
        );
        let usage: serde_json::Value =
            serde_json::from_str(&parsed.messages[1].usage).expect("usage serializes");
        assert_eq!(usage["inputTokens"], 30);
        assert_eq!(usage["cacheReads"], 60);
        assert_eq!(usage["cacheWrites"], 10);
        assert_eq!(usage["contextTokens"], 500);
        assert_eq!(usage["contextWindow"], 258_000);

        let (summary, originator) = summarize_codex(&path).expect("desktop preview exists");
        assert_eq!(originator, "Codex Desktop");
        assert_eq!(summary.id, "desktop-session");
        assert_eq!(summary.title, "visible question");
        assert_eq!(
            summary.messages, 0,
            "discovery does not scan the whole file"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
