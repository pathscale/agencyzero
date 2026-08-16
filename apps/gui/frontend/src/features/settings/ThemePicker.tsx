import { Flex, Radio } from "@pathscale/ui";
import { createEffect, For, type JSX, Show } from "solid-js";
import { Button } from "~/components/Button";
import {
  accentOptions,
  BRIGHTNESS_STOPS,
  closestColorIndex,
  DEFAULT_ACCENT,
  MAX_SOFTNESS,
  normalizeWash,
  surfaceColors,
  WASH_STOPS,
} from "~/lib/theme";
import { t } from "~/stores/i18n";
import { prefs } from "~/stores/prefs";
import type { ThemeSettings } from "~/types";

/**
 * The colour wheel and the softness strip, side by side.
 *
 * The wheel owns literal AgencyZero colours rather than borrowing the
 * upstream contrast palette. That palette makes dark-mode swatches pastel so
 * they stand out from a black ring; here the swatch is the value, so dark mode
 * must offer dark-oriented colours and a pressed dot must equal the stored hex.
 *
 * The strip beside it is ours. nofilter's greyscale column switches between two
 * themes; there is one theme here, so the column drives the axis that actually
 * helps — how far the surfaces lift off the near-black floor.
 */
export function ThemePicker(props: {
  theme: ThemeSettings;
  onSurface: (hex: string) => void;
  onAccent: (hex: string) => void;
  onSoftness: (value: number) => void;
  onWash: (value: number) => void;
  onBrightness: (value: number) => void;
  onReset: () => void;
  isDefault: boolean;
}): JSX.Element {
  /** Five stops across the comfort range, matching the strength row beside it. */
  const softnessStops = () => Array.from({ length: 5 }, (_, i) => (i * MAX_SOFTNESS) / 4);

  /** The desk as currently configured — what every swatch sits on. */
  const deskAnchor = (softness: number) =>
    prefs.colorMode === "light"
      ? `oklch(calc(93% - ${softness}%) 0.004 240)`
      : `oklch(calc(10.5% + ${softness}%) 0.004 240)`;
  const deskStrength = (wash: number) => Math.min(wash * 1.1, 100);
  const deskPreview = (theme: ThemeSettings) =>
    `color-mix(in oklab, ${theme.surface || DEFAULT_ACCENT} ${deskStrength(theme.wash)}%, ${deskAnchor(theme.softness)})`;

  return (
    <div class="flex items-start gap-4 px-3.5 py-3">
      <div class="shrink-0">
        <SurfaceColorWheel value={props.theme.surface} onPick={props.onSurface} />
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
          label={t("appearance.colourStrength")}
          hint={t("appearance.colourStrengthHint")}
          stops={[...WASH_STOPS]}
          value={normalizeWash(props.theme.wash)}
          onPick={props.onWash}
          preview={(stop) =>
            `color-mix(in oklab, ${props.theme.surface || DEFAULT_ACCENT} ${deskStrength(stop)}%, ${deskAnchor(props.theme.softness)})`
          }
          format={(stop) => `${stop}%`}
          action={
            <Button
              type="button"
              aria-label={t("appearance.resetButton")}
              disabled={props.isDefault}
              onClick={props.onReset}
              class="ml-auto rounded-lg border border-az-hairline-strong px-2.5 py-1 text-[11px] text-az-muted transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("appearance.resetButton")}
            </Button>
          }
        />

        <Axis
          label={t("appearance.softness")}
          hint={t("appearance.softnessHint")}
          stops={softnessStops()}
          value={props.theme.softness}
          onPick={props.onSoftness}
          preview={(stop) =>
            `color-mix(in oklab, ${props.theme.surface || DEFAULT_ACCENT} ${deskStrength(props.theme.wash)}%, ${deskAnchor(stop)})`
          }
          format={(stop) => `${Math.round((stop / MAX_SOFTNESS) * 100)}%`}
        />

        {/*
         * The rungs are the point here, so these swatches carry a letter in
         * the text colour they produce rather than showing the colour as a
         * fill. A row of five near-identical pale circles says nothing; five
         * letters at different weights is the actual question being asked.
         */}
        <Axis
          label={t("appearance.textBrightness")}
          hint={t("appearance.textBrightnessHint")}
          stops={[...BRIGHTNESS_STOPS]}
          value={props.theme.textBrightness}
          onPick={props.onBrightness}
          preview={() => deskPreview(props.theme)}
          ink={(stop) =>
            prefs.colorMode === "light"
              ? `oklch(calc(28% + ${props.theme.softness * 0.45 - stop}%) 0.009 245)`
              : `oklch(calc(75% - ${props.theme.softness * 0.45 - stop}%) 0.009 245)`
          }
          format={(_stop, index) => `${Math.round((index / (BRIGHTNESS_STOPS.length - 1)) * 100)}%`}
        />

        <AccentSelector
          surface={props.theme.surface || DEFAULT_ACCENT}
          accent={props.theme.accent}
          wash={props.theme.wash}
          softness={props.theme.softness}
          onPick={props.onAccent}
        />
      </div>
    </div>
  );
}

