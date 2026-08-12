# Build-graph witnesses: asserting that we build what we think we build

Written 2026-08-12. **Nothing here is implemented.** It names a class of failure this
repository has hit four times, records the prior art for catching it mechanically, and
proposes the specific assertions worth having. The measurements quoted come from
[performance.md](performance.md) and [allocations.md](allocations.md).

This is not a performance document. Every failure below was found by accident, late, after
someone had already drawn a conclusion from a build that was not the build they described.

## The class

**A feature, a dependency or a patch is not what the manifest appears to say, nothing
fails, and the difference is invisible until it is measured or crashes.**

Four instances, each recorded separately at the time, none of them recorded as an instance
of anything:

| # | What was wrong | How it surfaced | Cost |
|---|---|---|---|
| 1 | `blitz-dom`'s `incremental` feature was not in the build graph, so every `resolve` rebuilt the box tree and cleared the Taffy cache | a profile, weeks later | **13x**, measured. [performance.md](performance.md) calls it "the most fragile win here" |
| 2 | `log-phase-times` sat on the base `blitz-dom` dependency line, so per-frame instrumentation shipped in release and sat inside every number taken with it | reading the manifest while writing [allocations.md](allocations.md) | every measurement to that date had the instrument in the baseline |
| 3 | `ps-anyrender-vello` reaches the app through `tauri-runtime-blitz`, not through `ps-blitz-shell`, so a feature added where it was expected was never consulted | a feature that "did not work" | [HANDOVER.md](HANDOVER.md) records `cargo tree -e features -i <crate>` as the rule learned from it |
| 4 | Two copies of one crate from two sources (path versus git, or git versus crates.io) | a wall of type errors inside a dependency nobody edited | the root `Cargo.toml` and `.cargo/config.toml` comments describe "eleven unrelated type errors" and "sixty type errors, all of them that" |

Instance 4 is the only one that fails loudly, and even then it fails in the wrong place:
the error names a trait mismatch deep in a dependency rather than the duplicate that caused
it.

The common shape is that **cargo is doing exactly what it was told**, and what it was told
is spread across a workspace manifest, a crate manifest, a `[patch]` table, a feature
union, and a target gate. No single file states the result.

## Prior art: Genet asserts this in CI

Genet, reviewed 2026-08-12 (see [TODO.md](TODO.md), "From the Genet review"), runs two
witnesses on every push.

**A dependency-cone check** (`support/ci/check_dependency_cones.py`) that fails the build
unless all of the following hold:

- `genet-extract`'s dependency set is **exactly** `{layout_dom_api}`, compared as a set
  rather than a subset, so an addition fails as loudly as a removal;
- its build-dependencies are empty, and its dev-dependencies are fixtures only;
- it never reaches `genet-layout`, `genet-render`, `paint`, `paint_list_render`,
  `netrender` or `wgpu`, named individually as a forbidden set;
- no crate under `components/` path-depends on anything under `ports/`.

**A target witness**: `cargo check -p genet-layout --target wasm32-unknown-unknown`, which
is a standing proof that their layout crate has no native dependency. It is one command,
and it replaces an audit.

**The instructive part is what it does not catch.** Their cone check passes on every one of
their currently red runs. The failure they actually have is a `-sys` crate pulled into the
workspace through a vestigial member, and no cone was drawn around that. A witness catches
the class it was aimed at and is silent about every other class, which is an argument for
several narrow ones rather than one broad one.

## The witnesses worth having here

Ranked by the cost of the failure each would have caught. None is implemented.

### W1: the engine's features are what we think

Assert the resolved feature set for `ps-blitz-dom`, `ps-blitz-script` and
`ps-anyrender-vello` in a release-shaped build, from `cargo tree -e features -i <crate>`
rather than from the manifest, and fail on a diff against a checked-in expectation.

- **Catches instance 1**, which cost 13x, and instance 3, because the tool it uses is the
  one that answers "where does this crate actually come from".
- **Catches item 16 in reverse** once `parallel-construct` is enabled: a rev bump that
  drops the feature would otherwise restore the serial shaping silently.
- The expectation file is the point. A witness that prints the feature set and does not
  compare it is a log line nobody reads.

### W2: instrumentation is absent from release

Assert that `blitz-dom/log-phase-times` and the `dom-stats` feature are **not** in the
release feature set, and that they **are** in the inspector one.

- **Catches instance 2.** Item 1 in [TODO.md](TODO.md) fixed the instance by moving the
  feature onto `blitz-inspector`; nothing stops it moving back.
