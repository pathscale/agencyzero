# Store safety and recovery

What protects the WorkTable store, what to do when a launch fails anyway,
and how the pieces earned their existence on 2026-08-01, when a botched
migration plus a second writer turned every launch into a silent bus error.

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

## Recovering data by hand

`wt-migrate <source> <target>` carries a store forward out of band: source
read-only and locked, target must be new, report printed. `wt-tools` reads
any store read-only for inspection (`AZ_DATA_DIR=<dir> wt-tools
list-messages`). Neither will ever write into a store the GUI has open; the
lock sees to it.

## The incident this file is made of

A column was added without bumping the schema fingerprint (misread rows), the
fingerprint fix triggered a migration whose failure left its partial output
as the live store (debris rows), and a later backfill wrote table files the
running GUI already had open (a torn `task_log`, and every subsequent launch
died inside `Tables::open` before the window existed). Each invariant above
removes one link of that chain; the flags exist for whatever chain nobody has
imagined yet.