/** Concentric literal swatches: what is shown is exactly what gets persisted. */
function SurfaceColorWheel(props: { value: string; onPick: (value: string) => void }): JSX.Element {
  const layout = [
    ...Array.from({ length: 12 }, (_, index) => ({ count: 12, index, radius: 56, phase: -30 })),
    ...Array.from({ length: 12 }, (_, index) => ({ count: 12, index, radius: 40, phase: -30 })),
    ...Array.from({ length: 6 }, (_, index) => ({ count: 6, index, radius: 21, phase: -60 })),
    { count: 1, index: 0, radius: 0, phase: 0 },
  ];
  const colors = () => surfaceColors(prefs.colorMode);
  let previous = colors();

  // Preserve the same petal across a mode change, and migrate the upstream
  // palette values written by earlier builds to the nearest literal petal.
  createEffect(() => {
    const next = colors();
    const value = props.value.trim().toLowerCase();
    if (value) {
      let selected = previous.findIndex((color) => color.toLowerCase() === value);
      if (selected < 0) selected = closestColorIndex(value, previous);
      const rebased = next[selected];
      if (rebased && rebased.toLowerCase() !== value) props.onPick(rebased);
    }
    previous = next;
  });

  return (
    <fieldset
      aria-label={t("appearance.surfaceColour")}
      class="relative m-0 size-[190px] rounded-full border border-az-hairline bg-az-inset p-0 shadow-inner"
    >
      <For each={colors()}>
        {(color, index) => {
          const point = layout[index()];
          const angle = ((point.index / point.count) * 360 + point.phase) * (Math.PI / 180);
          const x = Math.cos(angle) * point.radius;
          const y = Math.sin(angle) * point.radius;
          const selected = () => props.value.trim().toLowerCase() === color.toLowerCase();
          return (
            <span
              data-surface-petal={index()}
              class="absolute size-7"
              style={{
                left: `calc(50% + ${x.toFixed(2)}px)`,
                top: `calc(50% + ${y.toFixed(2)}px)`,
                transform: "translate(-50%, -50%)",
              }}
            >
              <Radio
                title={color}
                name="surface-colour"
                value={color}
                aria-label={`${t("appearance.surfaceColour")} ${color}`}
                checked={selected()}
                onChange={() => props.onPick(color)}
                indicator={
                  <span
                    aria-hidden="true"
                    class="block size-full rounded-full"
                    style={{ "background-color": color }}
                  />
                }
                class="size-7 cursor-pointer rounded-full [&_[data-slot=radio-control]]:m-0 [&_[data-slot=radio-control]]:size-7 [&_[data-slot=radio-control]]:border-2 [&_[data-slot=radio-control]]:border-az-hairline-strong [&_[data-slot=radio-indicator]]:overflow-hidden [&_[data-slot=radio-indicator]]:rounded-full"
              />
            </span>
          );
        }}
      </For>
    </fieldset>
  );
}

/** An independent high-contrast colour for controls, rings and active states. */
function AccentSelector(props: {
  surface: string;
  accent: string;
  wash: number;
  softness: number;
  onPick: (value: string) => void;
}): JSX.Element {
  const options = () => accentOptions(props.surface, prefs.colorMode, props.wash, props.softness);
  let previous = options();

  // A palette choice is semantic, not a frozen hex. Keep the same harmony
  // selected while its rendered colour responds to surface, mode, strength,
  // and softness. Older arbitrary hex values migrate to the nearest harmony.
  createEffect(() => {
    const next = options();
    let selected = previous.findIndex((option) => option.value === props.accent);
    if (selected < 1 && props.accent) {
      const closest = closestColorIndex(
        props.accent,
        previous.slice(1).map((option) => option.color),
      );
      if (closest >= 0) selected = closest + 1;
    }
    if (selected > 0 && next[selected]?.value !== props.accent) {
      props.onPick(next[selected].value);
    }
    previous = next;
  });
  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex items-baseline gap-2">
        <span class="font-semibold text-[11px] text-az-muted uppercase tracking-[.04em]">
          {t("appearance.accentColour")}
        </span>
        <span class="text-[11px] text-az-faint">{t("appearance.accentColourHint")}</span>
      </div>
      <Flex align="center" gap="sm">
        <For each={options()}>
          {(option, index) => {
            const selected = () => props.accent === option.value;
            const label = () =>
              index() === 0
                ? t("appearance.designedYellow")
                : `${t("appearance.accentColour")} ${index() + 1}`;
            return (
              <Button
                type="button"
                aria-label={label()}
                title={label()}
                aria-pressed={selected()}
                onClick={() => props.onPick(option.value)}
                class="size-7 rounded-full border-2 transition-[border-color,transform] hover:scale-110"
                classList={{
                  "border-primary": selected(),
                  "border-az-hairline-strong hover:border-primary": !selected(),
                }}
                style={{ "background-color": option.color }}
              />
            );
          }}
        </For>
      </Flex>
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
  /** When present, the swatch shows a letter in this colour instead of a fill alone. */
  ink?: (stop: number) => string;
  format: (stop: number, index: number) => string;
  action?: JSX.Element;
}): JSX.Element {
  const selected = (stop: number) => Math.abs(props.value - stop) < 0.01;
  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex items-baseline gap-2">
        <span class="font-semibold text-[11px] text-az-muted uppercase tracking-[.04em]">
          {props.label}
        </span>
        <span class="text-[11px] text-az-faint">{props.hint}</span>
        {props.action}
      </div>
      <Flex align="center" gap="sm">
        <For each={props.stops}>
          {(stop, index) => (
            <Button
              type="button"
              aria-label={`${props.label} ${props.format(stop, index())}`}
              aria-pressed={selected(stop)}
              onClick={() => props.onPick(stop)}
              class="size-7 rounded-full border-2 transition-[border-color,transform] hover:scale-110"
              classList={{
                "border-primary": selected(stop),
                "border-az-hairline-strong hover:border-az-hairline-strong/60": !selected(stop),
              }}
              style={{ "background-color": props.preview(stop) }}
            >
              <Show when={props.ink}>
                {(ink) => (
                  <span
                    class="font-semibold text-[12px] leading-none"
                    style={{ color: ink()(stop) }}
                  >
                    A
                  </span>
                )}
              </Show>
            </Button>
          )}
        </For>
      </Flex>
    </div>
  );
}
