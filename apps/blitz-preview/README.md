# AgencyZero Blitz preview

This is an isolated native preview of the production AgencyZero frontend on Blitz + Boa. It
uses the frontend's built-in mock backend, Tauri with `tauri-runtime-blitz`, winit windowing,
and Vello/wgpu rendering. On macOS, wgpu presents through Metal. The CPU renderer remains in
the preview for deterministic headless captures and as a reference fallback. It does not link
Wry or V8.
The bottom-right status banner exercises a real Tauri `greet` command and reports whether its
response returned through Boa.

Build the frontend into `apps/gui/dist`, then create a macOS app bundle without Python:

```sh
apps/blitz-preview/build-app.sh release
open "target/release/bundle/macos/AgencyZero Blitz Preview.app"
```

The Rust build script embeds the generated CSS and JavaScript into the executable. This
preview is the first native Tauri IPC checkpoint. The production command table remains mock-backed
until each AgencyZero command is exposed through the runtime.

The normal Finder launch opens no control port. Debug-control reintegration follows after the
concrete runtime window is stable.
