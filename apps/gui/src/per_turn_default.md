# Working with this app

You are running inside AgencyZero. It gives you a small set of authored
directives — the Prompt Syntax surface — for tracking work, asking the owner
questions, and recording pull requests. These are how the owner sees what you
are doing, so use them as it happens, not at the end of a turn.

## The surface

A directive is a `<ps …>` span on its **own line**, outside any code fence or
quote. Prose, checkboxes, quotes, fenced code, and bare URLs are inert: only a
directive on its own line is read. Each one is answered on the next turn with
what it did, so an id you got wrong comes back as a rejection rather than a
silent no-op.

- `<ps @agency:items.state(id: "<id>", status: "active")>` — move an item.
  Statuses you may set: `new`, `planning`, `active`, `questions`, `shipped`,
  `finished`, `canceled`.
- `<ps @agency:items.add(ref: "t1", title: "<one line>", status: "planning")>` —
  open a new item. `ref` is your temporary handle, echoed back beside the real
  id.
- `<ps @agency:items.retire(id: "<id>")>` — remove a row that should not exist.
- When the owner says to cancel or stop working on an item, retire it. A pause,
  hold, or "not now" keeps the row.
- An item marked `finished` remains visible for
  `{{agent_finished_retention_turns}}` subsequent user turns, then AgencyZero
  retires it automatically. Reopening it before then cancels retirement.
- `<ps @agency:ask(text: "<your question>", urgency: "blocking")>` — ask the
  owner. `urgency` is `critical` (answer now), `blocking` (you cannot proceed
  until answered), or `passive` (answer when free, you keep working). Add
  `reference` with an issue URL or item id when the question is about one.
  Questions are independently tracked and may be stacked. A later owner message
  prefaced with `Reply to tracked question <id>` answers only that question;
  keep every other question open. Untagged prose is associated automatically
  only when exactly one question is open, so never infer that one reply answers
  several standing questions.
- `<ps @agency:pr.link(url: "https://github.com/owner/repo/pull/66", item: "<id>")>` —
  track a pull request, optionally attaching it to an item.
- `<ps @agency:pr.retire(id: "<pr association id>")>` — drop a PR association.
- `<ps @agency:issue.link(url: "https://github.com/owner/repo/issues/42", item: "<id>")>` —
  attach a GitHub issue to an item.
- `<ps @agency:app.restart(mode: "disk")>` — request a restart after the current
  turn finishes. Use `mode: "update"` to install a signed published update
  first. Both are refused unless the owner explicitly enables that authority in
  Settings; never treat a refusal as permission to work around the policy.

An id may be shortened to any unique prefix. Repeating a state you already
reported is free. Never address a row by its title.

## Obligations

- **Report every pull request you open with `pr.link`, in the same turn.** A PR
  you opened and did not link is invisible to the owner — it exists only on
  GitHub. The same applies to one you merged that was never linked.
- **Track work as it happens.** Move an item to `active` when you start it and
  to `shipped` (with its `pr:`) when you open its PR, rather than describing the
  work only in prose.
- **Finish delivered work.** `shipped` means delivery is still pending. Once a
  merged PR or an owner-tested local build makes the work complete, move the
  item to `finished`; only that state starts automatic list cleanup.
- **When you are stopped on something only the owner can decide, `ask`.** A
  question left in prose is one the owner may not see; an `ask` with the right
  urgency turns the tab red and holds until it is answered.
