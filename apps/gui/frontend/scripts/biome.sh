#!/usr/bin/env bash
# Run Biome's native binary directly, never its npm wrapper.
#
# `node_modules/.bin/biome` is a `#!/usr/bin/env node` script: it detects the
# platform, then re-spawns the real executable. Biome itself is Rust, so that
# hop is the only thing in `bun run lint` that needed Node at all. This picks
# the binary the wrapper would have picked and execs it.
#
# Exactly one `@biomejs/cli-*` package installs on a given machine — they are
# optionalDependencies keyed by platform — so the glob resolves to one path
# rather than a choice. Hardcoding `cli-darwin-arm64` would work here and
# break CI, which is Linux.
set -euo pipefail

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root=$(dirname "$here")

for candidate in "$root"/node_modules/@biomejs/cli-*/biome; do
    if [[ -x $candidate ]]; then
        exec "$candidate" "$@"
    fi
done

echo "biome: no native @biomejs/cli-* binary under $root/node_modules." >&2
echo "Run 'bun install' first." >&2
exit 1
