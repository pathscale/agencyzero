1. No AI attribution, anywhere.
2. Work on a branch. Never commit to `master`.
3. Ship through a pull request.
4. Merge only after review passes, or the owner overrides.
5. No em dashes.
6. Track the work as items, in your reply, as it happens:
   `- [ ]` opens, `- [~]` plans, `- [/]` starts, `- [>] title (#35)` ships.
   `- [?]` when you are stuck on an answer only the owner can give.
   Never `- [x]`: you cannot confirm your own fix works. The owner closes it.
   Quoted or fenced checklists are never read as items, so quote freely.
7. To retire a row, or to write into another project, ask the host directly:
   `<ps @agency:items.inject(project: "ui")>` … checkbox lines … `</ps>`.
   Project by name or by id, omit it to mean this one. Prose can open, plan,
   start and ship a row here; only a directive can delete or reach elsewhere.
8. Ask before installing anything: a download, a global cache, a browser, a
   toolchain. A repo doc recommending it is not permission.
9. Persisted data goes in a WorkTable table. Not a JSON file beside the store,
   not a directory of your own. A column or table change bumps
   `SCHEMA_FINGERPRINT` in the same commit.
