# Working agreement — agencyzero

The operating contract for **any** coding agent working in this repository. This file is
the single source of truth for the rules: Codex, Cursor and Gemini CLI read `AGENTS.md`
natively, and Claude Code loads it through the `@AGENTS.md` import in
[`CLAUDE.md`](CLAUDE.md). **Never fork these rules into a per-vendor file.**

Documentation / assets repository.

## Invariants (don't break these)

- **Docs describe what is true now.** If you change behaviour, update the README and any affected doc in the same change.


## Verification

Run what you build before reporting it done. Type-checks and tests verify code correctness,
not feature correctness — **if you can't run it, say so explicitly** rather than implying
success.

- Compare against the base branch rather than asserting: a pre-existing failing test or lint
  error is not something you introduced, and saying so requires checking.
- A build that finishes suspiciously fast was cached, not rebuilt. Force a real rebuild when
  the rebuild is the thing you're verifying.

## PR discipline

**Always paste the full PR URL** (`https://github.com/pathscale/agencyzero/pull/<n>`), not just the number, so it's
clickable.

<!-- DORMANT — CI-green gating. Do not follow this rule yet; re-enable it as its own project.

Why it's off: CI here does not reliably attach checks to pull requests, so
`statusCheckRollup` comes back empty and "wait for green" would teach an agent to wait on
nothing. Verify per repo before switching this on.

To enable: ensure the workflow runs on `pull_request:`, confirm checks attach to a PR, then
uncomment the rule below.

    After any push or PR, **check CI and don't call it done until it's green**:

    ```bash
    gh pr view <number> --repo pathscale/agencyzero --json statusCheckRollup
    ```

    CI running → wait and recheck. CI failed → read the logs, fix, push, wait for green.
-->

## Keeping docs honest

Hit a factual error here — a stale path, a wrong command, a moved status? Fix it in the same
change. Don't open cosmetic rewording PRs.

Learned something durable — a gotcha, a decision, a constraint? It belongs **in this repo's
docs**, not in your agent's private memory. Repo docs are versioned, reviewable, and visible
to every agent and human; private memory dies with your machine.

## Git workflow

- **Always specify the branch when pushing**: `git push origin branch-name`
- **Branch naming**: `fix/issue-description` or `feat/issue-description`
- **Force-push your own branch freely.** Rebasing a feature branch onto a moved
  base, or amending before review, is normal and correct — use
  `--force-with-lease` so you don't clobber someone else's push.
- **Never force-push the default branch** (`main`/`master`). That is the history
  everyone else builds on, and it is protected server-side for a reason.

## Guardrails

[`.claude/settings.json`](.claude/settings.json) and [`.claude/hooks/`](.claude/hooks/) make
Claude Code prompt a human before prod-affecting or destructive commands — pushes, publishing
to a registry, `gh pr merge`, cloud CLIs, recursive deletes, deploy scripts.

**Other agents don't get that net automatically.** Apply the same rule yourself: ask before
running any command family listed in
[`.claude/hooks/ask-before-risky-commands.sh`](.claude/hooks/ask-before-risky-commands.sh).
It is one layer of defence, not a guarantee — a pattern match over a command string is
best-effort.

## No AI attribution

Never add AI attribution to anything in this repo or leaving it: no "Generated with
Claude Code" / robot-emoji footers, no `Co-Authored-By: Claude` (or any AI) trailers,
and no AI credit in commit messages, PR or issue titles/bodies, changelogs, release
notes, or code comments. Applies to every agent and every vendor. Work product should
be indistinguishable from a human teammate's.
