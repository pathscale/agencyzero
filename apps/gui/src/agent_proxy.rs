//! AgencyZero's client boundary to the persistent AgencyProxy daemon.
//!
//! No provider process is launched here. This module starts or reconnects to
//! the small sidecar and translates its versioned wire events into the legacy
//! normalized event vocabulary while the rest of the GUI is migrated.

use agency_proxy_client::Client;
use agency_proxy_protocol::{
    ApprovalDecision, ClientMessage, ProviderAccountUsage, ProviderStatus, RunEvent, RunId,
    RunRequest, ServerFrame, ServerResponse,
};
use agent_abstraction::{Decision, Event, Outcome};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tokio::sync::{Mutex, broadcast};

static RUN_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
pub struct AgencyProxy {
    socket_path: PathBuf,
    configured_binary: std::sync::RwLock<Option<PathBuf>>,
    start_gate: Mutex<()>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub connected: bool,
    pub active_runs: usize,
    pub retained_runs: usize,
    pub binary: String,
    pub socket: String,
}

impl AgencyProxy {
    #[must_use]
    pub fn new(config_dir: &Path, configured_binary: Option<PathBuf>) -> Self {
        Self {
            socket_path: config_dir.join("agency-proxy/runtime.sock"),
            configured_binary: std::sync::RwLock::new(configured_binary),
            start_gate: Mutex::new(()),
        }
    }

    pub async fn start(
        &self,
        request: RunRequest,
        existing_run_id: Option<RunId>,
        after_sequence: u64,
    ) -> Result<ProxyRun, String> {
        let client = self.connect().await?;
        let events = client.subscribe();
        let run_id = existing_run_id.unwrap_or_else(next_run_id);
        match client
            .request(ClientMessage::StartRun {
                run_id: run_id.clone(),
                request: Box::new(request),
                idempotency_key: format!("{}:start", run_id.0),
            })
            .await
            .map_err(|error| error.to_string())?
        {
            ServerResponse::Accepted
            | ServerResponse::Error {
                code: agency_proxy_protocol::ErrorCode::Conflict,
                ..
            } => {}
            response => return Err(response_error(response)),
        }
        match client
            .request(ClientMessage::AttachRun {
                run_id: run_id.clone(),
                after_sequence,
            })
            .await
            .map_err(|error| error.to_string())?
        {
            ServerResponse::Run { .. } => {}
            response => return Err(response_error(response)),
        }
        // The receiver is subscribed before StartRun. Attach's replay and any
        // immediately following live events therefore cannot fall into a gap.
        Ok(ProxyRun {
            client,
            events,
            run_id,
            latest_sequence: after_sequence,
            terminal: None,
        })
    }

    pub async fn run(&self, request: RunRequest) -> Result<Outcome, String> {
        let mut run = self.start(request, None, 0).await?;
        while run.recv().await.is_some() {}
        run.finish().await
    }

    pub async fn list_runs(&self) -> Result<Vec<agency_proxy_protocol::RunSnapshot>, String> {
        match self
            .connect()
            .await?
            .request(ClientMessage::ListRuns)
            .await
            .map_err(|error| error.to_string())?
        {
            ServerResponse::Runs { runs } => Ok(runs),
            response => Err(response_error(response)),
        }
    }

    pub async fn status(&self) -> Result<Status, String> {
        let runs = self.list_runs().await?;
        Ok(Status {
            connected: true,
            active_runs: runs.iter().filter(|run| run_is_active(&run.state)).count(),
            retained_runs: runs.len(),
            binary: proxy_binary(
                self.configured_binary
                    .read()
                    .map_err(|_| "AgencyProxy configuration is unavailable".to_string())?
                    .as_deref(),
            )?
            .to_string_lossy()
            .into_owned(),
            socket: self.socket_path.to_string_lossy().into_owned(),
        })
    }

