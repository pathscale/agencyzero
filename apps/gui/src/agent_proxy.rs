//! AgencyZero's client boundary to the persistent AgencyProxy daemon.
//!
//! No provider process is launched here. This module starts or reconnects to
//! the small sidecar and translates its versioned wire events into the legacy
//! normalized event vocabulary while the rest of the GUI is migrated.

use agency_proxy_client::Client;
use agency_proxy_protocol::{
    ApprovalDecision, ClientMessage, ErrorCode, ProviderAccountUsage, ProviderStatus, RunEvent,
    RunId, RunRequest, ServerFrame, ServerResponse, ShutdownMode,
};
use agent_abstraction::{Decision, Event, Outcome};
use serde::Serialize;
use std::{
    fs::OpenOptions,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, broadcast};

static RUN_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
enum ConnectionState {
    Cold,
    Live,
    Crashed,
    Stopped,
}

impl ConnectionState {
    fn from_raw(value: u8) -> Self {
        match value {
            1 => Self::Live,
            2 => Self::Crashed,
            3 => Self::Stopped,
            _ => Self::Cold,
        }
    }

    fn may_spawn(self) -> bool {
        self == Self::Cold
    }
}

#[derive(Debug)]
pub struct AgencyProxy {
    socket_path: PathBuf,
    configured_binary: std::sync::RwLock<Option<PathBuf>>,
    start_gate: Mutex<()>,
    connection_state: Arc<AtomicU8>,
    failure_detail: std::sync::RwLock<Option<String>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub connected: bool,
    pub active_runs: usize,
    pub retained_runs: usize,
    pub binary: String,
    pub socket: String,
    pub detail: Option<String>,
}

