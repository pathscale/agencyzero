# Native Ekojit integration requirements

This records the integration boundary represented by the current GUI and
preview changes. It is a source review, not runtime acceptance.

## Required wiring

- Resolve `ps-blitz-script-ekojit` alongside the matching Blitz and Izumo
  release line. Do not introduce duplicate renderer or script trait identities.
- Keep the application's `Document` adapter responsible for forwarding DOM
  access, UI events, polling, settling, visibility, lifecycle, and teardown to
  the native document.
- Preserve the host bridge for evaluation, JSON evaluation, IPC, current URL,
  and poll hooks. Keep callbacks attached to the document that owns their
  runtime state.
- Keep the deterministic preview's embedded asset fetcher and capture path
  independent from the application's production asset loading.
- Declare Ekojit as a non-optional preview dependency while preview source
  constructs its document unconditionally. The application may keep the
  dependency optional because its `blitz-runtime` feature gates the integration.

## Public dependency gate

The current working-tree manifests resolve the native backend through a sibling
checkout. That package is not published, so a public clone cannot resolve the
dependency. This integration is preserved locally for review, but it is not
ready for a public PR until the dependency is available through a public source
and the manifest no longer relies on a repository-relative sibling path.

## Remaining integration work

- The GUI and preview host adapters currently return `unsupportedRequest` for
  the diagnostics request surface. Their diagnostic batch methods expose only
  the runtime's console and error entries, without lost-entry accounting.
- Both adapters currently return `false` from debug-controller servicing.
  Confirm which control and diagnostics behaviors the consumer needs before
  claiming full inspector parity.
- Review error propagation from runtime setup and IPC registration. Current
  adapters intentionally discard some setup/evaluation results, so failures
  may not reach the caller.
- Validate the actual supported feature combinations and the native GUI and
  preview paths when runtime verification is authorized.

## Exclusions

Do not add statistical lexical identity, proxy learning, or benchmark-specific
behavior to this integration. Do not claim runtime acceptance from source
inspection alone.
