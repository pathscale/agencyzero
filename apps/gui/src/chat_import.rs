//! Read-only discovery and parsing of local provider transcripts.
//!
//! Provider files are inputs, never stores AgencyZero writes back to. Import
//! resolves an opaque `(source, session id)` against a fixed allowlisted root;
//! the webview cannot supply an arbitrary filesystem path.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde::Serialize;

const MAX_DISCOVERED_FILES: usize = 500;
const MAX_VISIBLE_SESSIONS: usize = 100;

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
}

#[derive(Clone, Debug)]
pub struct ImportedChat {
    pub source: String,
    pub session_id: String,
    pub title: String,
    pub cwd: Option<String>,
    pub messages: Vec<ImportedMessage>,
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
    let title: String = first.chars().take(72).collect();
    if first.chars().count() > 72 {
        format!("{title}…")
    } else if title.is_empty() {
        fallback.to_string()
    } else {
        title
    }
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
        if let Some(index) = positions.get(&key).copied() {
            let existing = &mut messages[index];
            if !existing.text.contains(&text) {
                existing.text.push_str("\n\n");
                existing.text.push_str(&text);
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
        });
    }
    let title = title_from(&messages, "Imported Claude chat");
    Ok(ImportedChat {
        source: "claude-code".into(),
        session_id,
        title,
        cwd,
        messages,
    })
}

fn parse_codex(path: &Path) -> Result<ImportedChat, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut messages = Vec::new();
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
        messages.push(ImportedMessage {
            role: role.to_string(),
            text,
            at: value
                .get("timestamp")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string(),
            model: "codex".into(),
        });
    }
    let title = title_from(&messages, "Imported Codex chat");
    Ok(ImportedChat {
        source: "codex".into(),
        session_id,
        title,
        cwd,
        messages,
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
    let codex = status_for_jsonl("codex", "Codex", home.join(".codex/sessions"));
    let claude_desktop = claude_desktop_status(&home);
    let openai_root = home.join("Library/Application Support/ChatGPT");
    let openai_desktop = SourceStatus {
        source: "openai-desktop".into(),
        label: "OpenAI Desktop".into(),
        available: openai_root.is_dir(),
        note: if openai_root.is_dir() {
            "The installed desktop store exposes no stable local transcript format".into()
        } else {
            format!("No local store at {}", openai_root.display())
        },
        sessions: Vec::new(),
    };
    Ok(vec![claude_desktop, claude_code, openai_desktop, codex])
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
        "openai-desktop" => Err(
            "OpenAI Desktop exposes no stable local transcript format on this installation".into(),
        ),
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
                "{\"type\":\"assistant\",\"sessionId\":\"session-1\",\"timestamp\":\"2026-08-07T00:00:01Z\",\"message\":{\"id\":\"a1\",\"role\":\"assistant\",\"model\":\"opus\",\"content\":[{\"type\":\"text\",\"text\":\"world\"}]}}\n"
            ),
        )
        .expect("fixture writes");
        let parsed = parse_claude(&path).expect("fixture parses");
        assert_eq!(parsed.session_id, "session-1");
        assert_eq!(parsed.messages.len(), 2);
        assert_eq!(parsed.messages[1].text, "world");
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
}
