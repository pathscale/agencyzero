# Agent model and parameter surface

What each agent CLI will tell us about the models it can run, and which parameters we
can send per turn. This is the reference behind two open items:

- `MODELS = ["opus", "sonnet", "haiku"]` is hardcoded in
  [`labels.ts`](../apps/gui/frontend/src/lib/labels.ts); the inventory flags it as
  needing to come from the agent probe.
- `list_agent_status(recheck)` is specified to probe the installed CLIs but returns
  fixtures today. See [`gui-wiring-plan.md`](gui-wiring-plan.md).

**Probed 2026-07-29 on macOS** against `claude` 2.1.205, `codex-cli` 0.145.0, and
GitHub Copilot CLI 1.0.75. Everything marked *verified* was run locally; everything
marked *unverified* is called out as such. Re-run the probes when bumping a CLI: all
three ship model lists that move.

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

## Claude: aliases beat enumeration

There is no `--list-models` and no local model cache. The binary embeds model slugs but
grepping a 237MB executable is not an interface and we should not build on it.

The good news is that we do not need enumeration. `--model` accepts an **alias for the
latest model** (`opus`, `sonnet`, `haiku`, `fable`) as well as a full id. Aliases
resolve server-side to the current version, so a picker built on four aliases is
correct by construction and never goes stale. Verified: `--model opus` resolved to
`claude-opus-4-8` in the run envelope.

Real model ids and their limits come back **after** a run. With
`--output-format json`, the result envelope carries `modelUsage` keyed by resolved
model id:

```json
"modelUsage": {
  "claude-opus-4-8": { "inputTokens": 3365, "outputTokens": 4,
    "cacheReadInputTokens": 17026, "cacheCreationInputTokens": 2201,
    "costUSD": 0.0475, "contextWindow": 1000000, "maxOutputTokens": 64000 }
}
```

So the flow is: offer aliases, then enrich the catalog opportunistically from the first
run and cache the result. `contextWindow` and `maxOutputTokens` are exactly what the
context meter needs, and `costUSD` plus the sibling `total_cost_usd` field feed the run
cost display. Note the envelope reports *every* model a turn touched, not just the one
requested, because Claude Code uses a small model for side tasks.

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

## Suggested shape

Have `list_agent_status(recheck)` return a per-agent catalog alongside the existing
status, and drop `MODELS` from `labels.ts` entirely:

```ts
interface ModelInfo {
  id: string;              // what goes on the command line
  displayName: string;
  description?: string;
  efforts: string[];       // per model, from the CLI where available
  defaultEffort?: string;
  contextWindow?: number;  // known after first run for claude
  maxOutputTokens?: number;
  source: "probe" | "alias" | "static";  // provenance, so the UI can hedge
}
```

Populated per agent as:

- **codex** `probe`: run `codex debug models`, filter `visibility === "list"`, sort by
  `priority`, map `supported_reasoning_levels[].effort` to `efforts`.
- **claude** `alias`: the four aliases, enriched to `probe` quality from `modelUsage`
  after the first run and cached.
- **copilot** `static`: a short curated list plus `auto`, validated lazily.

Carrying `source` matters. It lets the settings screen distinguish "these are the models
your account actually has" from "this is our best guess", which is the honest thing to
show given only one of three agents can tell us for certain.

## Re-running the probes

```bash
claude auth status                  # JSON liveness, works under OAuth
codex debug models                  # full JSON catalog
copilot --model bogus -p hi         # confirms validation still errors cleanly
claude --model opus -p "reply ok" --output-format json   # modelUsage enrichment
```
