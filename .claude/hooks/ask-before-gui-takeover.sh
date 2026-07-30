#!/usr/bin/env bash
# Claude Code PreToolUse(Bash) gate — desktop takeover.
#
# AGENTS.md already says "never take over the desktop without asking first". This
# is the layer that makes forgetting it hard: launching a GUI app, focusing a
# window, screenshotting, or driving anything through System Events steals the
# screen and the keyboard from whoever is using this Mac. On 2026-07-31 an agent
# verifying a Settings fix scripted clicks and keystrokes for several minutes,
# and the owner could not press Enter in their own window the whole time. The
# rule was in AGENTS.md then too.
#
# Unconditional: it asks every time, whether or not anyone appears to be at the
# keyboard. An earlier version skipped the prompt on an idle desktop, and the
# owner asked for the simpler contract — confirm with me, always. Guessing
# whether a human is present is the kind of cleverness that is wrong exactly
# when it matters.
#
# A hook rather than entries in permissions.ask, because the decision needs more
# than a glob: `osascript` is only a takeover when it speaks the UI-scripting
# vocabulary, a bundle's binary is recognised by path rather than by command
# word, and a takeover wrapped in `bash -c '…'` has to be seen through.
#
# One layer of defence, not a guarantee. A pattern match over a command string
# cannot see a compiled helper — a Swift binary posting CGEvents is invisible
# here, and that is exactly how the incident above got as far as it did. The
# rule in AGENTS.md is the part that covers what this cannot.
set -u

# Pull the command out of the hook's stdin JSON (jq if available, else python3).
if command -v jq >/dev/null 2>&1; then
  cmd="$(jq -r '.tool_input.command // ""' 2>/dev/null)"
else
  cmd="$(python3 -c 'import sys, json; print(json.load(sys.stdin).get("tool_input", {}).get("command", ""))' 2>/dev/null)"
fi

# Couldn't read the command → stay neutral, let normal permission rules decide.
[ -z "$cmd" ] && exit 0

# Same command-position anchors as ask-before-risky-commands.sh, so a takeover
# wrapped in `bash -c '…'` or chained behind && is still seen.
b="(^|[[:space:];&|(\"'\`])"
e="([[:space:]]|[;&|)\"'\`]|$)"

# open — launches or raises an app, a URL, or a file in its editor.
re="${b}open${e}"
# screencapture — grabs the screen, and prompts for permission the first time.
re="$re|${b}screencapture${e}"
# Third-party clickers, if they are ever installed here.
re="$re|${b}(cliclick|dotool|xdotool)${e}"
# osascript is only a takeover when it drives the UI; `osascript -e 'return 1'`
# is harmless, so match on the UI-scripting vocabulary rather than the tool.
re="$re|${b}osascript${e}.*(System Events|keystroke|key code|click|frontmost|activate|menu bar|perform action)"
# Running a bundle's binary directly, which is how the Dev instance is launched.
re="$re|\.app/Contents/MacOS/"
# `tauri dev` opens a window. `bun run dev` deliberately does not match: the
# frontend's standalone dev server is the headless path AGENTS.md points at.
re="$re|${b}(cargo[[:space:]]+)?tauri([[:space:]]+[^[:space:]]+)*[[:space:]]+dev${e}"

printf '%s\n' "$cmd" | grep -Eq "$re" || exit 0

printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"This takes over the desktop (screen, focus or keyboard). Say what it will do and how long, and wait for a yes. Headless alternatives: the log file, the files on disk, CGWindowList window counts, or the frontend'"'"'s standalone dev server — see docs/ui-verification.md."}}'
exit 0
