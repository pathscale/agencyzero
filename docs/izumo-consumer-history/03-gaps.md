# Measured gaps

From a survey of `~/code/agencyzero` (2026-08-09) against `blitz-script` on branch
`js-engine` and Blitz 0.3.0-beta.1.

## DOM APIs AgencyZero uses that blitz-script lacks

| API | Used by | Notes |
|---|---|---|
| `setPointerCapture` | `frontend/src/features/tabs/reorder.ts` | Custom tab drag-reorder, deliberately built on pointer capture instead of HTML5 DnD. Pointer events themselves ARE implemented; only capture is missing. |
| `document.getSelection()` | `frontend/src/lib/clipboard.ts` | Intercepts `copy` to work around global `user-select: none`. |
| `scrollIntoView` | 2 call sites | |
| `matchMedia` | color-scheme; `@pathscale/ui` calls it at import time | |
| `ResizeObserver` | `TabStrip.tsx:64`, `TranscriptPane.tsx:98` | Already `typeof`-guarded, degrades rather than throws. Low priority. |

Already implemented and sufficient: `getBoundingClientRect`, `querySelector(All)`,
`innerHTML`/`outerHTML`, `cloneNode`, full pointer/mouse/keyboard/focus events with bubbling,
`style.setProperty`/`getPropertyValue`.

## CSS features at risk

Blitz scores 44.3% WPT interop overall but 90.5% on `css-color`. The risk is concentrated in
Tailwind v4's color pipeline.

| Feature | Count in compiled CSS | Owner |
|---|---|---|
| `color-mix()` | 335 | `theme.css` -- ours |
| `oklch()` | 43 | ours |
| `rgb(from ... r g b / ...)` relative color | 14 | `src/styles/theme.css` -- ours |
| `@property` | 71 | Tailwind v4 boilerplate, mostly unused transform vars |
| `mask-image` (data-URI SVG icons) | 228 | `@iconify/tailwind4` inside `@pathscale/ui` -- ours |
| `backdrop-filter` | 8 (2 call sites) | `CloseConfirm.tsx:43`, `WelcomeFlow.tsx:202` |
| `filter:` | 3 | Blitz supports these on the Skia backend only, which is C++ -- so effectively unavailable to us |

**All of these are in code we own.** `@pathscale/ui` is ours; `theme.css` is ours. The app's
own source uses zero `icon-[...]` classes and already ships an inline SVG sprite
(`components/IconSprite.tsx`), so the icon fix is to move the library to the approach the app
already uses.

150 rules are wrapped in `@supports (color: color-mix(in lab, red, red))`, so a
non-supporting engine silently takes the fallback branch -- it will render wrong rather than
fail loudly. Screenshot-diff, do not eyeball.

## Not a problem

Zero usage anywhere in the app: container queries, `:has()`, 3D transforms, multi-column,
CSS anchor positioning, shadow DOM, custom elements, `<canvas>`, WebGL, Web Workers,
IndexedDB, WebSocket, EventSource, `contenteditable`, virtual scrolling.

Layout is 97% flexbox (459 `flex` vs 14 `grid` in TSX) -- Blitz's strongest area. The single
real `<table>` is markdown output in `features/project/MessageBody.tsx:364`.

Only two native `<select>` elements exist (`SettingsTab.tsx:1041`,
`WelcomeFlow.tsx:482`); `components/PillMenu.tsx:33` documents that everything else
deliberately uses `@pathscale/ui`'s `Dropdown`. Blitz does not support `<select>`; converting
those two to `Dropdown` removes the dependency entirely.

No heavy runtime libraries: markdown is hand-rolled, i18n is hand-rolled, no syntax
highlighter, no charts, no virtualization, no editor. Runtime deps are `solid-js`,
`@pathscale/ui`, `popmotion`, `promptsyntax`, `clsx`, `tailwind-merge`.
