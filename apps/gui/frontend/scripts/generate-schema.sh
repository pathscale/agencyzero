#!/usr/bin/env sh
# Regenerate the schema the visual editor draws.
#
# The diagram reads a committed JSON file rather than a Tauri command, so it
# renders in the browser fixture on :3010 with no build and no instance, and a
# schema change shows up in review as a diff of the drawing's input.
#
# Run it after touching anything in `apps/gui/src/db/schema/` or the overlay.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)
feature="$root/apps/gui/frontend/src/features/schema"

cargo run --quiet --manifest-path "$root/Cargo.toml" -p wt-schema -- \
  "$root/apps/gui/src/db/schema" \
  --overlay "$feature/schema.overlay.json" \
  --out "$feature/schema.generated.json"

echo "wrote $feature/schema.generated.json"