impl AgencyProxy {
    #[must_use]
    pub fn new(config_dir: &Path, configured_binary: Option<PathBuf>) -> Self {
        Self {
            socket_path: proxy_socket_path(config_dir),
            configured_binary: std::sync::RwLock::new(configured_binary),
            start_gate: Mutex::new(()),
            connection_state: Arc::new(AtomicU8::new(ConnectionState::Cold as u8)),
            failure_detail: std::sync::RwLock::new(None),
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
            connection_state: self.connection_state.clone(),
        })
    }

    pub async fn run(&self, request: RunRequest) -> Result<Outcome, String> {
        let mut run = self.start(request, None, 0).await?;
        let acknowledgement = run.control();
        while run.recv().await.is_some() {}
        let outcome = run.finish().await;
        // Journal release is cleanup, not the provider outcome. A transient
        // control-plane failure here must not turn a successful one-shot run
        // into a failed review or compaction after its answer already landed.
        if let Err(error) = acknowledgement.acknowledge_all().await {
            crate::log!(
                crate::log::Level::Warn,
                "run",
                "could not release one-shot proxy journal {}: {error}",
                acknowledgement.run_id.0
            );
        }
        outcome
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

    pub async fn acknowledge(&self, run_id: &RunId, through_sequence: u64) -> Result<(), String> {
        accepted(
            self.connect()
                .await?
                .request(ClientMessage::AckEvents {
                    run_id: run_id.clone(),
                    through_sequence,
                })
                .await
                .map_err(|error| error.to_string())?,
        )
    }

    pub async fn status(&self) -> Result<Status, String> {
        match self.list_runs().await {
            Ok(runs) => self.status_with_runs(runs),
            Err(error)
                if matches!(
                    self.connection_state(),
                    ConnectionState::Crashed | ConnectionState::Stopped
                ) =>
            {
                self.disconnected_status(error)
            }
            Err(error) => Err(error),
        }
    }

    /// Close admission, settle existing runs under the selected policy, and
    /// immediately launch the selected binary once the daemon exits.
    pub async fn restart(
        &self,
        configured_binary: Option<PathBuf>,
        mode: ShutdownMode,
    ) -> Result<Status, String> {
        let existing = if matches!(
            self.connection_state(),
            ConnectionState::Crashed | ConnectionState::Stopped
        ) {
            None
        } else {
            Some(self.connect().await?)
        };
        if let Some(client) = existing {
            if client.version().minor >= 3 {
                match client
                    .request(ClientMessage::Shutdown { mode })
                    .await
                    .map_err(|error| error.to_string())?
                {
                    ServerResponse::Accepted => {}
                    response => return Err(response_error(response)),
                }
            } else {
                shutdown_legacy_proxy(&client, mode).await?;
            }
            self.set_connection_state(ConnectionState::Stopped);
            drop(client);

            // The shutdown acknowledgement precedes the accept loop releasing
            // its socket. Do not launch its replacement until that endpoint
            // has actually closed.
            while tokio::net::UnixStream::connect(&self.socket_path)
                .await
                .is_ok()
            {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        *self
            .configured_binary
            .write()
            .map_err(|_| "AgencyProxy configuration is unavailable".to_string())? =
            configured_binary;
        self.clear_failure();
        self.set_connection_state(ConnectionState::Cold);
        self.status().await
    }

    /// Close admission, let every live run finish, then keep the daemon stopped.
    pub async fn stop(&self) -> Result<Status, String> {
        self.shutdown(ShutdownMode::Drain, "Stopped by user").await
    }

    /// Cancel live runs, close admission, and keep the daemon stopped.
    pub async fn terminate(&self) -> Result<Status, String> {
        if matches!(
            self.connection_state(),
            ConnectionState::Crashed | ConnectionState::Stopped
        ) {
            return self.disconnected_status("Stopped with AgencyZero".into());
        }
        // Quitting both must not start a daemon merely so it can stop it. A
        // cold manager can still attach to a proxy left by an earlier GUI, but
        // an absent socket means there is nothing to terminate.
        if self.connection_state() == ConnectionState::Cold
            && tokio::net::UnixStream::connect(&self.socket_path)
                .await
                .is_err()
        {
            self.set_connection_state(ConnectionState::Stopped);
            return self.disconnected_status("AgencyProxy was not running".into());
        }
        self.shutdown(ShutdownMode::Terminate, "Stopped with AgencyZero")
            .await
    }

    async fn shutdown(&self, mode: ShutdownMode, detail: &str) -> Result<Status, String> {
        let client = self.connect().await?;
        if client.version().minor >= 3 {
            match client
                .request(ClientMessage::Shutdown { mode })
                .await
                .map_err(|error| error.to_string())?
            {
                ServerResponse::Accepted => {}
                response => return Err(response_error(response)),
            }
        } else {
            shutdown_legacy_proxy(&client, mode).await?;
        }
        self.set_connection_state(ConnectionState::Stopped);
        drop(client);
        while tokio::net::UnixStream::connect(&self.socket_path)
            .await
            .is_ok()
        {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        self.disconnected_status(detail.into())
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
        match self.connection_state() {
            ConnectionState::Crashed => {
                return Err(self.failure_message());
            }
            ConnectionState::Stopped => {
                return Err("AgencyProxy is stopped; start it from Settings".into());
            }
            ConnectionState::Cold | ConnectionState::Live => {}
        }
        if let Ok(client) = Client::connect(&self.socket_path).await {
            self.clear_failure();
            self.set_connection_state(ConnectionState::Live);
            return Ok(client);
        }
        let _gate = self.start_gate.lock().await;
        let state = self.connection_state();
        match state {
            ConnectionState::Crashed => {
                return Err(self.failure_message());
            }
            ConnectionState::Stopped => {
                return Err("AgencyProxy is stopped; start it from Settings".into());
            }
            ConnectionState::Cold | ConnectionState::Live => {}
        }
        // Another caller may have connected or completed the initial spawn
        // while this one waited for the gate. Re-probe before deciding a
        // previously live daemon has really disappeared.
        if let Ok(client) = Client::connect(&self.socket_path).await {
            self.clear_failure();
            self.set_connection_state(ConnectionState::Live);
            return Ok(client);
        }
        if state == ConnectionState::Live {
            return Err(self.record_failure(
                "AgencyProxy stopped unexpectedly; start it from Settings".into(),
            ));
        }
        debug_assert!(state.may_spawn());
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
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).map_err(
                    |error| format!("could not secure AgencyProxy runtime directory: {error}"),
                )?;
            }
        }
        let output_path = self.socket_path.with_file_name("agency-proxy.log");
        let captured = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&output_path)
            .ok();
        let mut command = Command::new(&binary);
        command
            .arg("--socket")
            .arg(&self.socket_path)
            .stdin(Stdio::null());
        if let Some(stderr) = captured {
            command.stdout(
                stderr
                    .try_clone()
                    .map_or_else(|_| Stdio::null(), Stdio::from),
            );
            command.stderr(Stdio::from(stderr));
        } else {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
        if let Err(error) = command.spawn() {
            return Err(
                self.record_failure(format!("could not start {}: {error}", binary.display()))
            );
        }
        for _ in 0..50 {
            match Client::connect(&self.socket_path).await {
                Ok(client) => {
                    self.clear_failure();
                    self.set_connection_state(ConnectionState::Live);
                    return Ok(client);
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
        Err(self.record_failure(proxy_startup_failure(&output_path, &self.socket_path)))
    }

    fn connection_state(&self) -> ConnectionState {
        ConnectionState::from_raw(self.connection_state.load(Ordering::Acquire))
    }

    fn set_connection_state(&self, state: ConnectionState) {
        self.connection_state.store(state as u8, Ordering::Release);
    }

    fn record_failure(&self, detail: String) -> String {
        if let Ok(mut stored) = self.failure_detail.write() {
            *stored = Some(detail.clone());
        }
        self.set_connection_state(ConnectionState::Crashed);
        detail
    }

    fn clear_failure(&self) {
        if let Ok(mut stored) = self.failure_detail.write() {
            *stored = None;
        }
    }

    fn failure_message(&self) -> String {
        self.failure_detail
            .read()
            .ok()
            .and_then(|stored| stored.clone())
            .unwrap_or_else(|| "AgencyProxy stopped unexpectedly; start it from Settings".into())
    }

    fn status_with_runs(
        &self,
        runs: Vec<agency_proxy_protocol::RunSnapshot>,
    ) -> Result<Status, String> {
        Ok(Status {
            connected: true,
            active_runs: runs.iter().filter(|run| run_is_active(&run.state)).count(),
            retained_runs: runs.len(),
            binary: self.binary_name()?,
            socket: self.socket_path.to_string_lossy().into_owned(),
            detail: None,
        })
    }

    fn disconnected_status(&self, detail: String) -> Result<Status, String> {
        Ok(Status {
            connected: false,
            active_runs: 0,
            retained_runs: 0,
            // A stopped or absent daemon does not need a runnable binary. In
            // particular, Quit Both must succeed when there was no sidecar to
            // terminate and a development checkout has not built one yet.
            binary: self.binary_name().unwrap_or_else(|_| "AgencyProxy".into()),
            socket: self.socket_path.to_string_lossy().into_owned(),
            detail: Some(detail),
        })
    }

    fn binary_name(&self) -> Result<String, String> {
        Ok(proxy_binary(
            self.configured_binary
                .read()
                .map_err(|_| "AgencyProxy configuration is unavailable".to_string())?
                .as_deref(),
        )?
        .to_string_lossy()
        .into_owned())
    }
}

/// Keep the readable per-profile path when Unix can carry it. macOS caps a
/// Unix-domain socket pathname at 103 bytes plus its terminator, which the
/// Experimental bundle id exceeds under `~/Library/Application Support`.
/// Only that overlong case moves to a deterministic owner-only temp directory,
/// so existing System and Dev daemons keep their established endpoints.
fn proxy_socket_path(config_dir: &Path) -> PathBuf {
    const SAFE_SOCKET_BYTES: usize = 100;

    let direct = config_dir.join("agency-proxy/runtime.sock");
    if direct.as_os_str().as_encoded_bytes().len() <= SAFE_SOCKET_BYTES {
        return direct;
    }

    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in config_dir.as_os_str().as_encoded_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    std::env::temp_dir()
        .join(format!("azp-{hash:016x}"))
        .join("runtime.sock")
}

fn proxy_startup_failure(output_path: &Path, socket_path: &Path) -> String {
    let base = format!(
        "AgencyProxy did not become ready at {}",
        socket_path.display()
    );
    let Ok(output) = std::fs::read_to_string(output_path) else {
        return base;
    };
    let output = output.trim();
    if output.is_empty() {
        base
    } else {
        format!("{base}: {output}")
    }
}

/// Upgrade an already-running v0.2 daemon without sending it a message it
/// cannot decode. The old protocol cannot close admission while runs drain,
/// so `ShutdownIfIdle` is retried until its own atomic idle check succeeds.
async fn shutdown_legacy_proxy(client: &Client, mode: ShutdownMode) -> Result<(), String> {
    if mode == ShutdownMode::Terminate {
        let runs = match client
            .request(ClientMessage::ListRuns)
            .await
            .map_err(|error| error.to_string())?
        {
            ServerResponse::Runs { runs } => runs,
            response => return Err(response_error(response)),
        };
        for run in runs.into_iter().filter(|run| run_is_active(&run.state)) {
            match client
                .request(ClientMessage::CancelRun {
                    idempotency_key: format!("{}:restart", run.run_id.0),
                    run_id: run.run_id,
                })
                .await
                .map_err(|error| error.to_string())?
            {
                ServerResponse::Accepted
                | ServerResponse::Error {
                    code: ErrorCode::Conflict | ErrorCode::NotFound,
                    ..
                } => {}
                response => return Err(response_error(response)),
            }
        }
    }

    loop {
        match client
            .request(ClientMessage::ShutdownIfIdle)
            .await
            .map_err(|error| error.to_string())?
        {
            ServerResponse::Accepted => return Ok(()),
            ServerResponse::Error {
                code: ErrorCode::Conflict,
                ..
            } => tokio::time::sleep(Duration::from_millis(100)).await,
            response => return Err(response_error(response)),
        }
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
    pub async fn acknowledge(&self, through_sequence: u64) -> Result<(), String> {
        accepted(
            self.client
                .request(ClientMessage::AckEvents {
                    run_id: self.run_id.clone(),
                    through_sequence,
                })
                .await
                .map_err(|error| error.to_string())?,
        )
    }

    pub async fn acknowledge_all(&self) -> Result<(), String> {
        self.acknowledge(u64::MAX).await
    }

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
    connection_state: Arc<AtomicU8>,
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
                    self.connection_state
                        .store(ConnectionState::Crashed as u8, Ordering::Release);
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

#[cfg(test)]
mod tests {
    use super::{AgencyProxy, ConnectionState, proxy_socket_path, proxy_startup_failure};
    use std::path::Path;

    #[test]
    fn only_a_cold_proxy_may_be_started_automatically() {
        assert!(ConnectionState::Cold.may_spawn());
        assert!(!ConnectionState::Live.may_spawn());
        assert!(!ConnectionState::Crashed.may_spawn());
        assert!(!ConnectionState::Stopped.may_spawn());
    }

    #[test]
    fn a_crash_keeps_the_specific_failure_for_settings_and_later_calls() {
        let proxy = AgencyProxy::new(Path::new("/tmp/agency-proxy-failure-detail"), None);
        proxy.record_failure("socket bind failed: operation not permitted".into());
        assert_eq!(
            proxy.failure_message(),
            "socket bind failed: operation not permitted"
        );
    }

    #[tokio::test]
    async fn terminating_an_absent_proxy_does_not_start_one() {
        let dir = std::env::temp_dir().join(format!(
            "agency-proxy-absent-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        std::fs::create_dir_all(&dir).expect("create temp directory");
        let proxy = AgencyProxy::new(&dir, None);

        let status = proxy
            .terminate()
            .await
            .expect("absent proxy is already stopped");

        assert!(!status.connected);
        assert_eq!(proxy.connection_state(), ConnectionState::Stopped);
        assert!(!proxy.socket_path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn startup_failure_includes_the_sidecars_captured_error() {
        let dir =
            std::env::temp_dir().join(format!("agency-proxy-startup-error-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp directory");
        let output = dir.join("agency-proxy.log");
        std::fs::write(&output, "could not bind socket: operation not permitted\n")
            .expect("write captured output");

        let message = proxy_startup_failure(&output, &dir.join("runtime.sock"));
        assert!(message.contains("did not become ready"));
        assert!(message.contains("operation not permitted"));
    }

    #[test]
    fn a_short_profile_keeps_its_readable_socket_path() {
        let config = Path::new("/tmp/agencyzero-dev");
        assert_eq!(
            proxy_socket_path(config),
            config.join("agency-proxy/runtime.sock")
        );
    }

    #[test]
    fn an_overlong_profile_gets_a_short_stable_distinct_socket_path() {
        let experimental = Path::new(
            "/Users/example/Library/Application Support/com.pathscale.agencyzero.experimental",
        );
        let another = Path::new(
            "/Users/example/Library/Application Support/com.pathscale.agencyzero.experimental-two",
        );
        let first = proxy_socket_path(experimental);

        assert_eq!(first, proxy_socket_path(experimental));
        assert_ne!(first, proxy_socket_path(another));
        assert!(first.as_os_str().as_encoded_bytes().len() <= 100);
        assert_eq!(
            first.file_name().and_then(|name| name.to_str()),
            Some("runtime.sock")
        );
    }
}
