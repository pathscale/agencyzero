//! AgencyZero's client boundary to the persistent AgencyProxy daemon.
//!
//! No provider process is launched here. This module starts or reconnects to
//! the small sidecar and translates its versioned wire events into the legacy
//! normalized event vocabulary while the rest of the GUI is migrated.

use agency_proxy_client::Client;
use agency_proxy_protocol::{
    ApprovalDecision, ClientMessage, ErrorCode, ProviderAccountUsage, ProviderStatus, RunEvent,
    RunId, RunRequest, RunSnapshot, ServerFrame, ServerResponse, ShutdownMode,
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

    /// Interrupt a provider-owned turn by its native session id.
    ///
    /// This is deliberately independent of the proxy run journal. A crashed
    /// GUI or daemon can lose the AgencyProxy run id while Codex still owns an
    /// active turn, which is exactly the state Project Reset must repair.
    pub async fn interrupt_session(
        &self,
        provider: &str,
        session_id: &str,
    ) -> Result<bool, String> {
        let mut client = self.connect().await?;
        if client.version().minor < 4 {
            // A daemon may outlive the GUI that launched it. Protocol 0.3 has
            // no InterruptSession variant, so sending one closes the socket
            // instead of repairing the conversation. Reset is already an
            // explicit force operation: replace that legacy daemon with the
            // configured/bundled binary, then issue the new request.
            drop(client);
            let configured_binary = self
                .configured_binary
                .read()
                .map_err(|_| "AgencyProxy configuration is unavailable".to_string())?
                .clone();
            self.restart(configured_binary, ShutdownMode::Terminate)
                .await?;
            client = self.connect().await?;
        }
        match client
            .request(ClientMessage::InterruptSession {
                provider: provider.into(),
                session_id: session_id.into(),
                binary: None,
                idempotency_key: format!("{provider}:{session_id}:interrupt"),
            })
            .await
            .map_err(|error| error.to_string())?
        {
            ServerResponse::SessionInterrupted { interrupted } => Ok(interrupted),
            response => Err(response_error(response)),
        }
    }

    /// Cancel every live daemon run owned by one AgencyZero project and wait
    /// until the daemon confirms that none remains active.
    ///
    /// The GUI's in-memory run slot is not authoritative after a stalled task
    /// or reconnect. Project Reset therefore asks the daemon by project
    /// metadata instead of assuming that removing the local slot stopped the
    /// provider process.
    pub async fn cancel_project_runs(&self, project_id: &str) -> Result<usize, String> {
        let client = self.connect().await?;
        let snapshots = match client
            .request(ClientMessage::ListRuns)
            .await
            .map_err(|error| error.to_string())?
        {
            ServerResponse::Runs { runs } => runs,
            response => return Err(response_error(response)),
        };
        let run_ids = active_project_run_ids(&snapshots, project_id);
        for run_id in &run_ids {
            match client
                .request(ClientMessage::CancelRun {
                    run_id: run_id.clone(),
                    idempotency_key: format!("{}:project-cancel", run_id.0),
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
        if run_ids.is_empty() {
            return Ok(0);
        }

        let deadline = tokio::time::Instant::now() + CANCEL_CONFIRMATION;
        loop {
            let snapshots = match client
                .request(ClientMessage::ListRuns)
                .await
                .map_err(|error| error.to_string())?
            {
                ServerResponse::Runs { runs } => runs,
                response => return Err(response_error(response)),
            };
            let still_active = active_project_run_ids(&snapshots, project_id);
            if still_active.is_empty() {
                return Ok(run_ids.len());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(format!(
                    "AgencyProxy did not stop {} project run(s) within {}s",
                    still_active.len(),
                    CANCEL_CONFIRMATION.as_secs()
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
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

        /*
         * Report the outcome as a status, not as a bare error.
         *
         * `status` only degrades to `disconnected_status` when the state is
         * already `Crashed` or `Stopped`, and the line above has just set
         * `Cold` so the relaunch can spawn. So a relaunch that fails returned
         * `Err` from here, and the Settings panel showed an error while leaving
         * the button reading "Restart": the state the UI needs in order to
         * offer "Start" never arrived, and pressing it again did the same
         * thing. That is the "the proxy died and I could not restart it"
         * report.
         *
         * A failed spawn has already recorded `Crashed` through
         * `record_failure`, so asking again once is enough to turn it into an
         * honest disconnected status carrying the real reason.
         */
        match self.status().await {
            Ok(status) => Ok(status),
            Err(error) => self.disconnected_status(error),
        }
    }

    /// Cancel live runs, close admission, and keep the daemon stopped.
    ///
    /// `Terminate`, not `Drain`. Drain lets every active run "finish
    /// naturally", which is the one thing a wedged run never does: the daemon
    /// stays up, Settings keeps reporting it running, and the owner is left
    /// killing the process by hand. A button labelled Stop has to stop it, and
    /// the runs it is holding are exactly why the owner pressed it.
    pub async fn stop(&self) -> Result<Status, String> {
        self.shutdown(ShutdownMode::Terminate, "Stopped by user")
            .await
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
        // Bounded. This used to spin until the socket refused connections,
        // which is fine when the daemon exits and never returns when it does
        // not: the command that was supposed to stop the proxy hangs instead,
        // and Settings sits on a spinner with no way forward.
        let deadline = std::time::Instant::now() + SHUTDOWN_CONFIRMATION;
        while tokio::net::UnixStream::connect(&self.socket_path)
            .await
            .is_ok()
        {
            if std::time::Instant::now() >= deadline {
                return Err(format!(
                    "AgencyProxy accepted the shutdown but was still listening after {}s; \
                     it may be held by a run that will not end",
                    SHUTDOWN_CONFIRMATION.as_secs()
                ));
            }
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
            // Inferred from a failed connect, not from watching the process.
            // `watch_proxy_child` logs how it actually ended, under `[proxy]`,
            // and that line is the one to read: this one only knows the socket
            // stopped answering. The two can also race, since the watcher
            // thread and this connect attempt are independent.
            return Err(self.record_failure(
                "AgencyProxy stopped unexpectedly; start it from Settings \
                 (the proxy log records how it ended)"
                    .into(),
            ));
        }
        debug_assert!(state.may_spawn());
        let configured_binary = self
            .configured_binary
            .read()
            .map_err(|_| "AgencyProxy configuration is unavailable".to_string())?
            .clone();
        let binary = proxy_binary(configured_binary.as_deref())?;
        // Which proxy is about to run, and how old it is. A daemon outlives the
        // GUI that spawned it, so a rebuilt sidecar and a running one are
        // routinely different builds. Without this, "the fix is in the bundle"
        // and "the fix is in the process answering me" look identical.
        crate::log!(
            crate::log::Level::Info,
            "proxy",
            "spawning {} (source: {}, built {})",
            binary.display(),
            if configured_binary.is_some() {
                "configured"
            } else if std::env::var_os("AGENCY_PROXY_BIN").is_some() {
                "AGENCY_PROXY_BIN"
            } else {
                "bundled beside az-gui"
            },
            std::fs::metadata(&binary)
                .and_then(|meta| meta.modified())
                .map(|at| chrono::DateTime::<chrono::Utc>::from(at).to_rfc3339())
                .unwrap_or_else(|_| "unknown".into())
        );
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
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return Err(
                    self.record_failure(format!("could not start {}: {error}", binary.display()))
                );
            }
        };
        // Watch the child so its death is *observed* rather than inferred.
        //
        // The handle used to be dropped right here. Nothing could then wait on
        // it, so the only evidence the daemon had gone was a later `connect`
        // failing, which is what produces "AgencyProxy stopped unexpectedly"
        // further up. That message is a guess about a process we were the
        // parent of: a segfault, a clean exit and an abort all reach it by the
        // same path and read identically, and none of them writes a crash
        // report for a `Stopped` case. On 2026-08-25 the daemon disappeared
        // mid-session and there was nothing anywhere to say why.
        //
        // A reaped child also stops being a zombie, which is a second thing
        // the dropped handle got wrong.
        watch_proxy_child(child, self.connection_state.clone());
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

/// Describe how a process ended, in the terms the operating system used.
///
/// `ExitStatus`'s own `Display` says "signal: 11 (SIGSEGV)" on Unix and just a
/// code elsewhere, which is close but loses the distinction that matters most
/// here: whether the daemon *chose* to exit. A clean `exit(0)` and a kill are
/// both "it is gone" to a socket, and they call for opposite responses, so the
/// wording separates them explicitly.
#[cfg(unix)]
fn describe_exit(status: std::process::ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;

    if let Some(signal) = status.signal() {
        // SIGKILL is worth naming outright. It cannot be caught or handled, so
        // the daemon had no chance to flush or say anything, and the sender is
        // someone else entirely: the kernel under memory pressure, a crash
        // reporter, or a script. Anything looking for "who killed it" starts
        // here rather than in our own code.
        let name = match signal {
            libc::SIGKILL => " (SIGKILL, uncatchable: sent by the kernel or another process)",
            libc::SIGTERM => " (SIGTERM, a request to stop)",
            libc::SIGSEGV => " (SIGSEGV, a crash)",
            libc::SIGBUS => " (SIGBUS, a crash)",
            libc::SIGABRT => " (SIGABRT, an abort or panic)",
            libc::SIGPIPE => " (SIGPIPE, wrote to a closed socket)",
            _ => "",
        };
        let core = if status.core_dumped() {
            ", core dumped"
        } else {
            ""
        };
        return format!("killed by signal {signal}{name}{core}");
    }
    match status.code() {
        Some(0) => "exited cleanly with status 0".to_string(),
        Some(code) => format!("exited with status {code}"),
        None => "ended for an unknown reason".to_string(),
    }
}

#[cfg(not(unix))]
fn describe_exit(status: std::process::ExitStatus) -> String {
    match status.code() {
        Some(0) => "exited cleanly with status 0".to_string(),
        Some(code) => format!("exited with status {code}"),
        None => "ended for an unknown reason".to_string(),
    }
}

/// Reap the proxy child on a thread and record how it ended.
///
/// One thread per spawned daemon, and it lives exactly as long as that daemon.
/// `wait` is blocking and this deliberately does not use tokio: the runtime is
/// not guaranteed to still be running during shutdown, which is one of the
/// windows in which the answer matters most.
///
/// The connection state is only moved to `Crashed` when the exit was *not*
/// clean, and only from `Live`. A daemon we asked to stop reaches `Stopped`
/// through the shutdown path, and overwriting that here would make an orderly
/// quit report itself as a crash on the next launch.
fn watch_proxy_child(mut child: std::process::Child, connection_state: Arc<AtomicU8>) {
    let pid = child.id();
    std::thread::Builder::new()
        .name("agency-proxy-watch".into())
        .spawn(move || match child.wait() {
            Ok(status) => {
                let description = describe_exit(status);
                let clean = status.success();
                crate::log!(
                    if clean {
                        crate::log::Level::Info
                    } else {
                        crate::log::Level::Error
                    },
                    "proxy",
                    "AgencyProxy (pid {pid}) {description}",
                );
                if !clean
                    && ConnectionState::from_raw(connection_state.load(Ordering::Acquire))
                        == ConnectionState::Live
                {
                    connection_state.store(ConnectionState::Crashed as u8, Ordering::Release);
                }
            }
            Err(error) => {
                crate::log!(
                    crate::log::Level::Warn,
                    "proxy",
                    "could not wait on AgencyProxy (pid {pid}): {error}",
                );
            }
        })
        .ok();
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

fn active_project_run_ids(snapshots: &[RunSnapshot], project_id: &str) -> Vec<RunId> {
    snapshots
        .iter()
        .filter(|snapshot| {
            snapshot
                .metadata
                .get("projectId")
                .and_then(serde_json::Value::as_str)
                == Some(project_id)
                && run_is_active(&snapshot.state)
        })
        .map(|snapshot| snapshot.run_id.clone())
        .collect()
}

fn injection_idempotency_key(run_id: &RunId, interaction_id: &str) -> String {
    format!("{}:inject:{interaction_id}", run_id.0)
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

    pub async fn send(&self, body: &str, interaction_id: &str) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + INJECTION_CONFIRMATION;
        loop {
            let response = self
                .client
                .request(ClientMessage::InjectMessage {
                    run_id: self.run_id.clone(),
                    body: body.into(),
                    // Every message needs its own key. Reusing one key for the
                    // entire run made the daemon correctly deduplicate the
                    // second and later owner steers as repeats of the first.
                    idempotency_key: injection_idempotency_key(&self.run_id, interaction_id),
                })
                .await
                .map_err(|error| error.to_string())?;
            match response {
                ServerResponse::Accepted => return Ok(()),
                ServerResponse::Error {
                    code: ErrorCode::Conflict,
                    ..
                } if tokio::time::Instant::now() < deadline => {
                    // The run owns its slot before Codex has finished opening
                    // the turn. Keep this ordered steer in flight until the
                    // daemon can attach it instead of handing it back to the
                    // visible prompt queue.
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                response => return accepted(response),
            }
        }
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
        /*
         * Bounded, unlike `finish`. The reason anyone cancels is a run that
         * stopped behaving, and a provider wedged on a command that never
         * returns may never emit a terminal event at all. Waiting for one
         * without a deadline is an await that never completes: the run slot
         * stays held, the project keeps reporting a live run, and pressing
         * Stop again does nothing because the first press is still parked in
         * this loop. That is the cancel button appearing to do nothing while
         * the log cheerfully records "stop requested".
         *
         * The proxy has accepted the cancel by this point, so it owns tearing
         * the process down. What this deadline governs is only how long the
         * GUI waits to hear about it before releasing the slot.
         */
        // Ask first whether there is anything left to wait for.
        //
        // A run the proxy has already finished emits no further events, and its
        // terminal event is long gone from this attachment's cursor. Waiting
        // for one is waiting forever, which is what made Stop look inert: the
        // GUI was holding a run slot for a run that died minutes earlier, and
        // every press queued behind an event that could never arrive.
        if let Ok(ServerResponse::Runs { runs }) =
            self.client.request(ClientMessage::ListRuns).await
        {
            let known = runs.iter().find(|run| run.run_id == self.run_id);
            let ended = match known {
                Some(run) => !matches!(
                    run.state,
                    agency_proxy_protocol::RunState::Running
                        | agency_proxy_protocol::RunState::Starting
                        | agency_proxy_protocol::RunState::WaitingApproval
                        | agency_proxy_protocol::RunState::Finishing
                ),
                // Unknown to the proxy: it cannot still be running.
                None => true,
            };
            if ended {
                crate::log!(
                    crate::log::Level::Info,
                    "proxy",
                    "{}: nothing to cancel, the proxy reports {}",
                    self.run_id.0,
                    known.map_or("no such run".to_string(), |run| format!("{:?}", run.state))
                );
                return self.terminal.take().unwrap_or_else(|| {
                    Err(format!(
                        "the run had already ended ({}); the project was released",
                        known.map_or("unknown to AgencyProxy".to_string(), |run| format!(
                            "{:?}",
                            run.state
                        ))
                    ))
                });
            }
        }
        crate::log!(
            crate::log::Level::Info,
            "proxy",
            "{}: CancelRun accepted; waiting for a terminal event",
            self.run_id.0
        );
        let waiting_since = std::time::Instant::now();
        let mut seen = 0u32;
        while self.terminal.is_none() {
            if tokio::time::timeout(CANCEL_CONFIRMATION, self.recv())
                .await
                .is_err()
            {
                crate::log!(
                    crate::log::Level::Warn,
                    "proxy",
                    "{}: no terminal event {}ms after CancelRun ({} further event(s) seen, last sequence {}).                      The daemon answering this socket does not terminate canceled runs.",
                    self.run_id.0,
                    waiting_since.elapsed().as_millis(),
                    seen,
                    self.latest_sequence
                );
                // What the proxy itself believes about this run. "Running with
                // events still flowing" and "silent and wedged" are different
                // bugs, and the GUI cannot tell them apart from out here.
                if let Ok(ServerResponse::Runs { runs }) =
                    self.client.request(ClientMessage::ListRuns).await
                {
                    match runs.iter().find(|run| run.run_id == self.run_id) {
                        Some(run) => crate::log!(
                            crate::log::Level::Warn,
                            "proxy",
                            "{}: the proxy still lists this run as {:?}",
                            self.run_id.0,
                            run.state
                        ),
                        None => crate::log!(
                            crate::log::Level::Warn,
                            "proxy",
                            "{}: the proxy no longer lists this run, yet sent no terminal event",
                            self.run_id.0
                        ),
                    }
                }
                return Err(format!(
                    "AgencyProxy accepted the cancel but reported no outcome within {}s; \
                     the run slot was released so the project is usable again",
                    CANCEL_CONFIRMATION.as_secs()
                ));
            }
            seen = seen.saturating_add(1);
        }
        crate::log!(
            crate::log::Level::Info,
            "proxy",
            "{}: terminal event after {}ms",
            self.run_id.0,
            waiting_since.elapsed().as_millis()
        );
        self.terminal
            .take()
            .unwrap_or_else(|| Err("AgencyProxy canceled without a terminal outcome".into()))
    }
}

/// How long a shutdown waits for the daemon to stop listening.
///
/// Generous, because a cooperative terminate has provider process groups to
/// tear down, but finite: an unbounded wait turns "Stop" into a command that
/// never returns.
const SHUTDOWN_CONFIRMATION: Duration = Duration::from_secs(15);

/// How long a cancel waits for the proxy to confirm before releasing the slot.
///
/// Long enough for a healthy provider to tear down and report, short enough
/// that a wedged one does not hold the project hostage. The cancel itself is
/// already accepted by the proxy when this starts, so expiring it loses the
/// outcome, never the teardown.
const CANCEL_CONFIRMATION: Duration = Duration::from_secs(10);

/// How long an owner steer may wait for a starting Codex turn to accept it.
const INJECTION_CONFIRMATION: Duration = Duration::from_secs(10);

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
    #[cfg(unix)]
    use super::describe_exit;
    use super::{
        AgencyProxy, ConnectionState, active_project_run_ids, injection_idempotency_key,
        proxy_socket_path, proxy_startup_failure, watch_proxy_child,
    };
    use agency_proxy_protocol::{RunId, RunSnapshot, RunState};
    use std::collections::BTreeMap;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::time::Duration;

    #[test]
    fn only_a_cold_proxy_may_be_started_automatically() {
        assert!(ConnectionState::Cold.may_spawn());
        assert!(!ConnectionState::Live.may_spawn());
        assert!(!ConnectionState::Crashed.may_spawn());
        assert!(!ConnectionState::Stopped.may_spawn());
    }

    #[test]
    fn project_cancel_targets_only_its_live_daemon_runs() {
        let snapshot = |id: &str, project: &str, state| RunSnapshot {
            run_id: RunId(id.into()),
            state,
            provider: "codex".into(),
            model: "gpt-5.6-sol".into(),
            provider_session_id: Some("session-current".into()),
            latest_sequence: 1,
            acknowledged_sequence: 0,
            workspace_roots: vec!["/repo".into()],
            metadata: BTreeMap::from([("projectId".into(), project.into())]),
        };
        let runs = vec![
            snapshot("run-live", "project-a", RunState::Running),
            snapshot("run-starting", "project-a", RunState::Starting),
            snapshot("run-finished", "project-a", RunState::Completed),
            snapshot("run-other", "project-b", RunState::Running),
        ];

        assert_eq!(
            active_project_run_ids(&runs, "project-a"),
            [RunId("run-live".into()), RunId("run-starting".into())]
        );
    }

    #[test]
    fn every_mid_turn_message_has_its_own_idempotency_key() {
        let run = RunId("run-live".into());
        assert_ne!(
            injection_idempotency_key(&run, "message-one"),
            injection_idempotency_key(&run, "message-two")
        );
        assert_eq!(
            injection_idempotency_key(&run, "message-one"),
            injection_idempotency_key(&run, "message-one"),
            "a transport retry of one message stays idempotent"
        );
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

    /// The owner's report: the proxy died, and Restart could not bring it back.
    ///
    /// A failed start records `Crashed`, and `connect` returns early on that
    /// state without spawning, which is correct for an ordinary call: a daemon
    /// that just failed to come up should not be relaunched by every passing
    /// request. Restart is the one caller that must clear it, or the button
    /// reports the old failure forever and the only way out is relaunching the
    /// app.
    #[tokio::test]
    async fn restart_revives_a_proxy_that_recorded_a_crash() {
        let dir = std::env::temp_dir().join(format!(
            "agency-proxy-crash-restart-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        std::fs::create_dir_all(&dir).expect("create temp directory");
        let proxy = AgencyProxy::new(&dir, None);

        proxy.record_failure("could not start /nonexistent/agency-proxy".into());
        assert_eq!(proxy.connection_state(), ConnectionState::Crashed);

        // Restart against a binary that cannot start: the relaunch still fails,
        // which is expected here and not what is being asserted.
        let _ = proxy
            .restart(
                Some(std::path::PathBuf::from("/nonexistent/agency-proxy")),
                agency_proxy_protocol::ShutdownMode::Terminate,
            )
            .await;

        // What matters is that it was *attempted*: the stale crash must not
        // still be short-circuiting `connect`, or no later restart can work
        // either, however healthy the binary is by then.
        assert_ne!(
            proxy.failure_message(),
            "could not start /nonexistent/agency-proxy",
            "restart must not keep reporting the previous crash",
        );

        let _ = std::fs::remove_dir_all(dir);
    }

    /// A restart that cannot bring the daemon up must still answer with a
    /// status, because that is what tells the panel to offer Start.
    ///
    /// It used to return `Err`. `restart` sets `Cold` so the relaunch is
    /// allowed to spawn, and `status` only degrades to a disconnected status
    /// when the state is already `Crashed` or `Stopped`, so a failed relaunch
    /// fell through to a hard error. Settings then showed an error and left the
    /// button reading "Restart", with no state change to make it read "Start",
    /// which is what "I could not restart it" looked like from the outside.
    #[tokio::test]
    async fn a_failed_restart_reports_a_disconnected_status_rather_than_an_error() {
        let dir = std::env::temp_dir().join(format!(
            "agency-proxy-failed-restart-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        std::fs::create_dir_all(&dir).expect("create temp directory");
        let proxy = AgencyProxy::new(&dir, None);

        // A crash first, which is the state the owner was actually in: the
        // daemon had been running and died.
        proxy.record_failure("AgencyProxy stopped unexpectedly".into());

        let status = proxy
            .restart(
                Some(std::path::PathBuf::from("/nonexistent/agency-proxy")),
                agency_proxy_protocol::ShutdownMode::Terminate,
            )
            .await
            .expect("a failed restart still reports a status");

        assert!(
            !status.connected,
            "the daemon did not come up, so the panel must be told it is down",
        );
        assert!(
            status.detail.is_some(),
            "the reason it did not start is what the panel shows",
        );

        let _ = std::fs::remove_dir_all(dir);
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

    /// Run a shell fragment to exit and report how the wait described it.
    ///
    /// Real processes exiting for real reasons, rather than a fabricated
    /// `ExitStatus`: the point of this code is to report what the OS says, so
    /// a test that invents the status would only be checking its own `match`.
    #[cfg(unix)]
    fn describe_shell_exit(script: &str) -> String {
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a shell");
        let status = child.wait_with_output().expect("wait for the shell").status;
        describe_exit(status)
    }

    #[cfg(unix)]
    #[test]
    fn a_clean_exit_is_not_reported_as_a_crash() {
        assert_eq!(
            describe_shell_exit("exit 0"),
            "exited cleanly with status 0"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_nonzero_exit_reports_its_code() {
        assert_eq!(describe_shell_exit("exit 3"), "exited with status 3");
    }

    /// The case that motivated all of this.
    ///
    /// A SIGKILL leaves no crash report and no log line of its own, so before
    /// this it was indistinguishable from a clean exit: both are just "the
    /// socket stopped answering". It has to name the signal *and* say that
    /// nobody in this process could have handled it.
    #[cfg(unix)]
    #[test]
    fn a_sigkill_is_named_and_attributed_to_something_outside_the_daemon() {
        let described = describe_shell_exit("kill -KILL $$");
        assert!(
            described.contains("signal 9"),
            "the signal number is what a reader greps for, got: {described}"
        );
        assert!(
            described.contains("SIGKILL"),
            "the name is what makes it readable, got: {described}"
        );
        assert!(
            described.contains("uncatchable"),
            "a SIGKILL cannot be handled, so the daemon is not the suspect: {described}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_termination_request_is_distinguished_from_a_crash() {
        let terminated = describe_shell_exit("kill -TERM $$");
        assert!(
            terminated.contains("signal 15") && terminated.contains("a request to stop"),
            "a TERM is somebody asking politely, not a fault: {terminated}"
        );

        let crashed = describe_shell_exit("kill -SEGV $$");
        assert!(
            crashed.contains("signal 11") && crashed.contains("a crash"),
            "a SEGV is a fault and must read as one: {crashed}"
        );
    }

    /// A daemon we deliberately stopped must not come back as `Crashed`.
    ///
    /// `Stopped` and `Crashed` drive different UI: one offers Start, the other
    /// reports a failure. The watcher only escalates a *non-clean* exit, and
    /// only from `Live`, so an orderly quit keeps whatever state the shutdown
    /// path set.
    #[test]
    fn watching_a_clean_exit_leaves_the_state_alone() {
        let state = Arc::new(AtomicU8::new(ConnectionState::Stopped as u8));
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg("exit 0")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a shell");

        watch_proxy_child(child, state.clone());

        // The watcher runs on its own thread, so give it a bounded moment
        // rather than sleeping a fixed amount and hoping.
        for _ in 0..100 {
            if ConnectionState::from_raw(state.load(Ordering::Acquire)) != ConnectionState::Stopped
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        assert_eq!(
            ConnectionState::from_raw(state.load(Ordering::Acquire)),
            ConnectionState::Stopped,
            "a clean exit must not overwrite a deliberate stop with a crash",
        );
    }

    /// A daemon that dies while we thought it was `Live` becomes `Crashed`.
    #[cfg(unix)]
    #[test]
    fn watching_a_killed_daemon_marks_it_crashed() {
        let state = Arc::new(AtomicU8::new(ConnectionState::Live as u8));
        let child = Command::new("/bin/sh")
            .arg("-c")
            .arg("kill -KILL $$")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn a shell");

        watch_proxy_child(child, state.clone());

        for _ in 0..100 {
            if ConnectionState::from_raw(state.load(Ordering::Acquire)) == ConnectionState::Crashed
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }

        assert_eq!(
            ConnectionState::from_raw(state.load(Ordering::Acquire)),
            ConnectionState::Crashed,
            "a daemon killed while Live has crashed, and the panel must say so",
        );
    }
}