    /// Stop an idle daemon and immediately launch the selected binary.
    pub async fn restart_if_idle(
        &self,
        configured_binary: Option<PathBuf>,
    ) -> Result<Status, String> {
        let client = self.connect().await?;
        match client
            .request(ClientMessage::ShutdownIfIdle)
            .await
            .map_err(|error| error.to_string())?
        {
            ServerResponse::Accepted => {}
            response => return Err(response_error(response)),
        }
        drop(client);
        *self
            .configured_binary
            .write()
            .map_err(|_| "AgencyProxy configuration is unavailable".to_string())? =
            configured_binary;

        // The shutdown acknowledgement precedes the accept loop releasing its
        // socket. Wait for that exact endpoint to close before `connect`
        // performs the ordinary lazy spawn; otherwise it can reconnect to the
        // daemon that just acknowledged its own shutdown.
        for _ in 0..50 {
            if tokio::net::UnixStream::connect(&self.socket_path)
                .await
                .is_err()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.status().await
    }

    pub async fn probe_providers(&self) -> Result<Vec<ProviderStatus>, String> {
        match self
            .connect()
            .await?
            .request(ClientMessage::ProbeProviders)
            .await
            .map_err(|error| error.to_string())?
        {
            ServerResponse::Providers { providers } => Ok(providers),
            response => Err(response_error(response)),
        }
    }

    pub async fn account_usage(&self) -> Result<Vec<ProviderAccountUsage>, String> {
        match self
            .connect()
            .await?
            .request(ClientMessage::ReadAccountUsage)
            .await
            .map_err(|error| error.to_string())?
        {
            ServerResponse::AccountUsage { providers } => Ok(providers),
            response => Err(response_error(response)),
        }
    }

    async fn connect(&self) -> Result<Client, String> {
        if let Ok(client) = Client::connect(&self.socket_path).await {
            return Ok(client);
        }
        let _gate = self.start_gate.lock().await;
        if let Ok(client) = Client::connect(&self.socket_path).await {
            return Ok(client);
        }
        let configured_binary = self
            .configured_binary
            .read()
            .map_err(|_| "AgencyProxy configuration is unavailable".to_string())?
            .clone();
        let binary = proxy_binary(configured_binary.as_deref())?;
        if let Some(parent) = self.socket_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!("could not create AgencyProxy runtime directory: {error}")
            })?;
        }
        Command::new(&binary)
            .arg("--socket")
            .arg(&self.socket_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("could not start {}: {error}", binary.display()))?;
        for _ in 0..50 {
            match Client::connect(&self.socket_path).await {
                Ok(client) => return Ok(client),
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
        Err(format!(
            "AgencyProxy did not become ready at {}",
            self.socket_path.display()
        ))
    }
}

fn proxy_binary(configured: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(path) = configured {
        return path
            .is_file()
            .then(|| path.to_path_buf())
            .ok_or_else(|| format!("configured AgencyProxy does not exist: {}", path.display()));
    }
    if let Some(path) = std::env::var_os("AGENCY_PROXY_BIN") {
        return Ok(path.into());
    }
    if let Ok(current) = std::env::current_exe()
        && let Some(parent) = current.parent()
    {
        let bundled = parent.join("agency-proxy");
        if bundled.is_file() {
            return Ok(bundled);
        }
    }
    // Local-development fallback. Release bundles place the pinned sidecar
    // beside az-gui and never use this source-tree path.
    let local = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../agencyproxy/target/debug/agency-proxy");
    if local.is_file() {
        return Ok(local);
    }
    Err("AgencyProxy is not bundled and AGENCY_PROXY_BIN is not set".into())
}

fn next_run_id() -> RunId {
    RunId(format!(
        "run-{}-{}",
        std::process::id(),
        RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))
}

fn accepted(response: ServerResponse) -> Result<(), String> {
    match response {
        ServerResponse::Accepted => Ok(()),
        response => Err(response_error(response)),
    }
}

fn response_error(response: ServerResponse) -> String {
    match response {
        ServerResponse::Error { message, .. } => message,
        response => format!("unexpected AgencyProxy response: {response:?}"),
    }
}

fn run_is_active(state: &agency_proxy_protocol::RunState) -> bool {
    matches!(
        state,
        agency_proxy_protocol::RunState::Starting
            | agency_proxy_protocol::RunState::Running
            | agency_proxy_protocol::RunState::WaitingApproval
            | agency_proxy_protocol::RunState::Finishing
    )
}

#[derive(Clone, Debug)]
pub struct ProxyControl {
    client: Client,
    run_id: RunId,
}

impl ProxyControl {
    pub async fn send(&self, body: &str) -> Result<(), String> {
        accepted(
            self.client
                .request(ClientMessage::InjectMessage {
                    run_id: self.run_id.clone(),
                    body: body.into(),
                    idempotency_key: format!("{}:inject", self.run_id.0),
                })
                .await
                .map_err(|error| error.to_string())?,
        )
    }

    pub async fn respond(&self, approval_id: &str, decision: &Decision) -> Result<(), String> {
        let decision = match decision {
            Decision::Allow => ApprovalDecision::AllowOnce,
            Decision::Deny { .. } => ApprovalDecision::Deny,
            _ => ApprovalDecision::Deny,
        };
        accepted(
            self.client
                .request(ClientMessage::DecideApproval {
                    run_id: self.run_id.clone(),
                    approval_id: approval_id.into(),
                    decision,
                    idempotency_key: format!("{}:approval:{approval_id}", self.run_id.0),
                })
                .await
                .map_err(|error| error.to_string())?,
        )
    }
}

