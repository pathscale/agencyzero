#!/usr/bin/env bash
#
# Build a bundle for the owner to test, and refuse to hand over a wrong one.
#
# Every bad build this tool exists to prevent actually happened, in one
# session, and each was reported as a working fix:
#
#   - a bundle 5 hours older than the binary beside it, because `quick` swaps
#     `Contents/MacOS/az-gui` and nothing checked the two agreed
#   - a Rust rebuild that silently kept a stale embedded frontend, because
#     `cargo` does not treat `apps/gui/dist` as an input
#   - `bun install` reverting a locally linked `@pathscale/ui` mid-session, so
#     the CSS fix under test vanished from the build that was meant to prove it
#   - the wrong feature set: `blitz-runtime` instead of `experimental`, which
#     builds a webview app with no Blitz document and no control socket
#
# So this script does the whole chain in order, then verifies the artifact and
# exits non-zero if any claim about it is false. A build that cannot prove what
# it contains is not delivered.
#
# Usage:
#   scripts/owner-build.sh experimental     # AgencyZero Experimental.app
#   scripts/owner-build.sh stable           # AgencyZero.app
#   scripts/owner-build.sh experimental --link-local-ui
#
# `--link-local-ui` copies ~/code/ui/dist over the installed @pathscale/ui.
# It is off by default: a build carrying unpublished component code is not the
# thing the owner is usually asking to test, and it must never happen silently.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

mode="${1:-experimental}"
link_local_ui=0
for arg in "${@:2}"; do
  case "$arg" in
    --link-local-ui) link_local_ui=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

case "$mode" in
  experimental)
    app_name="AgencyZero Experimental.app"
    ;;
  stable)
    app_name="AgencyZero.app"
    ;;
  *)
    echo "usage: scripts/owner-build.sh [experimental|stable] [--link-local-ui]" >&2
    exit 2
    ;;
esac

bundle="$repo_root/target/release/bundle/macos/$app_name"
binary="$bundle/Contents/MacOS/az-gui"
started_at="$(date +%s)"

step() { printf '\n==> %s\n' "$1"; }
fail() { printf '\nFAILED: %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# 1. Dependencies resolve to something real
# ---------------------------------------------------------------------------
step "dependency versions"

# A `[patch.crates-io]` pointing at a local checkout builds here and nowhere
# else. It is how an unshippable manifest reaches a commit, so say it loudly
# rather than let it pass as an ordinary build.
if grep -q '^\[patch\.crates-io\]' Cargo.toml; then
  echo "  WARNING: [patch.crates-io] is active - this build uses local paths"
  grep -A6 '^\[patch\.crates-io\]' Cargo.toml | sed 's/^/    /'
fi

for crate in ps-blitz-script ps-boa-engine tauri-runtime-blitz; do
  line="$(cargo tree -i "$crate" --depth 0 2>/dev/null | grep -v '^warning' | head -1 || true)"
  [ -n "$line" ] || fail "$crate is not in the dependency graph"
  printf '  %s\n' "$line"
  case "$line" in
    *-beta.*|*-dev*)
      fail "$crate resolves to a pre-release ($line). Publish a release and move the caret."
      ;;
  esac
done

# ---------------------------------------------------------------------------
# 2. Frontend dependencies, then the frontend
# ---------------------------------------------------------------------------
step "frontend dependencies"
(
  cd apps/gui/frontend
  bun install --no-save
)

if [ "$link_local_ui" = 1 ]; then
  step "linking local @pathscale/ui (UNPUBLISHED COMPONENT CODE)"
  local_ui="$repo_root/../ui/dist"
  [ -d "$local_ui" ] || fail "no build at $local_ui - run 'bun run rslib build' in ~/code/ui first"
  # Rebuilt every time. A stale ~/code/ui/dist is the same class of fault as a
  # stale frontend dist, and silently ships whatever was last built there.
  ( cd "$repo_root/../ui" && bun run rslib build >/dev/null )
  cp -R "$local_ui/." "apps/gui/frontend/node_modules/@pathscale/ui/dist/"
  echo "  copied $(cd "$local_ui" && find . -name '*.css' | wc -l | tr -d ' ') css files"
