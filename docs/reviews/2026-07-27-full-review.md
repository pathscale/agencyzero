# agencyzero + agencyzero-xpc-spike-test Review: Full

**Date:** 2026-07-27
**Scope:** two repositories, everything tracked in each.
- `/Users/revenge/code/agencyzero` (the live platform repo): `apps/gui/**`, `crates/**`, `Cargo.toml`, `tauri.conf.json`, `.claude/**`, docs.
- `/Users/revenge/code/agencyzero-xpc-spike-test` (the throwaway spike): `crates/agencyzero/src/main.rs`, `crates/agentone/src/main.rs`, `scripts/*.sh`, `launchd/*.plist`, `PLAN.md`, `README.md`, and the untracked `results/` evidence.
- Read-only context: `/Users/revenge/code/iaai-27/xpc-spike-review.md`, `xpc-spike-validation-b.md`, `cross-platform-peer-attestation.md`.
- Because both repos contain **zero `unsafe`**, the FFI section audits the dependency that actually holds the privilege boundary: `rama-net-apple-xpc` 0.3.0 as vendored in `~/.cargo/registry/src/index.crates.io-*/rama-net-apple-xpc-0.3.0`.

**Commit:** `agencyzero` = `7c9f86e` (branch `feat/workspace-scaffold`, clean tree) · `agencyzero-xpc-spike-test` = `e71c267` (branch `master`, clean tree)
**Reviewer slice:** full (single reviewer for both repos; no sibling slices)

---

## What this project is, and where it stands

**agencyzero** is intended to be a multi-executable macOS agent platform: a Tauri desktop harness plus three sidecar executables (agent, MCP proxy, agent proxy) around a shared `az-core` library, with the trusted parent process talking to an untrusted sidecar over a privilege-separated local IPC channel. That IPC channel is the security-defining part of the design.

**Where it actually stands: step 0.** The live repo is 43 lines of Rust across five crates. `apps/gui/src/main.rs` is a hello-world Tauri window with one `greet` command; the three sidecar binaries print a version string and exit; `az-core` exports a single `VERSION` constant. There is **no IPC code, no XPC, and no reference to XPC anywhere in the live repo** (`crates/core/src/lib.rs:7`, `crates/agent/src/main.rs:4`). It compiles clean and `cargo fmt --check` passes.

**agencyzero-xpc-spike-test** is a completed, throwaway spike (254 lines of Rust) that answered one question: can `rama-net-apple-xpc` 0.3.0 carry a private mach-service XPC channel with kernel-enforced peer code-signature attestation? Its answer is yes, and the evidence in `results/` supports it. A prior review (`iaai-27/xpc-spike-review.md`) approved the methodology, and I concur: three copies of one binary sharing a signing identifier and differing only in signing identity, plus a no-requirement control run, is the strongest form of that validation available.

**Which repo is live and has the spike diverged?** `agencyzero` is live; the spike is dead code by design and should stay that way. The housekeeping problem the prior review flagged (the spike had been pushed to `pathscale/agencyzero` as commit `0a888dd` while the spike repo held only a README) has been **resolved**: `0a888dd` is no longer reachable from any branch in `agencyzero` (`git branch -a --contains 0a888dd` is empty; it survives only in the local reflog at `HEAD@{12}`), and the spike now lives at `4d6c5ae` in `agencyzero-xpc-spike-test`. The two repos have not diverged in the "same code, drifting copies" sense, because they share no code at all. They have diverged in a worse sense: **all of the spike's hard-won operational and security constraints exist only in the spike repo and in the `iaai-27` notes, and none of them have landed in the live repo** (finding 03).

The honest one-line status: the security work has been *researched* well and *implemented* nowhere. Everything in this review that matters is about not losing the research, and about three attestation gaps the spike's success criterion did not cover.

---

## Summary

- **Peer attestation is done the right way structurally.** Neither repo authenticates a peer by PID, by `audit_token` read from the wrong place, by a message field, or by "accept everything". The spike delegates the check to `xpc_connection_set_peer_code_signing_requirement`, which libxpc enforces at check-in before a single byte reaches Rust (evidence: `results/C-syslog.txt` `Dropping check-in message due to code signing requirement`, and the listener log shows *no event at all* for rejected peers). The classic severe failure mode is absent. Say that plainly, because most of the rest of this document is about what that check does *not* buy you.
- **Three gaps the spike did not cover, all of which bite the real implementation.** (a) The attested binary is signed with `flags=0x0(none)`, no hardened runtime and no library validation, so an attacker who can run it can also inject a dylib into it and still satisfy the requirement. (b) A code-signing requirement authenticates *which binary*, not *which process*: any same-user process can run a copy of the attested sidecar and be served as a fully trusted peer. (c) The requirement string itself lives in a user-writable LaunchAgent plist, so it is inside the TCB and same-user malware can simply delete it.
- **What an unprivileged local process can achieve today: nothing.** Nothing from either repo is installed or running. `launchctl print gui/501/com.24x.agencyzero.spike` returns "Could not find service"; `~/Library/LaunchAgents` contains no spike plist; the live repo has no IPC surface at all. The exposure is entirely prospective, plus a window during a `validate.sh` run (finding 04).
- **Message handling is the weakest concrete code in the spike.** The echo handler reflects an attacker-controlled dictionary verbatim, which leaks every received file descriptor (`XpcMessage::Fd` is a bare `RawFd` that nothing closes) and inherits crate defaults allowing ~10.24M buffered events per listener. No panics are reachable from message content: parsing is total, the crate caps nesting at 256, and neither binary calls `unwrap` on peer data.
- **Zero `unsafe` in both repos** (`grep -rn unsafe crates/` returns 0 in each), which is the single best thing about choosing the crate over owned FFI, and is exactly what the README claims. The `unsafe impl Sync` pattern the sibling review flagged elsewhere **does appear in the dependency** at `object.rs:44-45`, with no SAFETY comment at all, though I could not construct an exploit for it today (appendix, finding 07).
- **Top 3 things to do:** (1) write down the channel design decision in `agencyzero/docs/` before any code lands, specifically whether the real channel is a named mach service or an inherited anonymous endpoint; (2) make hardened runtime plus library validation a signing-pipeline requirement and state in the doc that a `codesign -r` requirement string is worthless without it; (3) make the peer requirement non-optional in the real listener API so "open listener" is not reachable by omitting a flag.

---

## Findings

### [SEV-1] Code-signature attestation is bypassable by dylib injection: the attested peer is signed without hardened runtime or library validation

