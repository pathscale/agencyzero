# AgencyZero Blitz preview

This is an isolated native preview of the production AgencyZero frontend on Blitz + Boa. It
uses the frontend's built-in mock backend, winit windowing, Vello's CPU renderer, and
softbuffer presentation. It does not link Tauri, Wry, WebKit, V8, or a GPU renderer.

Build the frontend into `apps/gui/dist`, then create a macOS app bundle without Python:

```sh
apps/blitz-preview/build-app.sh release
open "target/release/bundle/macos/AgencyZero Blitz Preview.app"
```

The Rust build script embeds the generated CSS and JavaScript into the executable. This
preview is an interaction and rendering checkpoint, not the real Rust-backend integration;
that remains the `tauri-runtime-blitz` Stage 4 gate.

The normal Finder launch opens no control port. For an explicitly enabled debug session, run
the executable from a terminal with `TAURI_BLITZ_DRIVER=127.0.0.1:0` and
`TAURI_BLITZ_DRIVER_DESCRIPTOR` pointing at a private descriptor file.
