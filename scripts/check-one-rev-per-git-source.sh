#!/usr/bin/env bash
#
# Fail if Cargo.lock resolves any git dependency at more than one revision.
#
# Cargo treats two revs of one repository as two unrelated crates. Both get
# built, both export the same type names, and the types do not unify: passing a
# `Document` from one into a function expecting the other reads as a method
# that does not exist, in a dependency nobody edited.
#
# This is worth its own check because the only build that catches it is the
# macOS release bundle. CI deliberately leaves `blitz-runtime` off — Blitz is a
# macOS preview runtime and enabling it on the Linux runner is separate
# portability work — so a mismatched rev compiles green through every PR gate
# and fails on the release job after the merge. That is exactly how 0.6.0 was
# cut with a bundle that could not build: the app moved ps-blitz to 464444a2
# and tauri-runtime-blitz was still asking for ada2f821.
#
# Reading the lockfile rather than running cargo keeps it honest on any runner
# and costs nothing, and the lockfile is the resolution the release job uses.
set -euo pipefail

lock="${1:-Cargo.lock}"

# `source = "git+URL?rev=SHA#SHORTSHA"` — strip the fragment, split on `?rev=`.
duplicates=$(
    grep -o 'source = "git+[^"]*"' "$lock" |
        sed 's/source = "git+//; s/"$//; s/#.*//' |
        sort -u |
        awk -F'\\?rev=' 'NF == 2 { count[$1]++; revs[$1] = revs[$1] "\n    " $2 }
                       END { for (url in count) if (count[url] > 1) print url revs[url] }'
)

if [[ -n $duplicates ]]; then
    echo "Cargo.lock resolves a git dependency at more than one revision:" >&2
    echo "$duplicates" >&2
    echo >&2
    echo "Point every manifest at the same rev. A dependency that pins one of" >&2
    echo "these itself has to be republished at the rev this repository wants." >&2
    exit 1
fi

echo "one rev per git source"