- **ID:** `agencyzero-full-01`
- **Severity:** High
- **Category:** Security
- **Confidence:** High (on the mechanism and on the signing flags, both verified); Medium that it reproduces unchanged on macOS 26.5, since I did not execute the injection
- **Location:** `agencyzero-xpc-spike-test/scripts/sign.sh:13`, `agencyzero-xpc-spike-test/scripts/validate.sh:107-110`, `agencyzero-xpc-spike-test/PLAN.md:110-113` ("hardened runtime is out of scope for the spike"), `agencyzero-xpc-spike-test/README.md:255-256` (the production upgrade path, which mentions only the requirement string)
- **What:** Every binary in the spike is signed with plain `codesign --force --sign <identity>` and no `--options`. Verified: `codesign -dv --verbose=4 results/agentone-good` reports `CodeDirectory ... flags=0x0(none)` and `TeamIdentifier=not set`. `flags=0x0` means neither `CS_RUNTIME` (0x10000, hardened runtime) nor `CS_REQUIRE_LV` (0x2000, library validation) is set, so the process is not "restricted" from dyld's point of view: `DYLD_INSERT_LIBRARIES` is honoured, and the inserted library need only be ad-hoc signed (`codesign -s -`), which any local user can do. The peer requirement `identifier agentone and certificate leaf = H"…"` evaluates the *main executable's* static signature, which injection does not disturb.
- **Why it matters:** This collapses the entire validation-C result for an attacker who has local code execution as the user. They take the legitimately signed `agentone` (a world-readable copy sits in `results/`, and in production it ships inside the app bundle), run it with `DYLD_INSERT_LIBRARIES=/tmp/evil.dylib`, and the listener accepts it as an attested peer while the attacker's code runs inside it with full control of the channel. The README's stated production upgrade, `anchor apple generic and certificate leaf[subject.OU] = <TEAMID>`, does not help: it is still a static-signature predicate on an injectable process.
- **Fix:** Two parts, both mechanical, but they belong in the signing pipeline rather than in Rust. (1) Sign the sidecar with `codesign --options runtime --entitlements <plist>` and, for a sidecar that loads no third-party plugins, add library validation (it is implied by hardened runtime for non-entitled processes; do not grant `com.apple.security.cs.disable-library-validation`). (2) Because a requirement string cannot assert "hardened runtime" directly, pin something only a hardened, entitled build carries: give the sidecar a private entitlement and have the listener use `PeerSecurityRequirement::EntitlementExists("com.pathscale.agencyzero.sidecar")` in addition to the code-signing requirement, or move to `LightweightCodeRequirement`. Document in the same change that a `codesign -r` string alone attests nothing about runtime integrity.
- **Effort:** S in the spike, M in the real release pipeline (notarization and entitlement plumbing).
- **Blast radius:** The signing scripts and the eventual release pipeline. No API change. It invalidates one sentence of the spike README's recommendation, which should get a correction note.

### [SEV-2] Attestation identifies a binary, not a process instance: any same-user process can impersonate the sidecar

- **ID:** `agencyzero-full-02`
- **Severity:** High
- **Category:** Security / Design
- **Confidence:** High
- **Location:** `agencyzero-xpc-spike-test/crates/agencyzero/src/main.rs:92-109` (named-service listener), `README.md:120-136` (validation A consequence: the parent must be the launchd job), `iaai-27/cross-platform-peer-attestation.md:16-31` (the reframe that solves this, not yet adopted for macOS)
- **What:** The channel is a named mach service in the per-user GUI bootstrap namespace (`gui/$UID`). Every process running as that user may dial it. The peer requirement then answers exactly one question: "is the connecting process executing a binary whose static signature matches this predicate?" It does not answer "did I spawn this process", "is this the only sidecar", or "is this the sidecar I handed a task to". An attacker running as the user launches their own copy of the signed sidecar, with arguments, environment, and working directory of their choosing, and is served as trusted. Combined with finding 01, they do not even need the sidecar's own behaviour.
- **Why it matters:** The whole point of the parent/child split is that AgencyZero decides what AgentOne is allowed to do. If an arbitrary same-user process can present itself as AgentOne, then every authorization decision the parent makes on the strength of "the peer is attested" is wrong. This is the difference between "the channel is authenticated" and "the channel is bound to the child I spawned".
- **Fix:** Needs a design decision, not a patch. The strongest option is the one your own cross-platform note already recommends as the portable pattern: do not use a named service for the parent→child channel at all. Verify the sidecar binary before `exec`, spawn it, and hand it an `XpcEndpoint::anonymous_channel()` endpoint over an inherited fd or a spawn-time argument; no third process can ever dial an anonymous endpoint. Keep the named launchd service only for endpoints that genuinely need on-demand start or multiple clients, and for those pair the code-signing requirement with a per-connection secret: the parent generates a nonce per spawn, passes it to the child out of band, and the child presents it in the first message. Note the constraint from validation A: an anonymous endpoint cannot bootstrap the *first* channel by itself, but for a parent-spawns-child topology it does not have to.
- **Effort:** L (a day or more of design plus implementation), and it should be settled before any IPC code lands in the live repo.
- **Blast radius:** Defines the shape of the entire channel API. Cheapest to decide now while the live repo has zero IPC code.

### [SEV-3] The live repo carries none of the spike's conclusions; the knowledge is one `rm -rf` from gone

- **ID:** `agencyzero-full-03`
- **Severity:** High
- **Category:** Docs / Design
- **Confidence:** High
- **Location:** `agencyzero/README.md:44-47` (Status section, no mention of IPC), `agencyzero/AGENTS.md:12-15` (Invariants section, one bullet), absence of `agencyzero/docs/**` before this review, versus `agencyzero-xpc-spike-test/README.md:276-299` (the friction list) and `iaai-27/xpc-spike-review.md:34-48` (the carry-forward list)
- **What:** Four constraints were established at real cost and are recorded only in a repo explicitly labelled "throwaway" plus a paper-notes directory outside both repos: (1) `XpcListener::bind` returns `Ok` for a name it does not own and the listener dies asynchronously, so `termination_reason()` is the real bind result; (2) a launchd plist is unavoidable and a manually started process cannot take the name over, which forces AgencyZero itself to be the launchd job (`SMAppService.agent` for a shipped Tauri app); (3) rejected peers are invisible from inside the listener process, so peer-rejection alerting must be built on a `log stream` watcher; (4) the requirement string lives in a user-writable plist and is therefore part of the TCB. The live repo's `AGENTS.md` says durable learnings "belong in this repo's docs", and none of these are there.
- **Why it matters:** The next agent or engineer to open `agencyzero` sees a hello-world Tauri app with no hint that the IPC design is already decided, or that `bind()` returning `Ok` is a lie. Each of these constraints costs hours to rediscover, and constraint (1) is the kind that ships as a silent production outage: the service appears to start and simply never serves anyone.
- **Fix:** Add `agencyzero/docs/ipc-channel.md` with: the decision (crate versus FFI, and named service versus anonymous endpoint once finding 02 is settled), the four constraints above, the threat model paragraph (what peer attestation does and does not prove, per findings 01 and 02), and a link to the spike commit `4d6c5ae` for the evidence. Restore the `cargo fmt` / `cargo clippy` invariant and a Build and test section in `agencyzero/AGENTS.md`; the spike's `AGENTS.md` has both, the live repo's has neither.
- **Effort:** S
- **Blast radius:** Docs only.

### [SEV-4] Open listener is the default: the peer requirement is an optional flag, and half the validation runs install a plist without it

