# Store safety and recovery

What protects the WorkTable store, what to do when a launch fails anyway,
and how the pieces earned their existence on 2026-08-01, when a botched
migration plus a second writer turned every launch into a silent bus error.

## The engine bug at the bottom of it

The August 4 message failure isolated a second loaded-index defect:
**WorkTable forgot the physical fragmentation in a variable-width index page
when reconstructing its in-memory node after restart.** The message project
index had 174 live entries and 2,664 bytes left by deleted entries. After a
restart, 20 new entries were admitted using only the compact live size. The
growing slot directory then overlapped the values stored at the page tail by
64 bytes. The store continued to work from its intact in-memory index and
failed validation only on the next launch.

The upstream fix counts slot metadata when deciding to split and compacts a
fragmented page before its slot directory can reach the tail values. The
regression reproduces the exact 211 inserts, 37 deletes, restart, and 20
inserts sequence. This is independent from the earlier loaded-primary growth
bug and requires the same rule: repair indexes by rebuilding rows into a
fresh table, never by copying the damaged index file.

The August 6 pull-request failure was written by WorkTable beta5 during a long
session of periodic fact refreshes. Those updates changed unindexed String
fields but beta5 still rebuilt the whole row and its unchanged project index;
the persistence worker terminated and the next launch found 38 primary rows
disagreeing with `pr_project_idx`. Beta7 keeps those updates in place instead,
removing that secondary-index churn. `recover-pull-request-index` carries the
authoritative primary-linked rows into a fresh table when an older store has
already taken the damage.

## The rules, before anything else

Each of these was paid for by an incident. They are not advice.

1. **Never hand the engine a row that might not fit a 16K page.** An
   oversized insert is refused with `could not persist ... but 16356
   allowed` in the log — the row is lost. Every persisted string goes
   through a byte-counted cap (`MAX_PERSISTED_BLOB`, `capped_body`); a new
   column or a new insert site must say what bounds it.
2. **A table that SIGBUS'd, or whose `primary.wt.idx` has stopped growing
   while its data grows, is condemned.** It will open, read, and boot, and
   then die on an append. Do not copy it forward — a file copy carries the
   full index, which is how one incident became four. Rebuild row by row
   into fresh tables: `wt-migrate rebuild-store <source> <target>` (whole
   store, the default choice) or `rebuild-task-log` (that one table).
3. **Never open the live store from a second process, and never trust a name
   to tell you it is closed.** The binary is `az-gui`. Ask the files:
   `lsof +D ~/Library/Application\ Support/com.pathscale.agencyzero/db` —
   empty means free, anything means stop. The `db.lock` flock enforces this
   for the GUI and `wt-migrate`, but raw `cp`/`mv` bypasses an advisory lock,
   so the check is yours before any hand repair.
4. **Repair on copies, verify, then swap.** Never operate on the live
   directory first. A repaired store is verified by booting a debug build on
   a *copy* (`AZ_DATA_DIR=<copy> az-gui`; debug converts the SIGBUS into a
   named abort) before the real one is touched.
5. **A "working" store proves nothing about its history.** Reads succeed on
   damaged accounting; only appends detect it. The log is the record: grep
   for `could not persist` before declaring any store, backup, or snapshot
   clean.

## The invariants

- **One writer, mechanically.** The GUI holds an exclusive `flock` on
  `db.lock` beside the store for its whole life; `wt-migrate` takes the same
  lock on both its source and its target. A second opener is refused with a
  message, not corrupted. The lock is advisory and OS-released, so a crash
  cannot wedge the next launch.
- **Migration never touches the live store until it has fully succeeded.**
  On a schema mismatch the store is migrated into `db.next-<stamp>`; only on
  success does `db` become `db.pre-migration-<stamp>` (kept whole, forever
  yours to delete) and `next` become `db`. Any failure deletes the partial
  target and leaves `db` byte-for-byte as the old build wrote it.
- **A failed table leaves nothing behind.** A table the migration engine
  cannot carry starts empty, and its partial output is deleted rather than
  kept as data. Migrated item rows are additionally scrubbed against
  checkable facts (ids are `item-<uuid>`; projects are `proj-<uuid>` or the
  task manager) so a mixed-shape source cannot smuggle field-shifted rows in.
- **The mismatch check opens nothing it distrusts.** The stored fingerprint
  is read through the kv table alone (the one shape that never changes)
  before any other table's bytes are mapped.

## When the app will not open

Two escape hatches, each honored as an environment variable or an argument,
because a Finder launch has an environment and a terminal has arguments:

