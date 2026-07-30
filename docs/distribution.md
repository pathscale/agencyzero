# Distribution

How AgencyZero reaches a Mac that is not this one, and how it upgrades once it
is there. Apple Silicon only, macOS 11 or later.

## Install

```bash
brew tap pathscale/tap
brew trust pathscale/tap
brew install --cask agencyzero
```

The cask lives in [pathscale/homebrew-tap](https://github.com/pathscale/homebrew-tap).
The `brew trust` step is required: Homebrew refuses to load a cask from a
third-party tap until the tap is trusted.

**This is the only install route that works.** Handing someone the tarball URL
does not, and the reason is worth understanding rather than rediscovering.

## Why Homebrew and not a download link

The bundle is ad-hoc signed, not notarized, so Gatekeeper rejects it: `spctl -a`
returns `rejected` on every Mac including the one that built it. Whether that
rejection is ever consulted comes down to the `com.apple.quarantine` flag, which
is set by the *downloading* program rather than by macOS:

| Arrival route | Quarantined? | Launches? |
|---|---|---|
| Built locally | No | Yes |
| `brew install --cask` | Yes, then stripped by the cask's `postflight` | Yes |
| Browser download | Yes | No, reports itself as damaged |
| `curl` / `scp` | No | Yes |

Ad-hoc signatures are portable. There is nothing machine-specific about them, so
an unquarantined copy runs anywhere. The cask's `postflight` removes the flag
Homebrew applies, and that single line is what makes the install work.

Two things follow that are easy to trip over:

- macOS Sequoia removed the Control-click bypass, so a user who downloads the
  tarball in a browser has no quick way out. They would have to go to System
  Settings, Privacy & Security, and Open Anyway.
- Homebrew removed `--no-quarantine` in 5.1 and is dropping Gatekeeper-failing
  casks from the official tap on 2026-09-01. That policy governs `homebrew/cask`
  only, so our own tap is unaffected, but the direction of travel is clear.

## Cutting a release

Bump `[workspace.package] version` in the root `Cargo.toml` and push to master.
That is the whole ritual.

That one field is the only version in the repo. `apps/gui/tauri.conf.json`
deliberately omits its `version` key so Tauri falls back to the crate version,
which means a single bump moves the bundle version, the in-app build stamp
(`az_core::VERSION`) and the number the updater compares, together. Tauri's own
docs suggest keeping the version in the config instead; that advice does not fit
here, because the build stamp already reads the crate version and two
declarations are two things to forget.

[`release.yml`](../.github/workflows/release.yml) decides whether to publish by
comparing that version against the one in the **live** `latest.json`, not against
git history. That makes it idempotent: a release that failed halfway is retried
by the next push, a re-run is harmless, and squashes and force-pushes cannot
confuse it. A push that changes code but not the version publishes nothing.

`workflow_dispatch` takes a `force` input for the case where you need to
republish the same version.

## Why the URL carries no version

Releases overwrite `AgencyZero.app.tar.gz` at a fixed path rather than
accumulating one file per version. Two consequences, both deliberate:

- `latest.json` is the only record of the current version, which is what the
  updater reads.
- The cask is pinned to `version :latest` with `sha256 :no_check`, because the
  bytes behind a fixed URL change. Homebrew therefore cannot detect a new
  release and `brew upgrade` will never touch the app. It does not need to: the
  app updates itself. The upside is that the cask never needs a commit per
  release, so no release touches the tap repo at all.

The cost is that the release workflow has to purge the BunnyCDN edge cache, and
has to do it in the right order: the tarball goes live and is confirmed live
*before* `latest.json` advertises it. Reversed, a client reads the new version,
fetches an edge-cached older tarball, and fails the signature check. Those purge
steps are hard failures in [`release.yml`](../.github/workflows/release.yml) for
that reason.

Three details of that choreography exist because the 0.1.1 release proved they
were not optional, and each guards against a distinct failure:

- **Storage objects are deleted before their replacement is uploaded.**
  Overwriting in place let an edge pull mid-overwrite and cache a splice of two
  uploads: the same length as the real file, an invalid gzip, and a ~300-day
  max-age. `gunzip -t` gates both the built tarball and the edge-served copy so
  a spliced object can never be advertised again.
- **Purges are zone-wide** (`pullzone/<id>/purgeCache`), never per-URL. The
  per-URL endpoint reported success without evicting the poisoned object, three
  times. Zone-wide eviction is the form the 24x.ai site pipeline has always
  used, and that site shares this pull zone and purges it on every deploy, so
  the collateral is nil.
- **`latest.json` advertises the tarball with a `?v=<version>` query string.**
  The pull zone keys its cache on the full URL, so each release's updater
  download goes through a cache key no edge has ever held — correct even if
  every purge silently fails. The bare URL remains for the cask and relies on
  the purge.

## Upgrades

The app carries Tauri's updater. `check_for_update` reads `latest.json`;
`install_update` downloads the tarball, verifies it against the minisign public
key baked into `tauri.conf.json`, replaces the installed bundle, drains the
tables and restarts. It refuses while any run is live, because an upgrade kills
every run this instance hosts.

Two limits worth knowing:

- **Non-admin users cannot upgrade.** `/Applications` is `root:admin`, and the
  updater runs with the user's own privileges, so a standard user gets
  `Permission denied (os error 13)`. Tauri closed the request to elevate as not
  planned. Fine for a developer audience, not fine for a managed fleet.
- **Every upgrade resets privacy permissions.** TCC identifies an app by its
  code signature, and an ad-hoc signature has no team identifier, so macOS keys
  the grant to a cdhash that changes on every build. Anyone whose repos live in
  `~/Documents`, `~/Desktop` or `~/Downloads` re-grants Files & Folders access
  after each update. A Developer ID certificate is the only fix, and it is the
  strongest practical argument for buying one.

## The signing key

Update artifacts are signed with minisign, which is unrelated to Apple signing.
The private key is at `~/.tauri/agencyzero.key` and in the repository secret
`TAURI_SIGNING_PRIVATE_KEY`; the matching public key is committed in
`tauri.conf.json`.

**Back the private key up.** Losing it means no installed copy can ever be
updated again, because the public key that would have to change is compiled into
the copies already out there.

## What buying a Developer ID would change

Signing and notarizing is worth roughly $99/year, and the release workflow is
already wired for it: set `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` and
the App Store Connect secrets, and the build switches from ad-hoc to Developer
ID with notarization and stapling. No code change. It would let a browser
download work, drop the `postflight` quarantine strip from the cask, and stop
upgrades from resetting TCC grants.