- **ID:** `agencyzero-full-04`
- **Severity:** Medium
- **Category:** Security
- **Confidence:** High
- **Location:** `agencyzero-xpc-spike-test/crates/agencyzero/src/main.rs:93-100` (`else { println!("WARNING: no peer requirement (open listener)") }`), `scripts/validate.sh:79-88` (A2 plist, no `--require`), `scripts/validate.sh:143-149` (the control run's plist, deliberately open), `launchd/com.24x.agencyzero.spike.plist:8-10`
- **What:** Security is opt-in through `--require`. Omit the flag and the listener serves every process in the user's bootstrap namespace, announcing the fact on stdout. `validate.sh` legitimately needs the open mode for the attribution control, and it bootstraps that open LaunchAgent under the real service name for the duration of the run. Separately, because the requirement is an argv string in `~/Library/LaunchAgents/*.plist`, a same-user attacker can rewrite the plist, `launchctl bootout` and `bootstrap` it, and turn attestation off entirely, which makes the plist part of the TCB.
- **Why it matters:** The concrete exposure today is a window of a few seconds per `validate.sh` run in which any same-user process can connect to `com.24x.agencyzero.spike` and exchange messages; the spike's payload is a harmless echo, so the practical impact now is nil. The reason to fix it is shape: an `Option<PeerSecurityRequirement>` that defaults to `None` is exactly how production services end up unauthenticated, and this file is the template the real listener will be written from.
- **Fix:** In the real implementation make the requirement a non-optional constructor argument, so an open listener is unrepresentable rather than merely discouraged, and put the escape hatch behind an explicitly ugly name (`XpcListenerConfig::new_unauthenticated(...)`) that greps loudly. In the spike, rename the flagless mode to `--insecure-no-require` so the control run is self-documenting. For the plist: state in the threat-model doc that peer attestation defends the channel and must not be the only thing gating a privileged operation, which is the same conclusion `iaai-27/xpc-spike-review.md:41-43` reached.
- **Effort:** S
- **Blast radius:** The real listener's constructor signature. Breaking, and cheap now.

### [SEV-5] Every received file descriptor is leaked; a peer can exhaust the listener's descriptor table

- **ID:** `agencyzero-full-05`
- **Severity:** Medium
- **Category:** Security (DoS) / Correctness
- **Confidence:** High on the leak; Medium on how fast it bites, since libxpc's per-message fd limits were not measured
- **Location:** `agencyzero-xpc-spike-test/crates/agencyzero/src/main.rs:54-63` (`received.message().clone()` then `received.reply(...)`), dependency `rama-net-apple-xpc-0.3.0/src/object.rs:198-202` (`xpc_fd_dup` on decode), `src/message.rs:38-39` (`Fd(RawFd)`, documented as "the caller owns it and must close it")
- **What:** Decoding an incoming message calls `xpc_fd_dup` for each `XPC_TYPE_FD` value, producing a descriptor the receiving process owns. `XpcMessage::Fd` is a bare `RawFd` with no `Drop`, and the enum derives `Clone`, so cloning copies the integer without duplicating ownership. The echo handler clones the whole dictionary and sends it back, which creates a *second* descriptor via `xpc_fd_create`, and then drops both `XpcMessage` values without closing anything. Nothing in either binary ever calls `close`.
- **Why it matters:** A peer that sends a dictionary containing file descriptors in a loop drives the listener to `EMFILE`, at which point the process cannot open files, accept work, or in many cases log the failure. With the requirement enforced this needs an attested peer, which is precisely the untrusted sidecar the architecture assumes is hostile; without it, any same-user process. The `Clone`-copies-a-`RawFd` shape is also a latent double-close waiting for the first handler that does try to clean up.
- **Fix:** Do not accept fds on this channel unless the design needs them. At the message boundary, walk the decoded message and either reject `Fd` variants outright (`XpcError`-equivalent, close the dup first) or wrap them immediately in `std::os::fd::OwnedFd` so ownership is tracked by the type system. If fd passing is wanted later, change the internal message type so the fd-bearing variant is not `Clone`.
- **Effort:** S
- **Blast radius:** The message-handling layer of the real implementation. Worth encoding as a lint or a `#[deny]`-style review rule since the crate's own type invites the mistake.

### [SEV-6] Unbounded buffering and unbounded task spawn under the crate's default knobs

- **ID:** `agencyzero-full-06`
- **Severity:** Medium
- **Category:** Security (DoS) / Performance
- **Confidence:** High on the arithmetic; Medium on real-world reachability, which depends on libxpc's own message-rate and size limits (not measured)
- **Location:** `agencyzero-xpc-spike-test/crates/agencyzero/src/main.rs:121-126` (`tokio::spawn(handle_peer(conn))` per accept, no cap), dependency `src/listener.rs:48` (`DEFAULT_MAX_PENDING_CONNECTIONS = 1024`), `src/connection.rs:37` (`DEFAULT_MAX_PENDING_EVENTS = 10_000`), `src/object.rs:182-197` (`Data` payloads copied into `Vec<u8>` at decode)
- **What:** The spike takes every default. A listener therefore buffers up to 1024 unaccepted peer connections, each of which independently buffers up to 10 000 decoded events, giving a worst case of ~10.24M in-memory events before anything is dropped; each event holds a fully decoded `XpcMessage`, so a 1 KB dictionary per event is on the order of 10 GB. Each accepted connection also gets an unbounded `tokio::spawn`. Beyond capacity the crate's behaviour is not backpressure but silent loss: `forward_event` drops the newest event with a `warn!` (`src/connection.rs:591-604`), which the spike README already lists as friction item 6.
- **Why it matters:** Memory pressure is the obvious half. The sharper half is the silent drop: on a channel that will carry control messages (halt, revoke, task completion), dropping the newest event under load is a security-relevant failure that surfaces only as a warn line in a log nobody is tailing.
- **Fix:** Set both knobs explicitly and small in the real implementation (`with_max_pending_connections`, `with_peer_max_pending_events`), size them to the actual topology (a parent with one sidecar wants single digits, not 1024), and bound concurrent peer tasks with a semaphore or a fixed worker set. Treat "event channel full" as a fatal condition for that connection rather than a warning, because for a one-peer channel it means the reader is wedged.
- **Effort:** S for the knobs, M to define the drop policy.
- **Blast radius:** Listener setup and the accept loop.

### [SEV-7] Peer-identity accessors are a trap, and the crate's own documentation points at the wrong one

- **ID:** `agencyzero-full-07`
- **Severity:** Medium
- **Category:** Security / Docs
- **Confidence:** High
- **Location:** `agencyzero-xpc-spike-test/crates/agencyzero/src/main.rs:48-49` (reads `pid`/`euid`, logs only), dependency `src/connection.rs:161-167` ("For security decisions, prefer `asid` over `pid`"), `src/connection.rs:408-436`
- **What:** The spike reads `conn.pid()` and `conn.euid()` and uses them **only for logging**, which is correct and worth recording as a positive. The trap is one layer down: `pid()` wraps `xpc_connection_get_pid`, which is subject to PID reuse and is the textbook wrong basis for an XPC authorization decision, and the crate's rustdoc steers readers to `asid()` "for security decisions". An audit session ID is shared by *every* process in a login session, so it distinguishes nothing about the peer; it is a strictly weaker identity claim than the PID, not a stronger one. A future handler that follows the crate's advice would write an authorization check that is trivially satisfied by any process in the user's session. Related shape in the same file: the spike echoes a `"pid"` field that the *client* put in its own message (`crates/agentone/src/main.rs:97-100`), which is fine as a spike payload but is exactly the "trust a message field for identity" pattern that must never appear in a handler.
- **Why it matters:** The only sound peer authorization on this channel is the kernel-enforced requirement applied before activation. Every other identity signal on `XpcConnection` is telemetry. If that is not written down, the first handler that needs to "check who is calling" will reach for `pid()` or `asid()`.
- **Fix:** In `docs/ipc-channel.md` state the rule in one line: peer authorization is the `PeerSecurityRequirement` and nothing else; `pid`, `euid`, `egid`, `asid`, and any message field are logging-only. Consider wrapping the connection in a local newtype that simply does not expose those accessors to handler code. File an upstream issue against the crate for the `asid` advice.
- **Effort:** S
- **Blast radius:** Docs plus, optionally, a thin wrapper type.

### [SEV-8] Dependency: `unsafe impl Send`/`Sync for OwnedXpcObject` with no safety justification

- **ID:** `agencyzero-full-08`
- **Severity:** Medium
- **Category:** Security / Maintainability (in a dependency)
- **Confidence:** Medium (the impls are unjustified as written; I could not construct a reachable data race through the crate's current API)
- **Location:** `rama-net-apple-xpc-0.3.0/src/object.rs:44-45`
- **What:** This is the class the sibling review found elsewhere in the family, so it was checked explicitly. `unsafe impl Send for OwnedXpcObject {}` and `unsafe impl Sync for OwnedXpcObject {}` appear with **no SAFETY comment at all**, unlike the two impls on `XpcConnection` (`src/connection.rs:182-193`), which are justified and, as far as I can tell, correctly: the non-`Sync` `Receiver` is only reachable through `&mut self` in `recv`. `OwnedXpcObject` wraps a raw `xpc_object_t`, which for *immutable* XPC objects is thread-safe per Apple, but XPC dictionaries and arrays are mutable and `xpc_dictionary_set_value` from two threads on one object is a data race. Today the crate only mutates freshly created objects inside a single function before publishing them (`from_message_inner`, `ReceivedXpcMessage::reply`), and the type is `pub(crate)`, so I could not reach a race from the public API. That is an accident of current usage, not an invariant the type enforces.
- **Why it matters:** An unjustified blanket `Sync` on a raw-pointer wrapper is a latent unsoundness that the next refactor inside the crate can turn into a real data race, and consumers cannot see it. For a component sitting on a privilege boundary, "sound only because of how it happens to be called" is the wrong resting state.
- **Fix:** Not yours to patch directly. File an upstream issue asking for a SAFETY comment scoped to the actual invariant ("only ever shared after the object is fully constructed and never mutated"), or better, split the type into a mutable-during-construction form that is `!Sync` and a published immutable form that is `Sync`. Locally, pin the exact version in `Cargo.lock` (already the case) and re-audit these two lines on every crate upgrade.
- **Effort:** S to report, out of your hands to fix.
- **Blast radius:** None today; it is a watch item for upgrades.

### [SEV-9] Upstream doc bug already refuted by your own evidence: rejected peers do not surface on the listener event stream

- **ID:** `agencyzero-full-09`
- **Severity:** Low
- **Category:** Docs (dependency) / Correctness
- **Confidence:** High (the spike measured it; `results/C-listener.log` shows zero events for the two rejected peers)
- **Location:** dependency `src/peer.rs:23-26` ("a failing peer ... surfaces as `XpcConnectionError::PeerRequirementFailed` on the event stream") and `src/listener.rs:96-100` ("Applied to each incoming peer connection before it is delivered by `accept`"), versus `agencyzero-xpc-spike-test/README.md:233-250`. Also note the requirement is in fact applied once to the *listener* connection (`src/listener.rs:226-228`), not per peer.
- **What:** The crate documents listener-side visibility of requirement failures that does not exist, and describes the application point inaccurately. Your README already carries the correction, derived from a measurement rather than from the docs, which is the right way round.
- **Why it matters:** Small in itself, but it is the reason a monitoring design that reads plausible ("count `PeerRequirementFailed` events") would silently count zero forever. It also means the crate's docs cannot be trusted as the specification for this API; the unified log is.
- **Fix:** File the upstream issue with your evidence attached; it is a good bug report and costs ten minutes. Keep the correction prominent in `docs/ipc-channel.md`.
- **Effort:** S
- **Blast radius:** None.

### [SEV-10] The three items from the prior review are still open

- **ID:** `agencyzero-full-10`
- **Severity:** Low
- **Category:** Maintainability / Docs
- **Confidence:** High
- **Location:** `agencyzero-xpc-spike-test/crates/agencyzero/src/main.rs:71-72`; `scripts/make-identities.sh:5-6` versus `scripts/validate.sh:96-99`; `scripts/sign.sh:15-16`
- **What:** `iaai-27/xpc-spike-review.md:25-32` listed three minor items on 2026-07-25. All three survive at `e71c267`: (1) the comment above the `XpcEvent::Error` arm still says "This is where a rejected peer shows up when a `PeerSecurityRequirement` is active: `PeerRequirementFailed`", which the README's own headline correction refutes; (2) `make-identities.sh` still claims "Nothing touches the login keychain or the keychain search list" while `validate.sh` does exactly that (restored via `trap`, so harmless, but the comment is false); (3) `sign.sh`'s `strip` mode is dead and cannot work on arm64 anyway.
- **Why it matters:** Item (1) is the one that costs something: the file is the template for the real listener, and its comment tells the next reader the opposite of the project's most important finding about this API.
- **Fix:** Three one-line edits. If the spike is genuinely frozen, an alternative is a banner at the top of the spike README saying the code is frozen at the state that produced the evidence, and that in-code comments are superseded by the README's corrections. Do one or the other; leaving a contradiction in the exemplar file is the worst option.
- **Effort:** S
- **Blast radius:** The spike only.

### [SEV-11] `validate.sh` never asserts, so a negative result can pass for the wrong reason

- **ID:** `agencyzero-full-11`
- **Severity:** Low
- **Category:** Correctness (test methodology)
- **Confidence:** High
- **Location:** `agencyzero-xpc-spike-test/scripts/validate.sh:8` (`set -uo pipefail`, no `-e`), `:107-110` (three `codesign` calls with no error check), `:131-134` (results are `grep`ed for display, never compared)
- **What:** The script is a driver that prints evidence for a human, not a test that fails. The signing of the three `agentone` variants is unchecked; if the `SpikeWrong` signing failed (locked keychain, expired 30-day cert, missing identity), the variant keeps its linker-applied ad-hoc signature, is still rejected by the requirement, and the run still looks like a pass, while the actually interesting case (validly signed under a *different* identity) went untested. The designated requirements are printed for each variant, so a careful reader catches it, but nothing enforces it.
- **Why it matters:** This is the single strongest piece of security evidence the project has, and it is the basis for a paper claim. It should not be able to pass for a reason nobody noticed. Note also that the certificates are 30-day (`make-identities.sh:29`), so a re-run after expiry behaves differently from the recorded run.
- **Fix:** After signing, assert each variant's designated requirement contains the expected leaf hash and abort otherwise; assert the good peer's exit status is 0 and the two rejected peers' is non-zero, rather than grepping for display. Roughly fifteen lines.
- **Effort:** S
- **Blast radius:** The spike's script only.

### [SEV-12] Tauri scaffold ships with CSP disabled and the global Tauri bridge exposed

- **ID:** `agencyzero-full-12`
- **Severity:** Low today, High for anything built on it
- **Category:** Security
- **Confidence:** High
- **Location:** `agencyzero/apps/gui/tauri.conf.json:19-21` (`"security": { "csp": null }`), `:11` (`"withGlobalTauri": true`), `agencyzero/apps/gui/dist/index.html:76-81`
- **What:** The GUI scaffold disables the Content Security Policy entirely and exposes `window.__TAURI__` to every script in the webview. Today the page is static and writes the command result with `textContent`, so there is no injection path and no finding to exploit. But this application is a Claude-desktop-style harness: it will render model output, tool results, and quite possibly remote content, and every one of those is a script-injection vector into a webview that has an unrestricted bridge to Rust.
- **Why it matters:** Fixing the default costs one line now. Retrofitting a CSP onto a working UI, after inline handlers and inline styles have accumulated, costs a day and gets deferred.
- **Fix:** Set a real `csp` string now (start from `default-src 'self'; script-src 'self'; style-src 'self'`, adjust as the frontend grows) and drop `withGlobalTauri` in favour of importing the API module, so the bridge is not ambient. Define an explicit capabilities file rather than relying on defaults, and when handler commands start taking data from the webview, treat their arguments as untrusted input.
- **Effort:** S
- **Blast radius:** `apps/gui` only, while it is 90 lines of HTML.

### [SEV-13] `--spawn` execs an arbitrary path with the parent's full environment and no pre-exec verification

- **ID:** `agencyzero-full-13`
- **Severity:** Low
- **Category:** Security / Design
- **Confidence:** High
- **Location:** `agencyzero-xpc-spike-test/crates/agencyzero/src/main.rs:111-119`
- **What:** `std::process::Command::new(path).args(["--service", &service]).spawn()` runs whatever path it is given, inherits the parent's entire environment (including any `DYLD_*` variables an attacker set on the parent), and does no signature or digest check on the child before exec.
- **Why it matters:** It is a spike convenience flag, and the path comes from the operator's own command line, so today it is not a vulnerability. It matters because it is the *opposite* of the "attest-then-spawn" pattern that `iaai-27/cross-platform-peer-attestation.md:24-31` identifies as the portable primitive, and the real parent will inherit this code's shape. Environment inheritance in particular is how finding 01's injection reaches a child that the parent believes it launched cleanly.
- **Fix:** In the real spawner: resolve the sidecar path from the app bundle (not from argv), verify its signature or digest before exec, `.env_clear()` and set only what the child needs, and hand the channel over an inherited endpoint rather than a service name (finding 02).
- **Effort:** S in isolation, part of the finding 02 work in practice.
- **Blast radius:** The real spawn path.

### [SEV-14] The spike violates its own stated build invariant: `cargo fmt --check` fails

- **ID:** `agencyzero-full-14`
- **Severity:** Low
- **Category:** Maintainability
- **Confidence:** High (measured)
- **Location:** `agencyzero-xpc-spike-test/AGENTS.md:11` ("Keep `cargo fmt` and `cargo clippy --all-targets` clean. Lint failures are part of the build here, not advisory."); failing sites `crates/agencyzero/src/main.rs:36,50,106` and `crates/agentone/src/main.rs:69`
- **What:** `cargo fmt --check` reports four diffs (all long `println!`/`eprintln!` lines rustfmt wants to wrap). `cargo clippy --offline --all-targets` is clean, and `cargo check --all-targets` is clean. In the live repo, `cargo fmt --check` passes and the non-GUI crates check clean, but `agencyzero/AGENTS.md` has dropped the fmt/clippy invariant and the Build and test section entirely.
- **Why it matters:** Small, but it is a stated invariant that the repo's own head commit breaks, which teaches the next agent that the invariants are decorative.
- **Fix:** Either run `cargo fmt` on the spike (a formatting-only commit on a frozen repo is defensible) or drop the invariant from the frozen repo's `AGENTS.md`. Restore the invariant and the Build and test section in the live repo, where it will actually be enforced.
- **Effort:** S
- **Blast radius:** None.

### [SEV-15] Guardrail config is copy-pasted from an unrelated repo

- **ID:** `agencyzero-full-15`
- **Severity:** Low
- **Category:** AI-smell / Maintainability
- **Confidence:** High
- **Location:** `agencyzero/.claude/settings.json:4-9` (allow-list is `bun run build`, `bun run test`, `bun run typecheck`, `bun run lint`, `bun install` in a repo with no JavaScript), both repos' `.claude/hooks/ask-before-risky-commands.sh:2` ("pathscale backend service") and `:75-76` (a rule gating `regenerate_endpoints`, which is an api.support.cafe/WorkTable concept that exists in neither repo), `agencyzero/AGENTS.md:72-79` (describes the guardrails as if tailored)
- **What:** The spike's `settings.json` was correctly adapted to Rust (`cargo build/check/test/fmt/clippy/tree`); the live repo's was not, and still carries the JS-toolchain allow-list. The hook script is byte-identical in both repos and still identifies itself as belonging to a backend service, with a rule for a code generator neither repo has. The header comment even instructs the reader to "Edit RISKY_WORDS for this repo", which nobody did.
- **Why it matters:** Not a security hole, since the hook fails open by design and the permission system is the real control. It is a reliability cost: the allow-list grants nothing useful in a Rust repo, so every routine `cargo` command prompts, and an agent trained by repeated prompting learns to click through them. The dead `regenerate_endpoints` rule is the tell that this file is inherited rather than reviewed.
- **Fix:** Copy the spike's Rust allow-list into the live repo, strip the `regenerate_endpoints` branch, and fix the header. Keep `RISKY_WORDS` and `permissions.ask` in sync as `CLAUDE.md` already instructs.
- **Effort:** S
- **Blast radius:** Agent ergonomics only.

---

## Threat model, stated concretely

**What an unprivileged local process (same user, no root, no SIP bypass) can achieve right now:** nothing from these repos. Nothing is installed. `launchctl print gui/501/com.24x.agencyzero.spike` returns "Could not find service in domain for user gui: 501"; there is no spike plist in `~/Library/LaunchAgents`; the live repo has no IPC surface at all. The only artifacts left on disk are a gitignored scratch keychain (`scripts/identities/spike.keychain-db`, password `spike-throwaway`, published in `make-identities.sh:14`) holding two throwaway code-signing identities with 30-day certificates, plus signed binaries under `results/`. Private keys are mode `0600` and correctly gitignored; `git ls-files` confirms nothing under `scripts/identities/` or `results/` is tracked. A same-user process could use `SpikeGood` to sign a binary that satisfies the spike's requirement string, which matters only if the spike listener were ever deployed, which it should never be.

**During a `validate.sh` run:** for a few seconds, `com.24x.agencyzero.spike` is registered in the `gui/$UID` bootstrap namespace with no peer requirement (phases A2, A3, and the attribution control). Any same-user process may connect and exchange echo messages. There is no privileged operation behind it, so the practical impact is nil; it is worth knowing only because it is a real, if trivial, window.

**A different user on the same Mac** cannot reach the service at all: a `gui/$UID` LaunchAgent lives in a per-user bootstrap namespace. Nothing here uses the privileged (system) bootstrap context; `XpcClientConfig` defaults to flags `0` (`src/client.rs:110-114`) and the spike never sets `privileged(true)`. That is the correct choice.

**Once the real channel ships**, the exposure becomes findings 01, 02, and 04 acting together: a same-user attacker with local code execution can (a) run a copy of the attested sidecar, (b) inject a dylib into it and still pass attestation, or (c) rewrite the LaunchAgent plist to remove the requirement entirely. All three defeat "the peer is attested" as an authorization basis. The correct conclusion is the one `iaai-27/xpc-spike-review.md:41-43` already reached and which belongs in the live repo's docs: peer attestation hardens the channel, and any decision that actually matters must be independently authorized (a mission token verified at the gate), never inferred from the fact that the connection exists.

**What the design gets right, and should not be lost in the noise above:** no PID-based authorization, no hand-rolled `audit_token` handling, no accept-then-validate ordering bug (libxpc drops non-matching peers at check-in, before Rust sees anything, which is architecturally stronger than any in-process check), no entitlement check done in the wrong process, and no authorization derived from message fields. The classic severe XPC failure modes are all absent.

---

## Message handling: parsing untrusted dictionaries

Reviewed the full decode path (`object.rs:134-287`) because that is where a hostile peer's bytes first become Rust values.

- **Panics from message content: none found.** Decoding is total: every branch is guarded by an `is_type` check before the type-specific accessor, unknown types return `XpcError::UnsupportedObjectType` rather than panicking, and the zero-length `Data` case is special-cased because `xpc_data_get_bytes_ptr` returns null there and `slice::from_raw_parts` requires non-null (`object.rs:185-195`). Neither spike binary calls `unwrap`/`expect` on anything derived from a peer; the only `unwrap_or_else` calls are on `std::env::args` during startup (`crates/agencyzero/src/main.rs:29`, `crates/agentone/src/main.rs:29`), which exit with code 64 and are not reachable from the wire.
- **Recursion is bounded** at `MAX_OBJECT_NESTING_DEPTH = 256` in both directions (`object.rs:17,70,139`), with tests at, below, and above the boundary. A deeply nested dictionary bomb returns an error instead of overflowing the stack. Good.
- **Type confusion: not present.** `is_type` compares against libxpc's exported type singletons by pointer identity (`object.rs:289-294`), which is the correct check, and every accessor is called only inside its matching branch.
- **Unbounded allocation from message-supplied sizes: partly.** `Data` is copied into a `Vec<u8>` sized by `xpc_data_get_length`, and strings by `CStr::from_ptr`; both are bounded by libxpc's own message-size ceiling rather than by anything in this code. The real amplifier is buffering, covered in finding 06.
- **Reply handle lifetime is handled correctly.** `ReceivedXpcMessage` holds an independent retain on the originating connection (`connection.rs:78-84,562-572`), so replying after the parent `XpcConnection` is dropped stays safe, and `reply(self, ...)` consumes the handle so a message cannot be replied to twice. `xpc_dictionary_create_reply` returning null (message not reply-capable) is turned into an error rather than dereferenced (`connection.rs:114-115`).
- **The one real defect is the echo shape itself** (findings 05 and 07): reflecting an attacker-chosen dictionary verbatim leaks fds and, in any real handler, would reflect attacker-chosen keys into whatever the peer's reply parser does with them.

---

## Design: the abstraction, and what a consumer must write

The spike deliberately used a narrow slice of the crate: bind, accept, recv, reply, connect, send_request, and one requirement setter. That was the right call and it is the thing that makes the recommendation cheap to reverse: a hand-rolled FFI module could replace the crate behind the same seven operations without touching either binary's logic.

**Does it generalise?** `cross-platform-peer-attestation.md` sets the goal: one internal trait, three backends (XPC requirement on macOS, `SO_PEERPIDFD` plus exe digest on Linux, SID-scoped DACL plus AppContainer on Windows). Nothing in the spike blocks that, but nothing in either repo starts it either: there is no trait, no `channel` module, no shared message type. The `az-core` crate exists for exactly this ("Anything two or more executables need ... lives here", `crates/core/src/lib.rs:3-5`) and is currently one constant. The natural next move is `az-core::channel` with a `PeerChannel` trait and a `PeerIdentity` type that can express "code-signature requirement satisfied" on macOS and "exe digest matched" on Linux, with the macOS backend the only implementor at first. Note the tension with the review brief's usual warning about single-implementor traits: here the second and third implementors are already specified in a design document, so the abstraction is justified, but only if the Linux backend follows within a reasonable horizon. If it does not, this should be a concrete struct.

**Boilerplate a consumer must write today**, measured from the spike: roughly 25 lines of listener setup and accept loop, plus a per-connection handler. The unavoidable, easy-to-forget parts are (a) checking `termination_reason()` because `bind()`'s `Ok` is meaningless, (b) wrapping every `send_request` in `tokio::time::timeout` because the crate has none, (c) setting both capacity knobs, and (d) not accepting fds. All four are one-liners that a wrapper should make impossible to omit: a `spawn_channel()` helper in `az-core` that returns a handle already bound, already requirement-enforced, already capacity-limited, and that treats listener termination as fatal, would reduce the consumer's job to writing a message handler. That is the single highest-value abstraction to build, and it is roughly 100 lines.

**Error handling** is fine at this scale: the crate has one `XpcError` with a `Connection(XpcConnectionError)` sub-enum, no context is discarded, and the spike prints both `Debug` and `Display` forms (`crates/agencyzero/src/main.rs:73`), which is what made the validation-A diagnosis possible. Keep that habit.

**Performance** is a non-issue at this scale and I found nothing worth optimizing: one connection, one message, decode cost proportional to message size. The only allocation worth naming is `received.message().clone()` in the echo handler (`crates/agencyzero/src/main.rs:54`), which exists because the handler wants both the original and a reply; a real handler will build a reply rather than clone the request. The dependency footprint (111 crates, 6 of them `rama-*`, verified: `results/deps.txt` is 111 lines with 6 `^rama` matches) is compile-time weight, not runtime attack surface, and the README characterises it accurately. `bindgen` as a build dependency does mean every build host and CI runner needs libclang, and build scripts run arbitrary code at build time, which is the more interesting supply-chain note.

---

## Docs accuracy against real code

Checked every substantive claim I could verify:

| Claim | Verdict |
|---|---|
| spike README:19-20 host/target, layout tree | Accurate |
| spike README:262 "roughly 200 lines of ordinary Rust with no `unsafe`" | Accurate: 254 lines, `grep -rn unsafe crates/` returns 0 |
| spike README:267 "111 unique transitive crates, 6 of them `rama-*`" | Accurate against `results/deps.txt` |
| spike README:57-69, 84-93, 181-231 validation transcripts | Consistent with `results/*.log` |
| spike README:16-17 "`validate.sh` ... leaves no system state behind" | Slightly overstated: it boots out the LaunchAgent and restores the keychain search list, but leaves `target/debug/agencyzero` codesigned with a throwaway identity, and leaves the scratch keychain plus private keys in the working tree. All inside the repo, all gitignored; reword rather than fix |
| spike README:170-176 leaf hash `cb34…78e2` | Stale relative to the current `results/`, which shows `ddb2f9d2…` because identities are regenerated per run. Harmless, but a reader diffing the two will stumble; say that the hash is run-specific |
| spike PLAN.md:29-30, 52 "a rejected peer surfaces as `PeerRequirementFailed` on the event stream" | Refuted by the spike's own validation C. PLAN is a historical pre-work document and the README corrects it, but it deserves a one-line correction banner since it is committed alongside a PDF render |
| spike README:151-155 symbol available from macOS 12.0 | Consistent with the SDK quote; validate.sh re-derives it from `$(xcrun --show-sdk-path)` |
| live README:11-18 layout, :20-41 build commands | Accurate |
| live README:44-47 "Status: step 0 ... stub binaries" | Accurate |
| live AGENTS.md:12-15 Invariants | Thin: one bullet plus a stray blank line, and no Build and test section, unlike the spike's |
| both CLAUDE.md guardrail description | Accurate as to mechanism, but describes a config that was not adapted to these repos (finding 15) |

**AI-smell, dead code, TODOs, tests.** `grep` for `TODO|FIXME|XXX|HACK` across both repos' Rust, shell, markdown, and TOML: zero hits. Dead code: one item, `sign.sh`'s `strip` mode (finding 10). No near-duplicate functions, no invented single-implementor abstractions, no defensive scaffolding for impossible states, no comments restating the code; the comments that exist explain non-obvious platform behaviour and earn their place. The prose in both READMEs is unusually good and evidence-led. **Tests: zero in both repos** (`grep -c '#\[test\]'` returns 0). For the spike that is defensible, since `validate.sh` is the test and the interesting behaviour is not unit-testable, though finding 11 argues it should assert. For the live repo it is simply too early. The one AI-smell tell in the whole set is finding 15's inherited hook config, and the `Co-Authored-By: Claude Fable 5` trailer on the spike's `4d6c5ae` and two later commits, which the repos' own later-added rule (`AGENTS.md`, "No AI attribution") forbids; history is not worth rewriting for it, but new commits should be clean.

---

## Cross-cutting recommendations

1. **Settle the channel topology before writing any IPC code** (findings 02, 04, 13). Named mach service versus inherited anonymous endpoint is a decision that shapes the API, the launchd story, the threat model, and the cross-platform backends. The spike proved the named-service path works; `cross-platform-peer-attestation.md` argues the inherited-channel path is both simpler and stronger for a parent-spawns-child topology, and that it makes the Linux and Windows backends nearly trivial. Plan: write the decision doc, prototype `XpcEndpoint::anonymous_channel()` handed to a spawned child (a day), then pick. What breaks: nothing, there is no consumer yet. This is the cheapest it will ever be.
2. **Make the secure configuration the only configuration** (findings 04, 05, 06). Whatever the topology, ship a single `az-core` constructor that binds with a mandatory requirement, sets both capacity knobs, treats listener termination as fatal, wraps requests in timeouts, and rejects fd-bearing messages. Roughly 100 lines that delete four separate ways to be silently insecure. What breaks: nothing yet.
3. **Move the security properties out of the code and into the release pipeline** (finding 01). Hardened runtime, library validation, a private entitlement on the sidecar, and a requirement that pins the entitlement rather than only the leaf certificate. This is the finding most likely to be forgotten, because it lives in signing and notarization rather than in Rust, and it is the one that decides whether attestation means anything at all.
4. **Write `agencyzero/docs/ipc-channel.md` now** (finding 03), even before the decision in item 1 is made, seeded with the four carried-forward constraints and the threat-model paragraph. The repo's own `AGENTS.md` requires it, the spike repo is labelled throwaway, and `iaai-27` is a paper-notes directory, not a home for engineering constraints.
5. **Build the unified-log watcher as a first-class component, not an afterthought** (finding 09). Rejected peers are invisible in-process; the only signal is `Dropping check-in message due to code signing requirement` in the unified log. That means peer-rejection alerting is a separate process with its own lifecycle, and it should be designed alongside the channel rather than bolted on when someone asks why the dashboard shows zero attacks.
6. **Re-audit the dependency on every upgrade** (finding 08, and the `asid` advice in finding 07). The crate is young, its docs are wrong in at least two places that matter, and its unsafe surface is where all of your unsafe now lives. A short checklist in the docs (re-read `object.rs` `unsafe impl`s, re-read `peer.rs::apply`, confirm the requirement is still applied before activation) makes that a fifteen-minute job per bump instead of a re-audit.

---

## Appendix: `unsafe` inventory

**Both reviewed repos contain zero `unsafe` blocks.** `grep -rn "unsafe" /Users/revenge/code/agencyzero-xpc-spike-test/crates/` and the equivalent in `agencyzero/` both return nothing. That is the concrete payoff of the crate-versus-FFI decision and it matches the README's claim exactly.

All `unsafe` on the privilege boundary therefore lives in `rama-net-apple-xpc` 0.3.0. Counts of lines containing `unsafe` per file: `object.rs` 52, `connection.rs` 31, `listener.rs` 8, `peer.rs` 6, `endpoint.rs` 4, `util.rs` 3, `client.rs` 1, `integration_tests.rs` 2. I read `object.rs`, `connection.rs`, `peer.rs`, `client.rs`, and `util.rs` in full, plus `listener.rs`'s bind and accept paths. `endpoint.rs`, the `router/` module, and `xpc_serde/` were skimmed only, and the spike uses none of them.

The table groups the blocks by call site, which is how the invariants actually partition; the four `unsafe impl`s and every distinct FFI pattern are listed individually.

| # | Site | Invariant required | Enforced? |
|---|---|---|---|
| 1 | `object.rs:44` `unsafe impl Send for OwnedXpcObject` | The wrapped `xpc_object_t` may be moved across threads | By Apple's contract; no SAFETY comment. Plausible |
| 2 | `object.rs:45` `unsafe impl Sync for OwnedXpcObject` | The object is never mutated while shared | **Not enforced by the type**; true only by current usage. Finding 08 |
| 3 | `connection.rs:186` `unsafe impl Send for XpcConnection` | Constituents are `Send` | Justified in comment; holds |
| 4 | `connection.rs:193` `unsafe impl Sync for XpcConnection` | The non-`Sync` `Receiver` is reachable only via `&mut self` | Justified and enforced: `recv` is the sole accessor and takes `&mut self` |
| 5 | `object.rs:61` `xpc_retain` | Pointer non-null; balanced by one `xpc_release` | Enforced: null-checked at `:56`, released in `Drop` at `:302` |
| 6 | `object.rs:78-98` `xpc_*_create` scalar constructors | Arguments valid; result null-checked | Enforced via `from_raw` at `:131`, which rejects null |
| 7 | `object.rs:86` `xpc_string_create` | No interior NUL | Enforced: `make_c_string` returns `InvalidCString`; unit test at `:392` |
| 8 | `object.rs:90` `xpc_data_create` | `ptr` valid for `len` bytes | Enforced by `Vec` invariants |
| 9 | `object.rs:96` `xpc_uuid_create` | Exactly 16 readable bytes | Enforced by the `[u8; 16]` type |
| 10 | `object.rs:103` `xpc_retain` on an endpoint | Balances the new owner's release | Enforced |
| 11 | `object.rs:108-127` array/dictionary build | Container is a valid mutable object; recursion bounded | Enforced: depth cap at `:70`, tested |
| 12 | `object.rs:148-213` typed accessors | Runtime type matches the accessor | Enforced: every accessor sits behind its `is_type` guard |
| 13 | `object.rs:176-179` `xpc_string_get_string_ptr` + `CStr::from_ptr` | Returned pointer non-null for a string object | Relies on Apple's contract; **not null-checked**. Unreachable in practice given the type guard, but the one accessor without a defensive check |
| 14 | `object.rs:193-194` `xpc_data_get_bytes_ptr` + `from_raw_parts` | Non-null pointer to `len` initialized bytes | Enforced: `len == 0` short-circuited at `:185-189` |
| 15 | `object.rs:201` `xpc_fd_dup` | Caller owns and must close the returned fd | **Not enforced**: `XpcMessage::Fd` is a bare `RawFd` with no `Drop`. Finding 05 |
| 16 | `object.rs:206-208` `xpc_uuid_get_bytes` | Exactly 16 readable bytes | By contract; copied into a fixed array |
| 17 | `object.rs:234-239`, `:268-273` `xpc_array_apply` / `xpc_dictionary_apply` with a `StackBlock` | The block must not outlive the scope, so `apply` must be synchronous | Documented and correct: both are synchronous; the `recv` loop bounded by `get_count` cannot deadlock |
| 18 | `object.rs:292` `xpc_get_type` | Object valid and non-null | Enforced by construction |
| 19 | `object.rs:302` `xpc_release` in `Drop` | Exactly one release per owned reference | Enforced: every constructor takes exactly one |
| 20 | `connection.rs:10-13` local `extern "C" { free }` | Signature matches libSystem's | Correct, and the comment explains why `CString::from_raw` would be wrong (allocator mismatch). Good |
| 21 | `connection.rs:114` `xpc_dictionary_create_reply` | May return null for a non-reply message | Enforced: `from_raw` turns null into an error |
| 22 | `connection.rs:122,130` `xpc_dictionary_set_value` / `send_message` | Valid dictionary, valid C-string key, valid value; connection alive | Enforced: `ReceivedXpcMessage` holds an independent retain on the connection |
| 23 | `connection.rs:241-247` `set_event_handler` + `resume` | The block must outlive libxpc's use; `resume` exactly once | Correct: `_Block_copy` semantics documented in the comment; `resume` is called once per construction |
| 24 | `connection.rs:253` `xpc_connection_get_pid` inside a `tracing` field | Connection alive | Enforced; logging only |
| 25 | `connection.rs:285` `send` | Connection and object valid | Enforced by `&self` lifetime |
| 26 | `connection.rs:338-345` `send_message_with_reply` | Reply block copied by libxpc; invoked at most once | Correct; the `Mutex<Option<Sender>>` also makes a double invocation harmless |
| 27 | `connection.rs:413-435` `pid`/`euid`/`egid`/`asid` | Connection valid | Memory-safe; **semantically a trap**, see finding 07 |
| 28 | `connection.rs:445-455` `xpc_connection_get_name` | Pointer null or a valid borrowed C string | Enforced: explicit null check, copied to `String` |
| 29 | `connection.rs:466,476,485,503` cancel/suspend/resume | `cancel` idempotent; suspend/resume must be balanced | `cancel` enforced; **suspend/resume balance is the caller's job** and unbalanced use crashes. Neither spike binary calls them |
| 30 | `connection.rs:521,526-530,612,618-643` type and error-singleton comparisons | Type singletons are process-lifetime statics | Correct; pointer identity is the right comparison |
| 31 | `connection.rs:657-666` `copy_invalidation_reason` + `libc_free` | malloc'd string; copy before free; free exactly once | Enforced and correctly reasoned |
| 32 | `connection.rs:682-690` `xpc_dictionary_get_string` | Borrowed string valid for the event's lifetime | Enforced: null-checked, copied |
| 33 | `peer.rs:86-148` the six `set_peer_*_requirement` calls | Applied **before** activation; non-zero return means failure | Enforced: applied at `listener.rs:226-228` and `client.rs:123-125`, both before `activate`/`resume`; return code checked at `peer.rs:152-159`. This is the security-critical block and it is correct |
| 34 | `listener.rs:217-223` `create_mach_service(LISTENER)` | Valid C-string name; correct flag; null-checked | Enforced |
| 35 | `listener.rs:~378-384` `set_event_handler` + `activate` | Same as row 23; serialized under the registry lock | Enforced |
| 36 | `client.rs:119-120` `create_mach_service` with flags 0 or PRIVILEGED | Valid name and flags | Enforced; the spike always uses 0, i.e. the per-user namespace |
| 37 | `util.rs:22-23` local `extern "C" { dispatch_release }` | Real libdispatch symbol; the `+1` from `dispatch_queue_create` is ours | Correct, with a good explanatory comment |
| 38 | `util.rs:47` `dispatch_queue_create` | Label outlives the call (libdispatch copies it); null on failure | Enforced: `QueueCreationFailed` on null |
| 39 | `util.rs:63` `dispatch_release` in `Drop` | Release exactly the one retain we hold | Enforced: null-guarded |
| 40 | `endpoint.rs:56,75,108,113` endpoint create/convert | Valid connection or endpoint object; results null-checked | Skimmed only; unused by the spike |

C-string handling is uniformly correct: every string crossing the boundary goes through `make_c_string`, which rejects interior NULs, and every string coming back is copied with `to_string_lossy` before the borrow ends. Retain/release is balanced at every site I traced, with the two subtle cases (the independent connection retain for a deferred reply, and the `+1` dispatch queue) explicitly reasoned about in comments. The two blocks worth watching on upgrade are rows 2 and 15.

---

## What I did not cover

- **I did not run the spike.** No `validate.sh` execution, no `launchctl bootstrap`, no signing, no injection test. That is deliberate: the run mutates the keychain search list and registers a LaunchAgent, and the review brief forbids mutating state. Consequently findings 01 and 05 are reasoned from the code, the signature flags, and Apple's documented behaviour rather than from an executed exploit. Finding 01 in particular deserves a five-minute empirical confirmation before it is quoted anywhere external.
- **I did not build the Tauri GUI.** `cargo check` on the four non-GUI crates is clean; the webview toolchain build is slow and the brief permits skipping it. Finding 12 is a config reading, not a runtime observation.
- **`endpoint.rs`, `router/`, `server.rs`, and `xpc_serde/` in the dependency were skimmed, not audited.** The spike uses none of them. If the real implementation adopts `XpcServer` or the typed router (which is likely, since they remove boilerplate), those need their own pass, especially `xpc_serde`'s deserializer against hostile input.
- **No supply-chain audit beyond counting.** No `cargo audit` (no network), no review of the 111 transitive crates, no check of `rama-*` provenance. `Cargo.lock` is committed in both repos and pins exact versions, which is the important part.
- **macOS 13 behaviour is unverified**, as the spike README already flags. Everything here was observed on macOS 26.5, and libxpc's bootstrap-namespace behaviour has shifted across releases before.
- **No review of the `iaai-27` paper claims themselves**, only of the engineering notes as context.

---

## Quick-start for the follow-up agent

**Read in this order:**

1. `agencyzero-xpc-spike-test/README.md`: the validated findings and the friction list; the single densest document in either repo.
2. `agencyzero-xpc-spike-test/crates/agencyzero/src/main.rs` (135 lines): the listener template the real implementation will grow from. Note the stale comment at lines 71-72 is wrong (finding 10).
3. `iaai-27/cross-platform-peer-attestation.md` §0: the reframe that likely makes finding 02 disappear, and the reason the macOS backend may not want a named service at all.
4. `~/.cargo/registry/src/index.crates.io-*/rama-net-apple-xpc-0.3.0/src/peer.rs`: 161 lines, the security-critical file in the dependency; confirm `apply` is still called before activation on any version bump.
5. `agencyzero/apps/gui/tauri.conf.json`: 30 lines, and the only security-relevant config in the live repo today.

**Commands (all read-only or cheap):**

```bash
# both repos type-check offline in seconds once the target dirs are warm
cd /Users/revenge/code/agencyzero-xpc-spike-test && cargo check --offline --all-targets
cd /Users/revenge/code/agencyzero && cargo check --offline -p az-core -p az-agent -p az-mcp-proxy -p az-agent-proxy

# the spike's fmt failure (finding 14); clippy is clean in both
cd /Users/revenge/code/agencyzero-xpc-spike-test && cargo fmt --check

# confirm the signing-flags finding (01) without running anything
codesign -dv --verbose=4 /Users/revenge/code/agencyzero-xpc-spike-test/results/agentone-good 2>&1 | grep flags

# confirm nothing is deployed
launchctl print "gui/$(id -u)/com.24x.agencyzero.spike"

# the full spike re-run. MUTATES SYSTEM STATE (keychain search list, LaunchAgent). Do not run casually.
# ./scripts/validate.sh
```

**Surprises about the layout:**

- `results/` and `scripts/identities/` exist on disk but are gitignored and untracked; they are the evidence for the README's claims and are not reproducible from git alone. If that machine is wiped, the evidence goes with it. Consider committing the log files (not the keys or binaries) if the paper is going to cite them.
- The certificate hashes in the spike README do not match the ones currently in `results/`, because identities are regenerated per run. Neither is wrong.
- `PLAN.pdf` is a committed 250 KB render of `PLAN.md` and will drift from it. It already has, in the sense that PLAN's assertion about `PeerRequirementFailed` was refuted by the work it planned.
- The spike commit `4d6c5ae` and two later commits carry `Co-Authored-By: Claude Fable 5` trailers, which both repos' `AGENTS.md` now forbids. Not worth rewriting history; do not add more.
- Reflog only: `agencyzero`'s `HEAD@{12}` is the orphaned spike commit `0a888dd` from before the split. It is unreachable from any branch and will be garbage-collected eventually. Nothing depends on it.

<details>
<summary>Nits</summary>

- `agencyzero/AGENTS.md:15-16`: the Invariants section has one bullet followed by two blank lines, as if content was removed mid-edit.
- `agencyzero-xpc-spike-test/scripts/validate.sh:22,98`: `security list-keychains -d user -s $(cat "$SEARCH_BACKUP")` is deliberately unquoted for word splitting, which breaks on a keychain path containing spaces. The `shellcheck disable=SC2046` acknowledges it.
- `make-identities.sh:29`: the throwaway certificates are valid for 30 days, so a re-run after 2026-08-24 behaves differently from the recorded run; nothing warns about it.
- `validate.sh` uses `set -uo pipefail` without `-e`, so every phase runs even after an earlier one fails (finding 11).
- `crates/agencyzero/src/main.rs:67-69`: the `XpcEvent::Connection(_)` arm on a peer connection logs "unexpected nested connection"; it is unreachable in this topology, mild defensive scaffolding, but cheap and it documents an assumption.
- `agencyzero/Cargo.toml:20`: `[profile.release] strip = true` strips symbols, which is fine, but note it also makes crash reports from the field much harder to read for a desktop app that will want them.
- The live repo's `.gitignore` ignores `/apps/gui/gen/schemas`, so the generated capability schemas are not tracked; `capabilities.json` is currently `{}`. Worth revisiting when finding 12 is addressed, since capabilities are security config.
- Both repos' `CLAUDE.md` instruct keeping the hook's `RISKY_WORDS` in sync with `permissions.ask`; they currently are, but both lists are inherited from another project (finding 15).

</details>