pub struct ProxyRun {
    client: Client,
    events: broadcast::Receiver<ServerFrame>,
    run_id: RunId,
    latest_sequence: u64,
    terminal: Option<Result<Outcome, String>>,
}

impl ProxyRun {
    #[must_use]
    pub fn sequence(&self) -> u64 {
        self.latest_sequence
    }
    #[must_use]
    pub fn control(&self) -> ProxyControl {
        ProxyControl {
            client: self.client.clone(),
            run_id: self.run_id.clone(),
        }
    }

    pub async fn respond(&self, approval_id: &str, decision: &Decision) -> Result<(), String> {
        self.control().respond(approval_id, decision).await
    }

    pub async fn recv(&mut self) -> Option<Event> {
        loop {
            let frame = match self.events.recv().await {
                Ok(frame) => frame,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let _ = self
                        .client
                        .request(ClientMessage::AttachRun {
                            run_id: self.run_id.clone(),
                            after_sequence: self.latest_sequence,
                        })
                        .await;
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    self.terminal = Some(Err("AgencyProxy connection closed".into()));
                    return None;
                }
            };
            let ServerFrame::Event {
                run_id,
                sequence,
                event,
            } = frame
            else {
                continue;
            };
            if run_id != self.run_id || sequence <= self.latest_sequence {
                continue;
            }
            self.latest_sequence = sequence;
            match event {
                RunEvent::Finished(value) => {
                    self.terminal = Some(
                        serde_json::from_value(value)
                            .map_err(|error| format!("invalid AgencyProxy outcome: {error}")),
                    );
                    return None;
                }
                RunEvent::Failed(error) => {
                    self.terminal = Some(Err(error));
                    return None;
                }
                event => match event_from_wire(event) {
                    Ok(Some(event)) => return Some(event),
                    Ok(None) => {}
                    Err(error) => {
                        self.terminal = Some(Err(error));
                        return None;
                    }
                },
            }
        }
    }

    pub async fn finish(mut self) -> Result<Outcome, String> {
        while self.terminal.is_none() {
            let _ = self.recv().await;
        }
        self.terminal
            .take()
            .unwrap_or_else(|| Err("AgencyProxy run ended without an outcome".into()))
    }

    pub async fn cancel(mut self) -> Result<Outcome, String> {
        accepted(
            self.client
                .request(ClientMessage::CancelRun {
                    run_id: self.run_id.clone(),
                    idempotency_key: format!("{}:cancel", self.run_id.0),
                })
                .await
                .map_err(|error| error.to_string())?,
        )?;
        while self.terminal.is_none() {
            let _ = self.recv().await;
        }
        self.terminal
            .take()
            .unwrap_or_else(|| Err("AgencyProxy canceled without a terminal outcome".into()))
    }
}

fn event_from_wire(event: RunEvent) -> Result<Option<Event>, String> {
    let event = match event {
        RunEvent::SessionOpened {
            provider_session_id,
            model,
        } => Event::Started {
            session: provider_session_id,
            model,
        },
        RunEvent::Reasoning(text) => Event::Thinking(text),
        RunEvent::Text(text) => Event::Text(text),
        RunEvent::MessageBoundary => Event::MessageBoundary,
        RunEvent::ToolCall { id, name, input } => Event::ToolCall { id, name, input },
        RunEvent::ToolResult { id, ok, output } => Event::ToolResult { id, ok, output },
        RunEvent::ApprovalRequested {
            approval_id,
            title,
            detail,
        } => Event::ApprovalRequest(decode(
            serde_json::json!({
                "id": approval_id,
                "tool": title,
                "input": detail,
            }),
            "approval request",
        )?),
        RunEvent::Usage(value) => Event::Usage(decode(value, "usage")?),
        RunEvent::RateLimit(value) => Event::RateLimit(decode(value, "rate limit")?),
        RunEvent::Compaction(value) => Event::Compaction(decode(value, "compaction")?),
        RunEvent::Commands(value) => Event::Commands(decode(value, "commands")?),
        RunEvent::StateChanged(_) | RunEvent::Error(_) => return Ok(None),
        RunEvent::Finished(_) | RunEvent::Failed(_) => {
            unreachable!("terminal events handled above")
        }
    };
    Ok(Some(event))
}

fn decode<T: serde::de::DeserializeOwned>(
    value: serde_json::Value,
    kind: &str,
) -> Result<T, String> {
    serde_json::from_value(value).map_err(|error| format!("invalid AgencyProxy {kind}: {error}"))
}
