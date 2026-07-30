import { ColorPickerContext, ColorWheelFlower } from "@pathscale/ui/components/color-wheel-flower";
import { For, type JSX } from "solid-js";
import { DEFAULT_ACCENT, MAX_SOFTNESS, toColorValue } from "~/lib/theme";
import type { ThemeSettings } from "~/types";

/**
 * The colour wheel and the softness strip, side by side.
 *
 * The wheel is `@pathscale/ui`'s `ColorWheelFlower`, the same one nofilter.io
 * shows — it takes its value and its handler from a context rather than props,
 * which is the whole integration. What is *not* reused is that package's
 * `ThemeColorPicker` wrapper: it writes `--color-base-*` against nofilter's own
 * anchors and resolves light/dark by reading `data-theme` for the literal
 * "light"/"dark", so under this app's `data-theme="agencyzero"` it falls back to
 * the OS setting and would paint near-white surfaces over a dark workspace.
 *
 * The strip beside it is ours. nofilter's greyscale column switches between two
 * themes; there is one theme here, so the column drives the axis that actually
 * helps — how far the surfaces lift off the near-black floor.
 */
export function ThemePicker(props: {
  theme: ThemeSettings;
  onAccent: (hex: string) => void;
  onSoftness: (value: number) => void;
}): JSX.Element {
  /*
   * The wheel wants a full ColorValue and hands one back on change. An empty
   * accent means "the palette's own", and that fallback lives in `lib/theme.ts`
   * so there is exactly one place naming the default yellow.
   */
  const current = () => toColorValue(props.theme.accent || DEFAULT_ACCENT);

  /** Six stops, dark to soft, mirroring the six swatches nofilter's strip has. */
  const stops = () => Array.from({ length: 6 }, (_, i) => (i * MAX_SOFTNESS) / 5);

  return (
    <div class="flex items-start gap-4 px-3.5 py-3">
      <div class="shrink-0">
        <ColorPickerContext.Provider
          value={{
            color: current,
            format: () => "hex",
            disabled: () => false,
            onChange: (color) => props.onAccent(color.hex),
            onFormatChange: () => {},
          }}
        >
          {/* The component sizes itself at 190px square and ships its own
              stylesheet, so there is nothing to add here. */}
          <ColorWheelFlower />
        </ColorPickerContext.Provider>
      </div>

      <div class="flex flex-col gap-1.5">
        <span class="font-semibold text-[11px] text-az-muted uppercase tracking-[.04em]">
          Softness
        </span>
        <div class="flex flex-col gap-1.5">
          <For each={stops()}>
            {(stop) => (
              <button
                type="button"
                aria-label={`Softness ${Math.round((stop / MAX_SOFTNESS) * 100)}%`}
                aria-pressed={Math.abs(props.theme.softness - stop) < 0.01}
                onClick={() => props.onSoftness(stop)}
                class="size-6 rounded-full border transition-colors"
                classList={{
                  "border-primary": Math.abs(props.theme.softness - stop) < 0.01,
                  "border-az-hairline-strong hover:border-az-hairline-strong/60":
                    Math.abs(props.theme.softness - stop) >= 0.01,
                }}
                /* Each swatch previews the desk it produces, so the strip reads
                 * as the thing it does rather than as six grey circles. */
                style={{
                  "background-color": `oklch(calc(10.5% + ${stop}%) 0.004 240)`,
                }}
              />
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