| Situation | Flag | Effect |
|---|---|---|
| Any launch failure, including a corrupt store crashing `Tables::open` | `AZ_NO_PERSIST=1` or `--debug-no-persist` | The real store stays closed and untouched; the app runs on a per-pid scratch store and keeps nothing. Settings shows the location source as `ephemeral`. |
| A schema mismatch you do not want migrated | `AZ_NO_DB_MIGRATION=1` or `--no-db-migration` | Nothing is migrated or touched; the store remains readable by the build that wrote it, so downgrading is always a way back. The session runs on scratch. |

```bash
AZ_NO_PERSIST=1 open -a AgencyZero   # or: az-gui --debug-no-persist
```

A failed migration already behaves like the second flag on its own: store
untouched, scratch session, options in the log.

## The rolling snapshot

Every boot, with the exclusive lock held and before any table opens, the
store is copied to `db.snapshot-1` (the previous one rotating to
`db.snapshot-2`). Boot is the one moment the store is guaranteed whole and
unheld, and every corruption so far was written during a session and found
at the next launch — exactly the window between two snapshots. Restoring
needs no tooling and costs at most one session:

```bash
rm -rf "~/Library/Application Support/com.pathscale.agencyzero/db" && cp -R "~/Library/Application Support/com.pathscale.agencyzero/db.snapshot-1" "~/Library/Application Support/com.pathscale.agencyzero/db"
```

A snapshot inherits rule 5: it is a file copy, so it also inherits any
poisoned accounting the store had when it was taken. It protects against
torn writes and bad sessions, not against rule 1 violations — those are
prevented at the insert, and repaired by rebuild, never by copy.

## Manual verified backups

Settings opens a native Save panel for backup and a native Open panel for
restore. Both actions close the app because the restart angel performs the
filesystem operation only after WorkTable has drained and the GUI has released
the exclusive lock. A successful backup stays closed for the profile handoff;
a failed backup or completed restore relaunches that profile. Cancelling either
panel leaves the app running untouched.

A manual backup is one ordinary DEFLATE ZIP named
`AgencyZero-backup-<id>.azbackup`. It contains a small `manifest.json` and the raw,
unmodified WorkTable files under `store/`; no rows are decoded or re-encoded.
The manifest records the package format, AgencyZero version, exact schema
fingerprint, and each file's byte length and SHA-256.

Restore requires the exact app version and schema, and refuses an unknown
package format or any missing/changed file. It extracts into staging and opens
every WorkTable table there before moving the current store. The store it
displaced is retained whole as `db.pre-restore-<id>`, so restore never destroys
the state it replaces. The package carries no profile id or source path. Save
it anywhere both profiles can reach, then select that same file from Normal;
the webview never receives or supplies either filesystem path.

The same limitation as the rolling snapshot applies: byte verification proves
the copy is complete, not that old WorkTable page accounting was healthy. Use a
row-by-row rebuild for a condemned table rather than restoring a file copy of
it.

## Recovering data by hand

`wt-migrate <source> <target>` carries a store forward out of band: source
read-only and locked, target must be new, report printed.
`wt-migrate rebuild-task-log <source> <target>` reads every task-log row out
of a damaged-but-readable store and inserts them into a brand-new table in
the target. `wt-migrate recover-task-log-index <source> <target>` rebuilds a
task log when its primary index is damaged but its project index survives.
`wt-migrate recover-message-index <source> <target>` rebuilds messages when
their project index is damaged but the authoritative primary index survives.
`wt-migrate recover-pull-request-index <source> <target>` does the same for a
damaged pull-request project index.
These commands validate every recovered row and never modify the source.
`agency-tools` reads any store read-only for inspection (`AZ_DATA_DIR=<dir>
agency-tools list-messages`). None will ever write into a store the GUI has
open; the lock sees to it.

## The incident this file is made of

A column was added without bumping the schema fingerprint (misread rows), the
fingerprint fix triggered a migration whose failure left its partial output
as the live store (debris rows), and a later backfill wrote table files the
running GUI already had open (a torn `task_log`, and every subsequent launch
died inside `Tables::open` before the window existed). Each invariant above
removes one link of that chain; the flags exist for whatever chain nobody has
imagined yet.

The third corruption taught rule 2 the hard way: the store was twice
"repaired" by copying `task_log` back from a backup. The copy read fine,
booted fine, and died on the first append of the next session — the caps
shipped that morning were working, and the mine was already in the ground.
The rebuild verbs exist so that repair is never done by copy again.

The fourth corruption exposed loaded-primary growth: `message`'s
`primary.wt.idx` stayed at exactly 65536 bytes while its data file grew, the
same frozen-index signature `task_log` showed at 229376 bytes. The next
incident had a different signature. Its message primary index and every row
link validated, while `project_idx.wt.idx` had physically overlapping
metadata and tail values. Raw bytes, a field-by-field validator, and the
deterministic fragmentation regression identified the restart accounting bug
described at the top of this file.