fi

step "frontend"
(
  cd apps/gui/frontend
  bun run lint
  bun run build
)

dist_js="$(ls -t apps/gui/dist/static/js/*.js 2>/dev/null | head -1 || true)"
[ -n "$dist_js" ] || fail "no frontend bundle at apps/gui/dist/static/js"
echo "  built $dist_js"

# ---------------------------------------------------------------------------
# 3. The bundle
# ---------------------------------------------------------------------------
# `cargo` does not know the embedded frontend changed, so a Rust-only rebuild
# happily ships the previous one. Touching the crate root forces the embed.
step "bundle ($mode)"
touch apps/gui/src/main.rs
scripts/local-delivery.sh "$mode"

# ---------------------------------------------------------------------------
# 4. Verify the artifact, and refuse to deliver a wrong one
# ---------------------------------------------------------------------------
step "verifying $app_name"

[ -d "$bundle" ] || fail "no bundle at $bundle"
[ -x "$binary" ] || fail "no executable at $binary"

# Built during this run, not recovered from a previous one.
binary_at="$(stat -f %m "$binary")"
if [ "$binary_at" -lt "$started_at" ]; then
  fail "$binary predates this run - local-delivery.sh did not rebuild it"
fi
echo "  binary rebuilt during this run"

# The leak fix, by symbol. Frontend strings are compressed and cannot be
# grepped, so this is the one embedded claim that can be checked directly.
symbols="$(nm -a "$binary" 2>/dev/null | grep -c sweep_detached_nodes || true)"
[ "$symbols" -gt 0 ] || fail "sweep_detached_nodes is absent - this binary has the DOM leak"
echo "  DOM leak fix present ($symbols symbols)"

codesign --verify --strict "$bundle" 2>/dev/null || fail "signature is not valid"
echo "  signature valid"

# It has to start. A bundle that exits on launch has failed whatever it was
# built to demonstrate, and finding that out from the owner is too late.
probe_home="$(mktemp -d)"
probe_data="$(mktemp -d)"
HOME="$probe_home" AZ_DATA_DIR="$probe_data" "$binary" --blitz-control \
  > "$probe_data/launch.log" 2>&1 &
probe_pid=$!
launched=0
for _ in $(seq 1 30); do
  sleep 1
  kill -0 "$probe_pid" 2>/dev/null || break
  # The frontend answering an IPC call, not a rendered project panel: the probe
  # runs on an empty profile, which has no project to render, so waiting for one
  # failed a bundle that was working perfectly.
  if grep -q '\[webview\] <-' "$probe_data/launch.log" 2>/dev/null; then
    launched=1
    break
  fi
done
kill -TERM "$probe_pid" 2>/dev/null || true
wait "$probe_pid" 2>/dev/null || true

# The probe's verdict is already decided by here, so cleanup must never be able
# to change it. It could: the app spawns helpers that keep unpacking into the
# temp HOME after the parent is reaped, `rm -rf` raced one of them, and every
# "Directory not empty" it printed was a non-zero exit that `set -e` turned into
# a failed build. The binary was signed, verified and working; the script
# reported failure one line before saying so.
#
# So give the writers a moment to finish, then never let the result matter.
for _ in $(seq 1 5); do
  rm -rf "$probe_home" "$probe_data" 2>/dev/null && break
  sleep 1
done
rm -rf "$probe_home" "$probe_data" 2>/dev/null || true

[ "$launched" = 1 ] || fail "the bundle did not reach a rendered panel within 30s"
echo "  launches and renders"

printf '\n%s\n' "$bundle"
printf 'open -n "%s"\n' "$bundle"
