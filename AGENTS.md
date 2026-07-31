# Most important rules
@./AgencyZero.md

# Working agreement: agencyzero

Operating contract for any coding agent here, and the single source of truth. Codex,
Cursor and Gemini read `AGENTS.md` natively; Claude Code imports it from
[`CLAUDE.md`](CLAUDE.md). Never fork these rules into a per-vendor file.

Rust workspace: Tauri GUI, agent, MCP proxy, agent proxy, WorkTable read CLI, plus
`az-core`. Layout and build commands in [README.md](README.md).

## Rules that outrank your defaults

[AgencyZero.md](AgencyZero.md) is injected whole into every prompt. This file loads as
project context, which sits *below* your own system prompt, so a rule kept only here
loses to a conflicting default in silence. Put a rule there only when a violation would
be silent and expensive: every line added weakens the rest.

## Where knowledge goes

- **Procedure**: this file.
- **Why code is shaped the way it is**: a comment at the site, never a separate file.
- **Decisions, corrections, preferences**: the project memory named in your system
  prompt. Keyed by project id, so it survives sessions, compactions, re-clones and a
  moved checkout. Never committed: it describes the working relationship, not the repo.
- **What is in flight**: the knowledge checkpoint.

Check the destination before writing, so one fact is not stored twice. A decision that
hardens into procedure moves here; the reasoning stays in memory.

## Versioning

- Patch only: `0.1.28` to `0.1.29`, never `0.1` to `0.2`.
- Bump on every commit that should ship. Release fires on a version change alone, so an
  unbumped commit reaches nobody.

## Verification

Run what you build before calling it done. **If you can't run it, say so.**

- Compare against the base branch: a pre-existing failure is not yours, and saying so
  requires checking.
- A suspiciously fast build was cached. Force a rebuild when the rebuild is the point.

## PR discipline

- Paste the full PR URL, not the number.
- When the change lands on master, close the PR and delete the branch in the same breath
  (`gh pr merge --delete-branch`). An open PR whose content already shipped reads as
  unfinished work.

## Closing an item you were given

Reply checkboxes edit the project's item list: `- [ ]` proposes, `- [x] <exact title>`
closes, `- [-] <exact title>` strikes an obsolete row. Titles match exactly and
case-insensitively, so a paraphrase silently appends a near-duplicate. Full contract:
[`docs/task-manager.md`](docs/task-manager.md#the-project-session-contract-three-checkboxes).
Read that, not `projects.rs`: the verbs arrived late, and an older tree reads as
append-only. [`wt-tools`](crates/wt-tools) reads the list and never writes.

- **Close in the same turn the work ships.** Shipped means merged and released.
- **Read the title before striking it.** `wt-tools search-items <word>` prints it as stored.
- **Verify after.** `wt-tools list-items --project <id>`. A strike gets no acknowledgement.
- **Say what you did not close, and why.** Forgotten and blocked are different.

## Working on the machine you share with a human

- **Never take over the desktop without asking.** Launching or focusing apps, `open`,
  screenshots, AppleScript UI control. Say what it does and how long, then wait for yes.
- **Don't drive the real app to check visuals.** The frontend runs standalone against the
  mock (`bun run dev`, port 3010) and is drivable by roles and labels:
  [`docs/ui-verification.md`](docs/ui-verification.md). Otherwise build, test, and ask the
  owner to look.
- **Never touch the running System instance**, its process, files or data directory. The
  store is single-writer. Use the Dev instance (`tauri.dev.conf.json`).
  **Check before you decide it is closed, and check by the right name.** The binary is
  `az-gui`, not AgencyZero, so a search for the product name finds nothing and reads as
  "not running" while it is very much running. Ask the files who owns them instead:

  ```sh
  lsof +D ~/Library/Application\ Support/com.pathscale.agencyzero/db
  ```

  Empty means nothing holds the store. Any output at all means stop. On 2026-08-01 a
  `pgrep` for the product name came back empty, the app was live on PID 3076 with the
  whole store open, and only the choice of target saved it: what got deleted were
  detached `db.superseded-*` copies nothing held.
- **Ask before installing anything**, including writes to `~/Library/Caches`, `~/.cargo`
  and Homebrew. A doc here recommending a tool is not permission to fetch it.

## Git workflow

- **One change per commit.** Shared files are an ordering problem, not an excuse.
- **Name the branch when pushing**: `git push origin branch-name`.
- **Branch naming**: `fix/description` or `feat/description`.
- **Force-push your own branch freely**, with `--force-with-lease`. Never the default branch.

## Guardrails

[`.claude/hooks/`](.claude/hooks/) prompts before destructive commands and before anything
taking over screen, focus or keyboard. A `commit-msg` hook rejects AI attribution and em
dashes outright; enable it with `git config core.hooksPath .githooks`.

**Other agents don't get that net.** Ask before running any command family listed in
[`ask-before-risky-commands.sh`](.claude/hooks/ask-before-risky-commands.sh) or
[`ask-before-gui-takeover.sh`](.claude/hooks/ask-before-gui-takeover.sh). A pattern match
over a command string is best-effort, not a boundary.

## Keeping docs honest

Fix a stale path or a wrong command in the same change. No cosmetic rewording PRs.
