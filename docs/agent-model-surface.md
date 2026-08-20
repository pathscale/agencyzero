# Agent model and parameter surface

What each agent CLI will tell us about the models it can run, and which parameters we
can send per turn.

This began as the reference behind the hardcoded `MODELS` list in `labels.ts`. That
constant is gone: Settings now offers `agent-abstraction`'s catalogue and the prompt
shows what the user enabled. What remains open is `list_agent_status(recheck)`, still
specified to probe the installed CLIs and still returning fixtures. See
[`gui-wiring-plan.md`](gui-wiring-plan.md).

**Probed 2026-07-29 on macOS** against `claude` 2.1.205, `codex-cli` 0.145.0, and
GitHub Copilot CLI 1.0.75. Everything marked *verified* was run locally; everything
marked *unverified* is called out as such. Re-run the probes when bumping a CLI: all
three ship model lists that move.

## What the GUI actually calls

Since 0.2.2, [`agent-abstraction`](https://crates.io/crates/agent-abstraction) carries
this research as code, and `apps/gui` reads the catalogue from there rather than
re-deriving any of it:

| Call | What it gives |
| --- | --- |
| `Agent::models()` | The compiled catalogue: `id`, `name`, `note`, `kind`, `efforts`, `is_default` |
| `Agent::models_verified()` | `source` / `checked` / `against`, so a stale list can be recognised as stale |
| `Agent::discover_models()` | Asks the CLI. Codex answers; Claude and Copilot return `Error::Unsupported` |

The Tauri command is `list_models(discover)` in
[`apps/gui/src/main.rs`](../apps/gui/src/main.rs), and Settings renders the result with
its provenance visible. The rest of this document is the evidence behind those entries
and stays useful for two things: judging how much to trust a given list, and re-deriving
it when a CLI moves.

**The catalogue is advisory, never an entitlement.** What an agent offers and what an
account may use are different sets, and only the account knows the second. The crate's
own example: a Copilot Free plan lists twenty-three models and permits exactly one. So a
picker offers choices to try, and the run reports what the account actually allows.

## Authentication: OAuth throughout, no API keys

All three CLIs authenticate by subscription OAuth on this machine, and every technique
below works under that. **Nothing here needs `ANTHROPIC_API_KEY`, and nothing calls the
Anthropic API directly.** That is deliberate. Enumeration reads what the CLI already
knows, so the GUI inherits whatever session the user has already established.

Two consequences worth holding on to:

- `claude --betas <...>` is documented as *"API key users only"*. Do not expose it in
  settings; under OAuth it is dead weight.
- Model lists are per-account. A Max subscriber and a Pro subscriber see different
  entries, so the catalog is a runtime probe and never a compile-time constant.

`claude auth status` prints JSON on stdout and is the cleanest liveness probe we have:

```json
{ "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
  "email": "...", "orgId": "...", "orgName": "...", "subscriptionType": "max" }
```

That maps almost field-for-field onto `AgentStatus` and answers `logged_out` directly.
Codex stores its OAuth in `~/.codex/auth.json`; Copilot records the logged-in account in
`~/.copilot/config.json` (`lastLoggedInUser`).

## Codex: fully solved

`codex debug models` renders the raw model catalog as JSON on stdout. It is
non-interactive, machine-readable, needs no API key, and is a documented subcommand
(`codex debug --help`). This is the one agent where enumeration is a solved problem.

It is backed by `~/.codex/models_cache.json`, which carries `fetched_at`, `etag`, and
`client_version`, so the CLI fetches with the user's OAuth and caches. Reading the
cache file directly would also work but the subcommand is the supported interface.

Per-model fields, all verified present:

| Field | Use in the GUI |
| --- | --- |
| `slug`, `display_name`, `description` | picker entries |
| `supported_reasoning_levels[]` | effort ladder, **per model**, each with a human `description` |
| `default_reasoning_level` | preselected effort |
| `visibility` | `list` or `hide`. Filter out `hide` |
| `priority` | display order |
| `context_window`, `max_context_window` | context meter |
| `default_verbosity`, `support_verbosity` | verbosity control |
| `supports_parallel_tool_calls`, `supports_search_tool`, `input_modalities` | capability gating |
| `additional_speed_tiers`, `service_tiers` | speed and tier selector |
| `supported_in_api`, `tool_mode`, `apply_patch_tool_type`, `web_search_tool_type`, `truncation_policy`, `base_instructions` | not needed by the GUI |

The catalog on this account listed 7 models. Six are `visibility: list`
(`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`)
and one is `hide` (`codex-auto-review`). All report a 272000 context window.

**The effort ladder is per model, not per agent.** `gpt-5.6-sol` and `gpt-5.6-terra`
support `ultra`; `gpt-5.6-luna`, `gpt-5.5` and `gpt-5.4` stop at `max`. This is the
single most important finding for our data model, and it generalises: an effort list
belongs to a `(agent, model)` pair.

## Claude: the list is the Models API, not the CLI

**The authoritative list is `GET https://api.anthropic.com/v1/models`.** It is
account-scoped, so it answers "which models can *this* login actually use", and it
returns `id`, `display_name`, `max_input_tokens`, `max_tokens` and a `capabilities`
tree. Confirmed that this is what Claude Code itself uses: the string `/v1/models` is
embedded in the binary.

Under OAuth the call needs `Authorization: Bearer <token>` plus
`anthropic-beta: oauth-2025-04-20`, **not** `x-api-key`. Claude Code's token lives in
the macOS Keychain under service `Claude Code-credentials`.

> **Unverified.** The end-to-end OAuth call was not run on this machine: reading the
> token out of the Keychain and sending it to a network endpoint was blocked by a local
> permission guard, and that block was left in place. The endpoint and the header shape
> are documented and the endpoint is confirmed present in the binary, but the response
> under a subscription OAuth token has not been observed here. Verify before building on
> it.

There is deliberately **no CLI-side enumeration**. `claude models` is not a subcommand
(it is parsed as a prompt), there is no `--list-models`, and the subcommand list is
`agents auth auto-mode doctor gateway install mcp plugin project setup-token
ultrareview update`.

What *is* readable locally is Claude Code's own cache of the server response, in
`~/.claude.json`:

- `additionalModelOptionsCache` holds the account's extra entries, already picker-shaped:
  `[{"value": "claude-fable-5[1m]", "label": "Fable", "description": "Fable 5 · Most capable for your hardest and longest-running tasks"}]`
- `modelAccessCache` (`[]` on this account), `orgModelDefaultCache` (`null`),
  `additionalModelCostsCache`, `autoCompactWindowsCache`.

These are private Claude Code state, undocumented and free to change between releases.
Useful as corroboration, not as an interface.

### Aliases are more than four, and include context variants

`--model` accepts an alias for the latest model as well as a full id. The help text
gives `fable`, `opus`, `sonnet` as examples, and the binary additionally contains
`default`, `opusplan`, `sonnet[1m]`, and `[1m]` long-context variants of full ids such
as `claude-opus-4-7[1m]` and `claude-sonnet-4-6[1m]`. Treat the alias set as **open**;
do not hardcode a closed list of four. Verified: `--model opus` resolved to
`claude-opus-4-8` in the run envelope.

Real model ids and their limits also come back **after** a run. With
`--output-format json`, the result envelope carries `modelUsage` keyed by resolved
model id:

```json
"modelUsage": {
  "claude-opus-4-8": { "inputTokens": 3365, "outputTokens": 4,
    "cacheReadInputTokens": 17026, "cacheCreationInputTokens": 2201,
    "costUSD": 0.0475, "contextWindow": 1000000, "maxOutputTokens": 64000 }
}
```

`contextWindow` and `maxOutputTokens` are exactly what the context meter needs, and
`costUSD` plus the sibling `total_cost_usd` field feed the run cost display. Note the
envelope reports *every* model a turn touched, not just the one requested, because
Claude Code uses a small model for side tasks. This is a useful enrichment source but
it is not enumeration: it only ever describes models a run actually used.

### The open decision for us

**Superseded for the picker.** Settings now offers the crate's compiled alias and pinned
lists, and the user chooses which of them to show, which sidesteps the per-account
question entirely: a model the plan does not cover simply fails at run time with the
provider's own wording. What follows still applies if we ever want the picker to be
account-accurate rather than account-agnostic, which would mean hiding models the login
cannot reach instead of letting them fail.

`/v1/models` is the right answer there, but agencyzero drives the CLI and does not hold a
token of its own. Three ways to close that gap, and this is a decision, not a
recommendation:

1. **Ask for an API key in settings**, used *only* for enumeration while runs continue
   to go through the OAuth'd CLI. Clean and documented, at the cost of asking the user
   for a credential the app does not otherwise need.
2. **Read Claude Code's Keychain item.** No new credential to ask for, but a
   third-party app reaching into another app's Keychain entry is invasive and breaks
   whenever Claude Code changes its storage.
3. **Ship a static list plus validation.** No credential, no coupling, but the list
   goes stale and is not account-scoped, so it can offer models the user cannot run.

Option 1 is the only one that is both supported and account-accurate.

Validation is cheap. An unknown model fails fast, before any tokens are spent, with
`There's an issue with the selected model (X). It may not exist or you may not have
access to it.`

Other envelope fields worth wiring: `session_id`, `stop_reason`, `terminal_reason`,
`is_error`, `api_error_status`, `num_turns`, `permission_denials`, `duration_ms`,
`ttft_ms`, `fast_mode_state`.

## Copilot: no supported enumeration found

This is the gap. No `--list-models`, no local model cache in `~/.copilot`, and the
155MB binary yielded no greppable catalog. `/model` exists but is interactive only, so
it is unusable from a harness.

What we do have:

- `--model <model>` accepts a model id or `auto`, where `auto` is a router rather than
  a model. Session logs show the routing decision, for example
  `{"chosenModel":"gpt-5-mini","candidateModels":["gpt-5-mini","claude-haiku-4.5"],"routingMethod":"hydra"}`.
  Copilot fronts both OpenAI and Anthropic models, so its ids overlap Claude's and
  Codex's and **must stay namespaced by agent**.
- Validation is clean: `Error: Model "X" from --model flag is not available.`
- Help text names `gpt-5.4` as an example model.

The remaining avenue is the GitHub Copilot models endpoint, which needs a Copilot token
exchanged from the GitHub OAuth token. **Unverified**: the probe was blocked by a local
permission guard and was not retried. It is also an internal, undocumented endpoint, so
even if it works it is a poor foundation.

**Recommendation:** ship a short static list plus `auto`, validate lazily on first use
via the CLI's own error, and surface an unknown model as a settings-level warning rather
than a failed run. Revisit if Copilot ships a supported enumeration.

## Per-turn parameters

Verified from `--help` on each CLI.

| Concern | claude | codex | copilot |
| --- | --- | --- | --- |
| Model | `--model <alias\|id>` | `-m, --model <slug>` | `--model <id\|auto>` |
| Effort | `--effort low\|medium\|high\|xhigh\|max` | `-c model_reasoning_effort=<level>` | `--effort none\|minimal\|low\|medium\|high\|xhigh\|max` |
| Session | `--session-id <uuid>`, `--resume`, `--fork-session`, `--continue` | `resume`, `fork`, `--last` | `--session-id <id>`, `--resume`, `--continue` |
| Streaming events | `--output-format stream-json`, `--include-partial-messages` | `exec --json` (JSONL) | `--output-format json` (JSONL), `--stream on\|off` |
| Structured output | `--json-schema <schema>` | `exec --output-schema <FILE>` | none |
| System prompt | `--system-prompt`, `--append-system-prompt` | `-c developer_instructions=...` | via `AGENTS.md`, `--no-custom-instructions` |
| Working dirs | `--add-dir` | `-C/--cd`, `--add-dir` | `-C <dir>`, `--add-dir` |
| Tool allow/deny | `--allowed-tools`, `--disallowed-tools` | execpolicy rules | `--allow-tool`, `--deny-tool`, `--available-tools`, `--excluded-tools` |
| Turn cap | `--max-turns` | n/a | `--max-autopilot-continues`, `--max-ai-credits` |
| Model fallback | `--fallback-model <a,b>` | n/a | `auto` routing |

Codex takes arbitrary config as `-c key=value`, TOML-parsed, which covers anything not
exposed as a flag. Confirmed keys relevant to us: `model_reasoning_effort`,
`plan_mode_reasoning_effort`, `model_verbosity`, `model_reasoning_summary`,
`model_context_window`, `model_auto_compact_token_limit`, `approval_policy`,
`sandbox_mode`, `sandbox_workspace_write`, `service_tier`, `model_catalog_json`.

Copilot also supports bring-your-own-provider through `COPILOT_PROVIDER_BASE_URL` and
friends (`openai`, `azure` or `anthropic` provider types). Out of scope for now, but it
is the escape hatch if we ever need Copilot pointed somewhere else.

## Where our current type model is lossy

Two places, both worth fixing before the picker is wired.

**Effort is per model.** Codex proves it: `gpt-5.5` has no `ultra`, `gpt-5.6-sol` does.
The ladders also differ per agent. Claude has five levels, Copilot seven (it adds
`none` and `minimal` below `low`), Codex up to six. A single global effort enum will
either offer levels that 400 or hide levels the model supports.

**Permission is two axes for Codex, one for the others.** `Permission` in
[`types/index.ts`](../apps/gui/frontend/src/types/index.ts) is
`read_only | plan | edit | auto | bypass`, a single ladder. Codex genuinely has two
orthogonal controls: `--sandbox read-only|workspace-write|danger-full-access` and
`--ask-for-approval untrusted|on-request|never`. Collapsing them loses real
combinations, for instance workspace-write with never-ask.

A first mapping, with the lossiness made explicit:

| Ours | claude `--permission-mode` | codex `--sandbox` + `--ask-for-approval` | copilot |
| --- | --- | --- | --- |
| `read_only` | `plan` | `read-only` + `untrusted` | `--deny-tool` write set |
| `plan` | `plan` | `read-only` + `on-request` | `--mode plan` |
| `edit` | `acceptEdits` | `workspace-write` + `on-request` | default interactive |
| `auto` | `auto` | `workspace-write` + `never` | `--mode autopilot` |
| `bypass` | `bypassPermissions` | `danger-full-access` + `never` | `--allow-all` / `--yolo` |

Claude has `manual` and `dontAsk` with no home in our ladder; Codex's four unused
sandbox/approval pairs have none either. Either widen `Permission` to a two-axis type
or document these as deliberately unreachable. **This is a decision, not a mechanical
fix, and it is not made yet.**

## What shipped

`list_models(discover)` returns one entry per agent, and Settings renders it:

```ts
interface Model {
  id: string;        // what goes on the command line, verbatim
  name: string;      // the vendor's display name
  note: string;      // one line, empty when the vendor offers none
  kind: "alias" | "pinned";
  efforts: string[]; // per model, not per agent
  isDefault: boolean;
}

interface AgentModels {
  agent: Agent;
  models: Model[];
  source: "cli" | "picker" | "docs";  // weakest evidence behind any entry
  checked: string;
  against: string;
  discovered: boolean;  // true only when the CLI was asked just now
}
```

`source` and `discovered` are rendered, not just stored. Two of the three lists were not
obtained from the installed binary, and a picker that presents a documented list and an
interrogated one identically invites equal trust in both.

The user's choice per agent lives in `GlobalSettings.models`, a
`Record<Agent, { enabled: string[]; default: string }>`. Two invariants are enforced in
the store rather than the UI, so a keyboard path cannot route around them: `default` is
always a member of `enabled`, and `enabled` is never emptied. Together they mean the
picker can never end up with nothing in it.

The prompt reads the `claude` entry only. Codex and Copilot selections are collected now
so the code review UI opens on a real choice rather than a blank one.

## Re-running the probes

```bash
claude auth status                  # JSON liveness, works under OAuth
codex debug models                  # full JSON catalog
copilot --model bogus -p hi         # confirms validation still errors cleanly
claude --model opus -p "reply ok" --output-format json   # modelUsage enrichment

# Claude's authoritative list. Needs a token; see the open decision above.
curl -s "https://api.anthropic.com/v1/models?limit=100" \
  -H "Authorization: Bearer $TOKEN" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -H "anthropic-version: 2023-06-01"

# Corroborating local caches (private Claude Code state, may change without notice)
sed -nE 's/.*"additionalModelOptionsCache"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$HOME/.claude.json"
```
