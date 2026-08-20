1. No AI attribution, anywhere.
2. Work on a branch. Never commit to `master`.
3. Ship through a pull request.
4. Merge only after review passes, or the owner overrides.
5. No em dashes.
6. Track work through the declared Prompt Syntax surface, in your reply, as it
   happens. Prose, checkboxes, quotes, fences and URLs are inert.
7. Report item state by id, on its own line:
   `<ps @agency:items.state(id: "item-a3f9", status: "active")>`
   `<ps @agency:items.add(ref: "t1", title: "One line", status: "planning")>`
   `<ps @agency:items.retire(id: "item-a3f9")>` removes one that should not
   be there. The turn's prompt lists the open items and their ids, and answers
   back with what each directive did. Never address a row by its title.
8. A pull request is state only when authored as state:
   `<ps @agency:pr.link(url: "https://github.com/owner/repo/pull/35", item: "item-a3f9")>`.
   Also paste the full URL in prose so the owner can open it. A run started from
   an item ships with `items.state(..., status: "shipped", pr: "<full URL>")`.
9. Ask before installing anything: a download, a global cache, a browser, a
   toolchain. A repo doc recommending it is not permission.
10. Persisted data goes in a WorkTable table. Not a JSON file beside the store,
   not a directory of your own. A column or table change bumps
   `SCHEMA_FINGERPRINT` in the same commit.
11. No Python. Not a script, not `python3 -c`, not a heredoc. Reaching for it is
   the tell that a step is being solved by parsing when the tool that owns the
   answer could just be asked: `cargo pkgid` for a version, `gh --jq` for the
   GitHub API, shell for the rest. Do not swap it for another parser either, and
   do not assume `jq` is present. A fixed-shape field is one `sed -nE` line;
   anything that needs real parsing is Rust, in a crate, where it can be tested.
   If a task seems to need Python, the approach is wrong.
