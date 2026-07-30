import { ColorPickerContext, ColorWheelFlower } from "@pathscale/ui/components/color-wheel-flower";
import { For, type JSX } from "solid-js";
import { DEFAULT_ACCENT, MAX_SOFTNESS, toColorValue, WASH_STOPS } from "~/lib/theme";
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
  onWash: (value: number) => void;
}): JSX.Element {
  /*
   * The wheel wants a full ColorValue and hands one back on change. An empty
   * accent means "the palette's own", and that fallback lives in `lib/theme.ts`
   * so there is exactly one place naming the default yellow.
   */
  const current = () => toColorValue(props.theme.accent || DEFAULT_ACCENT);

  /** Five stops across the comfort range, matching the strength row beside it. */
  const softnessStops = () => Array.from({ length: 5 }, (_, i) => (i * MAX_SOFTNESS) / 4);

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

      <div class="flex flex-1 flex-col gap-3">
        {/*
         * Strength before softness: it is the one that decides whether the
         * wheel did anything at all, and each swatch previews the desk it
         * produces so the row reads as its own effect rather than as five
         * circles. At 0 the workspace stays the designed grey and only the
         * accent moves — which is a legitimate choice, just not the default.
         */}
        <Axis
          label="Colour strength"
          hint="how far the picked colour reaches into the surfaces"
          stops={[...WASH_STOPS]}
          value={props.theme.wash}
          onPick={props.onWash}
          preview={(stop) =>
            `color-mix(in oklab, ${props.theme.accent || DEFAULT_ACCENT} ${stop * 1.1}%, oklch(calc(10.5% + ${props.theme.softness}%) 0.004 240))`
          }
          format={(stop) => `${stop}%`}
        />

        <Axis
          label="Softness"
          hint="how far the surfaces lift off black"
          stops={softnessStops()}
          value={props.theme.softness}
          onPick={props.onSoftness}
          preview={(stop) =>
            `color-mix(in oklab, ${props.theme.accent || DEFAULT_ACCENT} ${props.theme.wash * 1.1}%, oklch(calc(10.5% + ${stop}%) 0.004 240))`
          }
          format={(stop) => `${Math.round((stop / MAX_SOFTNESS) * 100)}%`}
        />
      </div>
    </div>
  );
}

/**
 * One row of preview swatches.
 *
 * Horizontal rather than the vertical column nofilter uses: theirs picks one of
 * six greyscale *themes*, ours moves a continuum, and a row reads as a slider
 * where a column reads as a menu.
 */
function Axis(props: {
  label: string;
  hint: string;
  stops: number[];
  value: number;
  onPick: (value: number) => void;
  preview: (stop: number) => string;
  format: (stop: number) => string;
}): JSX.Element {
  const selected = (stop: number) => Math.abs(props.value - stop) < 0.01;
  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex items-baseline gap-2">
        <span class="font-semibold text-[11px] text-az-muted uppercase tracking-[.04em]">
          {props.label}
        </span>
        <span class="text-[11px] text-az-faint">{props.hint}</span>
      </div>
      <div class="flex items-center gap-2">
        <For each={props.stops}>
          {(stop) => (
            <button
              type="button"
              aria-label={`${props.label} ${props.format(stop)}`}
              aria-pressed={selected(stop)}
              onClick={() => props.onPick(stop)}
              class="size-7 rounded-full border-2 transition-colors"
              classList={{
                "border-primary": selected(stop),
                "border-az-hairline-strong hover:border-az-hairline-strong/60": !selected(stop),
              }}
              style={{ "background-color": props.preview(stop) }}
            />
          )}
        </For>
      </div>
    </div>
  );
}
