# CSS conformance results

Stage 2 started on 2026-08-09 after the debug-control gate passed.

## Current corpus inventory

The existing AgencyZero build at
`apps/gui/dist/static/css/index.3981681f.css` contains:

| Feature | Compiled CSS occurrences | Design artifact occurrences |
|---|---:|---:|
| `color-mix()` | 407 | 18 |
| `oklch()` | 43 | 334 |
| relative `rgb(from …)` | 21 | 0 |
| `@property` | 71 | 0 |
| `mask-image` | 168 | 0 |

These are literal occurrence counts, not unique declarations. They supersede the older counts
in `03-gaps.md` for the current build artifact.

## Measured results

`tools/css-probe` builds and renders with `PYTHON3` deliberately invalid. Its representative
fixture covers all five high-risk features plus the `@supports (color: color-mix(...))` branch.
The first 640×240 CPU render produced the expected layout and visible results for `oklch`,
`color-mix`, relative color, and masking. Its self-diff reported zero changed pixels and zero
mean absolute error.

Brave 151 supplied the Chromium reference at 1344×900. CDP captured settled DOM with styles
inlined, so Blitz and Chromium consumed the same post-JavaScript markup. No fixed delay was
used: capture waited for explicit artifact readiness and two animation frames.

| Corpus | Changed pixels | MAE | Pixels with RGB error >16 | Pixels with RGB error >64 |
|---|---:|---:|---:|---:|
| `design/workspace.html` | 320,143 / 1,209,600 | 8.0329 | 12.0508% | 6.1431% |
| compiled AgencyZero fixture | 255,707 / 1,209,600 | 3.8996 | 8.1031% | 2.8744% |

Every non-identical antialiased text pixel counts as changed, so the changed-pixel percentage
is intentionally strict. Dominant color-pair analysis separates palette errors from reflow. For
example, 50,277 design pixels are Chromium `[30,23,18]` versus Blitz `[31,23,18]`, and 39,622
are `[1,1,1]` versus `[1,2,2]`: one-channel rounding, not a wrong theme branch.

## Feature result

| Feature | Result | Evidence and owner |
|---|---|---|
| `oklch()` | Renders | Dominant dark palette and semantic colors match within rounding. Remaining position differences are primarily text metrics. |
| `color-mix()` | Renders | Highlighted borders, surfaces, badges, and the `@supports` branch render. Large uniform surfaces differ by one channel. |
| relative `rgb(from …)` | Renders | The isolated fixture renders the relative yellow; the compiled corpus has no broad fallback-color failure. |
| `@property` | No observed failure | The compiled Tailwind corpus parses and its transform-variable boilerplate does not disrupt the captured page. More focused animation coverage belongs after the static gate. |
| `mask-image` with linear gradients | Renders | The isolated mask fixture produces the expected triangle. |
| `mask-image` with data-URI SVG | **Fails** | The 168 compiled icon masks leave correctly sized but empty boxes. Owner: Blitz image/mask decoding, or replace these library icons with the app's existing inline SVG sprite. |

## Additional renderer gaps exposed

- Referenced SVG symbols (`<use href="#…">`) do not paint, removing icons in the design corpus.
- Input placeholder text does not paint in the compiled AgencyZero search field.
- System-font metrics are narrower than Chromium's, causing line wrapping and vertical reflow.
- Viewport and nested scrollbars do not paint.
- Body background is not propagated to transparent viewport pixels. Compositing those pixels
  lowers MAE but does not materially change the structural mismatch percentages.

## Gate conclusion

**Stage 2 complete.** The theme system resolves and the app remains recognisable and laid out;
there is no wholesale CSS parser failure. The measured work is bounded and concentrated in
icon masks/SVG paint, text/input paint, font metrics, scrollbar paint, and canvas background.
Per `02-plan.md`, Stage 3 may proceed to the real JavaScript bundle under Boa. This is not a
Tauri runtime success.
