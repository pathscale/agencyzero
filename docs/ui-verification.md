# Verifying UI changes without touching the desktop

The owner uses this Mac while agents work. Driving the real app — focusing
windows, clicking on screen, screenshots of the desktop — is a takeover, and
it is also the *worst* verification surface: slow, flaky, and it requires the
System instance, whose store you must never touch. There is a better path,
and it needs no screen at all.

## The frontend runs standalone, against fixtures

`apps/gui/frontend` is a browser app first. Outside Tauri it serves itself
with the in-memory mock backend (`src/api/mock.ts`) and a banner reading
"Design fixtures — the Rust commands are not implemented yet":

```
cd apps/gui/frontend && bun run dev   # http://localhost:3010
```

Every UI change short of Rust-only behaviour is observable here: layout,
panels, transcript rendering, composer states, the whole event-driven store
(the mock emits the same events Rust does). No Tauri build, no instance, no
desktop.

## Drive it headlessly, by role and label — never by pixels

Use the browser that is already here. **Brave is the machine's agent browser** —
it carries the owner's Claude for Chrome plugin and is kept apart from the
profile they work in, so driving it risks nothing of theirs:

```bash
"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  --headless --remote-debugging-port=9222 \
  --user-data-dir=/tmp/az-headless        # never the real profile
```

It is Chromium, so any CDP client speaks to it and **nothing needs installing**.
That matters: this file used to say `bunx playwright …`, and a session read that
as licence to pull a 95 MB browser onto the owner's disk unannounced. A doc
recommending a tool is not permission to install it — **ask first, every time**,
and reach for what is already on the machine before asking at all.

Headless means no window and no stolen focus, but it is still launching a GUI
application: the takeover hook matches it, and that prompt is correct. Answer it
rather than routing around it.

Two rules learned the hard way:

- **Address controls through the accessibility tree** — roles, `aria-label`s,
  placeholder text — never screen coordinates. This codebase labels every
  interactive control precisely so that "the button named *Attach files*"
  is a stable address; a coordinate is viewport-relative and misses silently
  the moment the layout breathes. (A real miss from this repo's history: a
  click at y=738 in a 720px-tall viewport does nothing and reports nothing.)
- **Synthetic key events are not keyboard input.** A dispatched `Enter` may
  not trigger the app's `keydown` handlers the way a real keystroke does.
  When a test "types Enter and nothing happens", click the labelled submit
  button instead — that path is identical for real users and scripts.

Assert on the DOM (`textContent`, element presence, `aria-*` state), not on
screenshots. A text assertion fails with a message; a screenshot diff fails
with homework.

## What this cannot verify, and what to do then

Rust-served behaviour (real runs, approvals against a live agent, the
updater, WorkTable persistence) does not exist in fixture mode. For those:

- unit/integration tests on the Rust side (`cargo test`);
- the **Dev instance** (`tauri.dev.conf.json`) if a real GUI is unavoidable —
  and even then, ask the owner before anything appears on screen;
- otherwise build + typecheck + test, then ask the owner to look, with one
  precise sentence about what to check. A human glance takes seconds.

For desktop debugging, runtime selection, isolated data profiles, Blitz control,
and performance evidence, see [Debugging AgencyZero desktop runtimes](debugging.md).
