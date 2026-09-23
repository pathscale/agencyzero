# Risks and honest cost

## The load-bearing risk: blitz-script is an unreviewed draft

[PR #491](https://github.com/DioxusLabs/blitz/pull/491) is an **open draft**. The author is
Blitz's lead maintainer (nicoburns), and his own PR body says:

> This is an AI-generated implementation of JavaScript support for Blitz using the Boa JS
> engine. I have not yet reviewed the code.

Follow-up comment: *"I think this PR has architectural issues, and probably isn't mergeable in
this form."*

JavaScript sits in the **backlog** on Blitz's roadmap, and the NLnet grant funding Blitz
explicitly scopes JS out. **Assume this never merges upstream.** We carry it.

Encouraging counter-signal: a contributor got React 18 + TypeScript running on that branch by
adding only `classList`, `closest`, and `dataset`. The DOM surface needed to bootstrap a real
framework is small.

## Prior art went the other way

`JohannaWeb/Aurora` shipped a manifest pairing Blitz 0.3.0-alpha.4 with Boa 0.20, and its
current README says Boa and SpiderMonkey experiments were removed in favour of V8. Reason not
stated. Worth reading that repo's history before committing -- it is the closest prior
attempt. (Flagged as unverified: a second source described a different project of the same
name, and this was not confirmed by reading the repo.)

`tbro/rakers` implemented both Boa and QuickJS behind features, then defaulted to QuickJS.

## Performance

Boa has **no JIT**. On the V8 benchmark suite it scores 211 against 2552 for *jitless* V8 --
roughly 12x slower, and against JIT-enabled V8 far worse. RegExp is the worst case: 47 vs
3941.

Mitigating: AgencyZero is not compute-heavy. The 542 KB bundle is Solid (no VDOM diffing) plus
hand-rolled markdown. But `MessageBody.tsx` parses markdown with regex on every message
render, and that is exactly Boa's weakest operation. Profile it in Stage 3.

Blitz also has an open issue (#595) about transform performance degrading around 200
elements. `anyrender_vello_cpu` (CPU raster) is slower still than the GPU backends.

## The GPU tradeoff

`anyrender_vello_cpu` avoids wgpu entirely. wgpu is pure Rust at build time, but at runtime it
dlopens the Vulkan/Metal/D3D driver -- a large C++ attack surface sitting exactly where
untrusted content is rendered. CPU raster is the choice consistent with the policy; it costs
performance.

## Published tauri-runtime names WebKit on macOS

`tauri-runtime 2.11.3` unconditionally depends on `objc2-web-kit` because three public macOS
fields expose `WKWebView`/`WKWebViewConfiguration` types. A minimal release binary that merely
mentions `tauri_runtime::Error` therefore carries a WebKit framework load command even though
it contains no webview implementation.

This does **not** require a Tauri fork. The reference is unused by a Blitz runtime, and linking
with `-Wl,-dead_strip_dylibs` removes WebKit, AppKit, Foundation, CoreFoundation, and Objective-C
from the minimal proof binary, leaving only `libSystem`. The repository's Cargo config applies
that flag on macOS. `tools/tauri-runtime-link-check/verify.sh` rebuilds the proof and fails if
WebKit, `libc++`, or Python appears in the final Mach-O dependencies. Apply the same linker flag
in the consuming AgencyZero Blitz build and retain an `otool -L` release gate.

## Pure Rust is not the same as no unsafe

`boa_gc` is a tracing GC built on `unsafe trait Trace` with manual trace/finalize. Writing DOM
bindings means implementing `Trace` for DOM nodes. The memory-unsafety risk is not eliminated,
it is relocated -- from a 20-year-hardened C++ codebase into new, unaudited, partly
AI-generated Rust.

Genuine wins that survive this caveat: no JIT (historically the richest source of browser
RCE), a vastly smaller attack surface, and unsafety confined to marked blocks.

Genuine loss: WebKit gets security patches from Apple within days. This stack gets them when
we write them.

## Maturity

- Blitz `0.3.0-beta.1`, README still says pre-alpha, site says alpha, production targeted
  "sometime in 2026". 44.3% WPT interop.
- Boa `0.21.1`, self-described experimental, 96.14% test262, pre-1.0.
- `boa-dev/oscars` is actively redesigning the GC API before 1.0 -- expect churn.
- Boa must be git-pinned: released Boa needs `icu_normalizer ~2.0.0`, parley needs `^2.1.1`.
  Resolves when Boa ships 0.22. MSRV goes 1.89 -> 1.91.

## Scope honesty

This replaces a component that works today, on a shipping app, with an engine at 44% WPT and
a JS integration its own maintainer calls unmergeable. Estimate 6-12 months to parity.

It is the right call only if memory-safe desktop rendering is a product requirement rather
than a preference. Stages 1 and 2 cost about a week and tell us most of what we need to know.
