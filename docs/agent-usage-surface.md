# Account usage and status, against `agent-abstraction` 0.3.1

> **Landed.** 0.3.1 added `Agent::reports_account_usage()` and
> `Agent::account_usage() -> AccountUsage`, and `apps/gui/src/quota.rs` consumes
> them. `list_quota` asks every agent and the tab strip renders whatever comes
> back. The gaps that remain are listed at the bottom.

## What the crate answers, and who answers it

`account_usage` is asked per agent, and **only Codex reports it**. That is not a
limitation to route around, it is the correct answer:

- **Codex** answers in full through `codex app-server`: percentages, window
  lengths, reset times, credits, lifetime totals.
- **Claude** reports quota only *during* a run, as `Event::RateLimit` — the
  window, its reset time, and whether the request was allowed. The percentages
  its `/usage` screen shows are not on the wire, and that screen says its own
  figures are approximate and cover only local sessions on one machine. Scraping
  them would produce a number that looks authoritative and is not.
- **Copilot** reports session spend only.

So the readout shows a real figure where one exists and says why there is none
where it does not. `AgentQuota::supported` keeps "cannot ask" apart from "asked,
nothing in force" — a bare empty list flattens two opposite meanings into one.

## The other thing 0.3.1 fixed

`RateLimit::is_blocking()` — `status != "allowed"`. The crate emits a rate-limit
record on healthy runs too, as a heartbeat. Treating every record as a limit put
an orange "allowed (five_hour)" warning in the header of a run that was never
restricted, and turned its tab dot amber. The flag is now carried through to the
webview as `isBlocking`, and nothing renders a warning without it.

---

The window has two usage readouts and a status dot per tab. Some of what they
should show is not obtainable today. This is the concrete list, written as an
interface proposal rather than a wish, because the offer on the table is to move
these semantics into the crate and expose them.

**The rule this document is written under:** a number that is quietly wrong is
worse than one that is absent. Every gap below is currently rendered as "not
reported" rather than estimated, and none of it should be inferred from a local
price table or a scraped file if the answer can be asked for properly.

## What exists now, and is already used

| | |
| --- | --- |
| `Outcome::usage` → `Usage` | Per finished turn: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `premium_requests`. The GUI sums these into the composer and tab-strip readouts. |
| `Event::RateLimit` → `RateLimit` | `status` (the provider's own wording, e.g. `allowed (five_hour)`), `window`, `resets_at`. Arrives **only** when a run happens to hit one. |
| `Outcome::session` / `Event::Started` | The native session id. Now persisted on the project and shown in the header. |

Everything the GUI reports is therefore summed from **its own runs**. Work done in
another client does not appear, and nothing here can answer "how much of my plan
is left".

## Closed — quota without running something first

`Event::RateLimit` is a *notification*: it fires mid-run when a limit is hit or
approached. There is no way to ask "where do I stand" before sending anything, so
a freshly opened window cannot show a quota at all, and the tab-strip readout
stays blank until a run trips a limit.

What the GUI would consume:

```rust
/// Where the account stands right now, without running a turn.
pub async fn quota(agent: Agent) -> Result<Vec<QuotaWindow>, Error>;

#[non_exhaustive]
pub struct QuotaWindow {
    /// The provider's own name for it: "five_hour", "weekly", "opus_weekly".
    pub window: String,
    /// Which model this window applies to, when it is per-model rather than
    /// account-wide. `None` means account-wide. See gap 2.
    pub model: Option<String>,
    /// Fraction consumed, 0.0..=1.0. `None` when the provider reports a state
    /// but not a proportion — do not synthesise one from `used`/`limit` unless
    /// the provider gave both.
    pub used_fraction: Option<f64>,
    /// Absolute figures when the provider gives them, in its own unit.
    pub used: Option<u64>,
    pub limit: Option<u64>,
    /// The unit `used`/`limit` are counted in: "tokens", "requests", "messages".
    pub unit: Option<String>,
    /// When this window rolls over.
    pub resets_at: Option<i64>,
    /// The provider's own wording, for display when the numbers are absent.
    pub status: String,
}
```

`Error::Unsupported` for an agent that cannot answer is fine and expected — the
GUI already greys out what a backend does not implement. **An empty `Vec` must
mean "the provider reports no limits", not "we could not ask"**; those are
different and the UI renders them differently.

## Still open — per-model quota

The ask that motivated this is "Fable quota/usage" specifically: Claude bills
some models against their own allowance, so one aggregate number is not enough.
`QuotaWindow::model` above covers it without a second call — `None` for an
account-wide window, the model id for a per-model one. The GUI already labels a
window by its model when there is one, so nothing else has to change.

## Still open — usage for a turn that did not finish

`Usage` arrives on `Outcome`, so a cancelled or crashed run reports nothing and
its spend is invisible. A `Usage` snapshot on `Event::Started`'s counterpart —
or simply on `Run::cancel`'s return — would let the session total stay honest
across an interrupted turn.

## Still open — per-tool cancellation, for the Running panel

Not usage, but the same shape of gap and worth listing here since it is the other
thing the crate blocks. `Run::cancel` kills the whole run; the design has a Stop
button per running tool call. Without something like
`Run::cancel_tool(&self, tool_call_id: &str)` the per-row button cannot be
implemented, so `cancel_task` is deliberately absent from `IMPLEMENTED` and the
control stays greyed out rather than appearing to stop something it cannot.

## Still open — the raw stream, for the Agent I/O panel

The panel shows the parsed event stream because that is what the crate exposes.
`Outcome::stderr` is kept, and `unparsed` / `first_unparsed` flag lines the parser
could not read, which covers the important case. What is missing is the raw
stdout the events were parsed *from* — useful when the question is "did the CLI
really say that, or did we mis-parse it".

A cheap version: an opt-in `Request::capture_raw(bool)` that adds
`Event::Raw(String)` per source line, off by default so a long run does not pay
for a diagnostic nobody opened.

## Status semantics — no crate change needed

Recorded here so the two documents do not drift. The tab dot is derived entirely
GUI-side and needs nothing new:

| colour | state | source |
| --- | --- | --- |
| green | `ready` — active and idle, waiting for input | `Project.status == "active"` with nothing running |
| amber | `running` — thinking, replying, or running a tool | a live `RunningTask` |
| red | `blocked` — a moderation hold, or a live rate limit | `Message.moderation.needsApproval`, or a live `RateLimit` |
| red | `error` — a critical hold, which cancelled the run | `moderation.severity == "critical"` |
| grey | `quiet` — inactive: finished, cancelled, or not started | any other `Project.status` |

**This departs from `design/data-model.html`**, which maps a check-severity hold
to amber and only a critical one to red. Amber now means "the agent is busy", so
a hold — which needs a person — cannot also be amber. Both hold severities are
therefore red, and they remain distinguishable in the transcript.

The green is new: `ready` and `quiet` used to be one grey state, which meant a
project waiting on you looked exactly like one you had closed out.

One consequence to be aware of: `set_project_status` is not implemented in Rust
yet, so every project stays `active` and nothing reaches `quiet` in the real
backend. The grey state is reachable in the design fixtures and will start
appearing as soon as that command lands.