- Constraint 2 at the top of [TODO.md](TODO.md) exists because of this, and would be
  retired by it.

### W3: exactly one copy of each pivotal crate

Assert a single version and a single source for `stylo`, `ps-taffy`, `ps-anyrender`,
`ps-anyrender-vello`, `wgpu`, `parley` and `boa_engine`.

- **Catches instance 4** at the manifest rather than at the type error.
- As of 2026-08-12 all seven are single copies, so this is cheap to add while it is true
  and expensive to add after it breaks.
- **One of these is not like the others.** `stylo` declares `links = "servo_style_crate"`,
  so a second copy is a hard link error rather than a confusing type error. Genet hit this
  and solved it by renaming and publishing their fork as `genet-stylo`, which means a
  renamed Stylo *can* coexist. If we ever consume anything of theirs, W3 is the check that
  catches it.

### W4: no local patch escapes into a shipped build

Assert that a release build resolves no `[patch]` entry to a local path.

- `.cargo/config.toml` is tracked, carries a local `[patch]` block pointing at
  `~/code/ps-blitz-render`, and therefore shows as modified forever by design. That is a
  working arrangement, not a mistake, and it is exactly the arrangement that makes a
  machine-local build silently different from a release one.
- [HANDOVER.md](HANDOVER.md) names the sharper edge: `ps-blitz-render/Cargo.toml` points
  `taffy` at `../ps-taffy` by path **and is committed that way**, which breaks any other
  machine. A witness would have caught that on the commit rather than on the next clone.

### W5: a target-aware native-dependency inventory

Assert the set of crates that compile C or C++ for the **macOS release target**, and fail
on additions.

The trap here is ours, not hypothetical. `Cargo.lock` currently names **34 `-sys` crates**,
including the entire GTK and WebKit stack: `gtk-sys`, `webkit2gtk-sys`,
`javascriptcore-rs-sys`, `soup3-sys`, `atk-sys`, `gdk-sys`, `pango-sys`. None of them is
built on macOS; they are Tauri's Linux target dependencies and they sit in the lock because
a lock file is target-independent.

So the naive form of this check, grepping the lock for `-sys`, returns 34 false positives
and would be switched off within a week. **The lock is not the build graph.** It has to be
`cargo tree --target aarch64-apple-darwin`, and the expectation has to be per target.

This is the same mistake the Genet audit had to avoid from the other side: with no lock
committed at all, their dependency set had to be walked from manifests, and that walk is a
floor rather than a ceiling because feature unification is invisible to it.

## Traps, named in advance

1. **The lock is not the graph.** See W5. Target gates and feature unification both live
   outside it.
2. **A grep is not a witness.** Instances 1 and 2 were both visible in a manifest to anyone
   who thought to look. The failure was not that the information was hidden, it was that
   nobody had a reason to look. Only a comparison that fails a build changes that.
3. **A witness that cannot fail is decoration.** Genet's cone check passes on every red
   run of theirs. Each witness should be broken deliberately once, and observed failing,
   before it is trusted. This is the same rule [HANDOVER.md](HANDOVER.md) records under
   "One instrument that lies", arrived at from three separate green-suite incidents.
4. **Expectation files rot into rubber stamps.** If updating the expectation is the normal
   response to a failure, the witness has become a changelog. The commit that changes an
   expectation should have to say why in its message.
5. **Do not put these on the release workflow only.** All four instances above were present
   in local builds for days or weeks before any release, and instance 2 corrupted
   measurements that were never released at all.

## Cost, and where it would live

The cheap version is one script invoked from CI, in the shape of Genet's: read
`cargo tree` and `cargo metadata`, compare against checked-in expectations, exit non-zero
with the diff. W1 to W4 are all `cargo metadata` or `cargo tree` reads with no build.
W5 needs a resolve per target but still no compile.

Ubicloud runners only, per the standing rule for this repository. There is no reason for
any of this to be a separate workflow rather than steps in the existing one.

## Related

- [TODO.md](TODO.md), item 22, which this document is the detail behind, and "From the
  Genet review" for the prior art and the audit that prompted it.
- [performance.md](performance.md) for instance 1, its 13x, and the warning that copying
  the dependency line without the feature restores the regression with no error and no
  failing test.
- [allocations.md](allocations.md) for instance 2, and what the shipped instrumentation
  cost per frame.
- [HANDOVER.md](HANDOVER.md) for instance 3's rule, the committed local path in
  `ps-blitz-render/Cargo.toml`, and "One instrument that lies".
