# Verifying UI changes without touching the desktop

The owner uses this Mac while agents work. Driving the real app — focusing
windows, clicking on screen, screenshots of the desktop — is a takeover, and
it is also the *worst* verification surface: slow, flaky, and it requires the
System instance, whose store you must never touch. There is a better path,
and it needs no screen at all.

## The native outcome harness is the release gate

`ps-qa` drives the QA profile through Blitz inspection. It addresses the
rendered semantic tree, performs real click, pointer, key and text-input
actions, and judges the resulting value, selection, geometry or pixels. The
checks live in `tests/ps-qa`.

The component library has the same contract at a smaller scale. UI builds one
page per exported component and `qa-inspect-host` serves those pages without a
window. One clean native host is used per component, while the outcomes for
that component share the host. The complete 72-component sweep takes under two
minutes on a developer Mac.

This is the replacement for jsdom interaction coverage. Pure functions may
still have ordinary unit tests, but a component does not earn UI coverage by
mounting into a fake DOM. It earns coverage when the native renderer exposes
the intended result after the intended input.

Every value-bearing `@pathscale/ui` primitive imported by AgencyZero is listed
in `apps/gui/frontend/scripts/check-ui-controls.ts`. That gate requires named
ps-qa outcomes which actually drive a control. Adding an Input, Select,
InlineEdit or similar primitive without a rendered outcome fails CI.

## The frontend also runs standalone against fixtures

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

## Browser fixture inspection is a secondary diagnostic

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

Use this path for a quick frontend-only diagnosis. Do not treat a DOM assertion
as the release verdict when the same behavior can be checked by ps-qa against
the native renderer.

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
