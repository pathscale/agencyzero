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

- Patch only by default: `0.3.0` to `0.3.1`, never cross a release line silently.
  A minor or major milestone requires the owner to name it explicitly, as the
  owner did for `0.3.0`.
- Bump on every commit that should ship. Release fires on a version change alone, so an
  unbumped commit reaches nobody.

## Verification

Run what you build before calling it done. **If you can't run it, say so.**

- Compare against the base branch: a pre-existing failure is not yours, and saying so
  requires checking.
- A suspiciously fast build was cached. Force a rebuild when the rebuild is the point.

## PR discipline

- Paste the full PR URL, not the number.
- Record it through the declared surface too: prose URLs are inert, so use
  `@agency:pr.link(url: "<full URL>", item: "<item id>")` or the `pr:` field on
  `items.state` when shipping an item.
- When the change lands on master, close the PR and delete the branch in the same breath
  (`gh pr merge --delete-branch`). An open PR whose content already shipped reads as
  unfinished work.

## Handover documents are never committed

**Never commit a handover, status or session-summary document to any repository,
and never push one to `master`.** Not under `docs/`, not at the root, not under
any name. They are working notes for the owner and they belong in the
conversation, not in the history of a codebase that outlives the session.

`docs/HANDOVER.md` and `HANDOVER*.md` are gitignored. If you find one tracked,
untrack it rather than editing it.

## Merged is not fixed

**Only the owner closes a bug.** A merged PR means the change landed, nothing
more. Marking an item `finished` because CI went green is how a list of real,
still-broken behaviour quietly emptied itself: Cmd-Z, project renaming, copying
out of the transcript and the blinking artifact were all reported again after
being recorded as done.

So:

- `shipped` when the PR merges. That is the honest ceiling for anything you
  cannot see with your own eyes.
- `finished` only after the owner says it works, or after you have driven the
  exact reported path on a running build and watched it behave.
- A test passing is not the owner saying it works. A guard can assert the
  precondition you fixed and still leave the feature broken for a reason
  underneath it — which is exactly what the composer undo guard did, staying
  green while `blitz-dom` turned out to have no undo stack at all.

When a fix cannot be verified from here, say which part is unverified rather
than rounding it up.

## Closing an item you were given

The project prompt supplies item ids and the declared Prompt Syntax surface. Report
state with `@agency:items.state`, create with `@agency:items.add`, and remove an
incorrect row with `@agency:items.retire`. Never address an existing row by title:
paraphrases were how the old checkbox contract created near-duplicates. Full contract:
[`docs/task-manager.md`](docs/task-manager.md#the-project-session-contract).
[`wt-tools`](crates/wt-tools) reads the list and never writes.

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
- **Stop the app with `scripts/az-stop.sh`, and never harder than TERM.** The store is
  single-writer, so a hard kill takes it down mid-write with no chance to close its
  handles. The script sends TERM to *this checkout's* bundle only, waits ten seconds, and
  exits non-zero if the process is still there. It offers no `SIGKILL`: not as a flag, not
  as a fallback, not after a timeout.

  A process that ignores TERM is the finding. Say so, with `sample <pid> 5 -mayDie` to
  show where it is parked, and stop there. Do not write the inline pattern this replaces:

  ```sh
  # Never this.
  pkill -TERM -f "...az-gui"; sleep 4; pkill -9 -f "...az-gui"
  ```

  It reads as careful and is not. The `-9` fires on a schedule rather than on a decision,
  so it lands exactly when the app is slowest to quit, which is when it is most likely to
  be mid-write. Matching on the bare binary name also hits the owner's installed
  Experimental build, which is not yours to stop. A one-time approval to `-9` one wedged
  pid is not standing permission for the next one.
- **Ask before installing anything**, including writes to `~/Library/Caches`, `~/.cargo`
  and Homebrew. A doc here recommending a tool is not permission to fetch it.

## Git workflow

- **Building the renderer from a working checkout is opt-in, and never edits a
  tracked file.** Put the `[patch]` tables in `.cargo/local-renderer.toml`,
  which is gitignored, and reach for them per command:

  ```sh
  scripts/local-renderer.sh check -p az-gui --features blitz-runtime
  ```

  It used to be a block inside a tracked `.cargo/config.toml`, defended by
  `git update-index --skip-worktree`. That failed four ways at once. The file was
  tracked, because it carried the macOS link flag and the `usvg` patch every
  build needs, so `.gitignore` could not protect it and the paths went in four
  times. `skip-worktree` hid the file from `git status` as well and blocked
  branch switches. The redirect was always on, so no ordinary build ever fetched
  the revisions in `apps/gui/Cargo.toml` and they rotted unseen until a macOS
  release build found out. And a redirected build rewrites the committed
  `Cargo.lock`, replacing git revisions with paths, which reached a commit twice.

  The wrapper snapshots and restores the lockfile around the build, so none of
  that is left to remember.

  **There is no `.cargo/config.toml` any more**, and nothing should recreate one:
  `.cargo/` holds only the gitignored `local-renderer.toml`. Both of its former
  settings found a better home. The usvg patch moved to the root `Cargo.toml`,
  where patches belong and where ps-blitz keeps the same one. The macOS linker
  flag moved into [`apps/gui/build.rs`](apps/gui/build.rs), which emits
  `cargo::rustc-link-arg-bins` for the one binary that wants it rather than for
  every crate in the workspace. That the two ever shared a file is the whole
  story: a shared patch shared a `[patch.crates-io]` table with paths that
  existed on one machine, which is how a file nobody could delete became a file
  nobody could safely commit.

  Pins still want checking before a release, because the opt-in path skips them
  by definition. `scripts/check-one-rev-per-git-source.sh` refuses a lockfile
  holding one git source at two revisions, which is what a half-finished repin
  produces.

- **One change per commit.** Shared files are an ordering problem, not an excuse.
- **Name the branch when pushing**: `git push origin branch-name`.
- **Branch naming**: `fix/description` or `feat/description`.
- **Force-push your own branch freely**, with `--force-with-lease`. Never the default branch.
- **Never create merge commits — this is a hard ban.** Not locally, not to refresh a
  branch, not to land a pull request. If your branch has fallen behind, **rebase** it onto
  the moved base (`git rebase origin/master`, then `--force-with-lease`). `git merge master`
  into a feature branch is not an acceptable shortcut: it adds a commit whose only content
  is the fact that you were behind, and it turns a readable line of work into a diamond.
- **Rebase is the default everywhere** — refreshing a branch, and landing a pull request.
  Individual commits carry information: what was tried, in what order, and why. A rebase
  keeps that granularity on the base branch, so write commits worth keeping and land them
  intact.
- **Landing a pull request means rebase, then fast-forward.** `git rebase origin/master`
  on the branch, then `git merge --ff-only <branch>` on the base, then push. Those two
  commands are the whole job, so don't reach for `gh pr merge`: its default writes a
  merge commit. Rebasing rewrites the commit SHAs, so GitHub cannot always detect that
  a branch landed — close such pull requests explicitly and say why.
- **Don't delete remote branches by hand.** Once the work is on the default branch it is
  reaped automatically. Deleting your own local copy is fine.
- **Squash is acceptable** where it genuinely makes things easier or is the more
  appropriate shape for the branch — one logical change scattered across fixup commits, or
  a long branch whose intermediate states aren't worth preserving. It is a judgement call,
  not a violation. Merging is the only thing that is never allowed.
- **Delete what is deprecated.** A superseded file, flag, branch or code path gets removed
  in the change that supersedes it, not left behind with a deprecation note.

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
