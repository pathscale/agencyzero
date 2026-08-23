# The committed QA profile

`qa-profile.tar.zst` is the fixture `ps-qa` drives. It expands to a ~30 MB
WorkTable store: 294 projects, two of them deep enough to time against.

```sh
scripts/qa-profile-restore.sh            # -> /tmp/qa-profile-db
scripts/qa-profile-restore.sh /tmp/mine  # anywhere else
```

## Why it is committed compressed

The store is ~30 MB on disk and this repository's entire history is 60 MB, with
no git-lfs. The scrubbed text is repetitive filler drawn from a twenty-word
list, so it compresses about ten to one: 2.9 MB in the tree, 30 MB on disk.

## What is in it, and what is not

Built by `AZ_BUILD_QA_PROFILE` (see `apps/gui/src/qa_profile.rs`) from a real
store, because the shape has to be real - every bug this harness found lived in
the gap between invented data and real data. Every free-text field is replaced
by deterministic filler of the same length and line structure, so a transcript
still scrolls and a title still wraps.

Nothing from the machine it was built on survives. The 114 MB predecessor
carried 33,792 occurrences of the builder's home directory, two collaborators'
email addresses, and the verbatim shell history of every command an agent had
run. This one is checked for those markers on every rebuild:

```sh
grep -rac revenge tests/data/... # 0
```

**Pull request and issue URLs are deliberately real.** They point at public
repositories, so there is nothing to leak, and a live link is the only way the
GitHub connectivity paths get exercised against something that actually
resolves.

## Two heavy projects

`alpha sigma omega west` and `theta sigma beta amber alpha beta ea` keep 2,600
task-log rows and 1,200 messages each; every other project is capped at 20 and
12. A profile trimmed flat would still exercise every control while quietly
making every timing meaningless, so the depth is kept where it is load-bearing
and discarded everywhere else.

`alpha sigma omega west` is the fixture 14 of the 18 checks open by name. If a
rebuild renames it, those checks stop finding their surface - the names are
deterministic, so this only happens if the source store changes.

## Rebuilding

```sh
cargo build --bin az-gui --features blitz-inspector
AZ_BUILD_QA_PROFILE="$HOME/Library/Application Support/com.pathscale.agencyzero/db:/tmp/qa-profile-fixture" \
  ./target/debug/az-gui
(cd /tmp && tar -cf - qa-profile-fixture | zstd -19 -T0 -o <repo>/tests/data/qa-profile.tar.zst -f)
```

The builder reads the source store through a throwaway copy and writes only
scrubbed rows into a fresh one. It never opens the source in place: `.wt.data`
is append-only, so scrubbing a copy leaves the original bytes in the file, and
an earlier version of this fixture shipped clean-looking rows over 20,135 lines
of readable shell history.
