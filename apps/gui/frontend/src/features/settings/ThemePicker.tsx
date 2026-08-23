import { ComplexColorWheel, Flex } from "@pathscale/ui";
import type { JSX } from "@solidjs/web";
import { createEffect, For } from "solid-js";
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
  writeAccentPreview,
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
  /** The second accent: icons and artwork, through `--color-accent-2`. */
  onAccentTwo: (hex: string) => void;
  onSoftness: (value: number) => void;
  onWash: (value: number) => void;
  onBrightness: (value: number) => void;
  onReset: () => void;
  isDefault: boolean;
}): JSX.Element {
  /** Five stops across the comfort range, matching the strength row beside it. */
  const softnessStops = () => Array.from({ length: 5 }, (_, i) => (i * MAX_SOFTNESS) / 4);
  const colors = () => surfaceColors(prefs.colorMode);
  let previousSurfacePalette = colors();

  // A palette choice is semantic. Preserve its petal across light/dark mode
  // changes and migrate literal colours written by older builds to the
  // nearest standard petal.
  createEffect(
    () => prefs.colorMode,
    () => {
      const next = colors();
      const value = props.theme.surface.trim().toLowerCase();
      if (value) {
        let selected = previousSurfacePalette.findIndex((color) => color.toLowerCase() === value);
        if (selected < 0) selected = closestColorIndex(value, previousSurfacePalette);
        const rebased = next[selected];
        if (rebased && rebased.toLowerCase() !== value) props.onSurface(rebased);
      }
      previousSurfacePalette = next;
    },
  );

  /**
   * The desk as currently configured — what every swatch sits on.
   *
   * Chroma and hue come from the live custom properties, not from literals.
   * `theme.css` builds the panel, `--color-base-100`, as
   *
   *     color-mix(in oklab, var(--az-surface) var(--az-wash-120),
   *               oklch(calc(15% + var(--az-lift))
   *                     calc(0.005 * var(--az-tint)) var(--az-hue)))
   *
   * and this used to hardcode `0.004` and `240`, dropping the tint multiplier
   * and pinning the hue to blue-grey. Every theme that moved its hue got
   * swatches previewing a colour the surface never becomes: the row said
   * blue-grey while the desk leaned toward the accent. The preview has to be
   * the same expression or it is decoration.
   *
   * It previews the *panel* rather than the desk, and that is the fix for two
   * faults at once. The desk is the tier the eye reads least - it sits behind
   * everything - and at 10.5% lightness it is close enough to black that mixing
   * a colour into it at 10% or at 50% lands in almost the same place: the five
   * strength swatches rendered as five near-identical dark circles, and the
   * softness row was worse, because every stop it shows differs only in that
   * same near-black anchor. Previewing the panel, at 15% and a step further up
   * the wash, is both the surface the picked colour is meant to land on and the
   * one where the difference between stops is visible.
   */
  const deskVar = (name: string, fallback: string): string => {
    if (typeof getComputedStyle === "undefined") return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  };
  const deskAnchor = (softness: number) => {
    const chroma = `calc(0.005 * ${deskVar("--az-tint", "1")})`;
    const hue = deskVar("--az-hue", "240");
    return prefs.colorMode === "light"
      ? `oklch(calc(98% - ${softness}%) ${chroma} ${hue})`
      : `oklch(calc(15% + ${softness}%) ${chroma} ${hue})`;
  };
  // The panel's own multiplier, so a swatch is the surface it stands for.
  const deskStrength = (wash: number) => Math.min(wash * 1.2, 100);
  const deskPreview = (theme: ThemeSettings) =>
    `color-mix(in oklab, ${theme.surface || DEFAULT_ACCENT} ${deskStrength(theme.wash)}%, ${deskAnchor(theme.softness)})`;

  return (
    <div class="flex flex-col gap-3">
      <ComplexColorWheel
        value={props.theme.surface || DEFAULT_ACCENT}
        onChange={props.onSurface}
        mode={prefs.colorMode}
        palette={colors()}
        aria-label={t("appearance.surfaceColour")}
        adjustments={[
          {
            id: "strength",
            label: t("appearance.colourStrength"),
            hint: t("appearance.colourStrengthHint"),
            stops: WASH_STOPS,
            value: normalizeWash(props.theme.wash),
            onChange: props.onWash,
            preview: (stop) =>
              `color-mix(in oklab, ${props.theme.surface || DEFAULT_ACCENT} ${deskStrength(stop)}%, ${deskAnchor(props.theme.softness)})`,
            formatValue: (stop) => `${stop}%`,
          },
          {
            id: "softness",
            label: t("appearance.softness"),
            hint: t("appearance.softnessHint"),
            stops: softnessStops(),
            value: props.theme.softness,
            onChange: props.onSoftness,
            preview: (stop) =>
              `color-mix(in oklab, ${props.theme.surface || DEFAULT_ACCENT} ${deskStrength(props.theme.wash)}%, ${deskAnchor(stop)})`,
            formatValue: (stop) => `${Math.round((stop / MAX_SOFTNESS) * 100)}%`,
          },
          {
            id: "text-brightness",
            label: t("appearance.textBrightness"),
            hint: t("appearance.textBrightnessHint"),
            stops: BRIGHTNESS_STOPS,
            value: props.theme.textBrightness,
            onChange: props.onBrightness,
            preview: () => deskPreview(props.theme),
            ink: (stop) =>
              prefs.colorMode === "light"
                ? `oklch(calc(28% + ${props.theme.softness * 0.45 - stop}%) 0.009 245)`
                : `oklch(calc(75% - ${props.theme.softness * 0.45 - stop}%) 0.009 245)`,
            formatValue: (stop) => {
              const index = (BRIGHTNESS_STOPS as readonly number[]).indexOf(stop);
              return `${Math.round((index / (BRIGHTNESS_STOPS.length - 1)) * 100)}%`;
            },
          },
        ]}
        action={
          <Button
            type="button"
            aria-label={t("appearance.resetButton")}
            disabled={props.isDefault}
            onClick={props.onReset}
            class="rounded-lg border border-az-hairline-strong px-2.5 py-1 text-[11px] text-az-muted transition-colors hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t("appearance.resetButton")}
          </Button>
        }
      />

      <div class="flex flex-col gap-3 px-3.5 pb-3">
        <AccentSelector
          surface={props.theme.surface || DEFAULT_ACCENT}
          accent={props.theme.accent}
          wash={props.theme.wash}
          softness={props.theme.softness}
          /*
           * Paint first, persist after.
           *
           * `onPick` reaches the tokens only once a settings round trip has
           * returned, so picking quickly queues one write per pick behind the
           * event loop. Measured on the stall frames: `max_interval_ms` of 70
           * to 92 while `paint_avg_ms` and `renderer_avg_ms` were both 0.00,
           * which is the loop waiting rather than the renderer working.
           */
          onPick={(value) => {
            writeAccentPreview(value, { accentTwo: props.theme.accentTwo });
            props.onAccent(value);
          }}
        />

        {/*
          The second accent, for what is drawn rather than operated.

          Same harmonies as the first, because both are chosen against the same
          surface and a second palette would only be a second thing to keep in
          step. What differs is where the colour lands: the first carries
          interactive state, this one carries icons and artwork through
          `--color-accent-2`.

          Empty follows the first accent, so a theme that never touches this row
          looks exactly as it did before the axis existed.
        */}
        <AccentSelector
          label={t("appearance.accentTwo")}
          hint={t("appearance.accentTwoHint")}
          surface={props.theme.surface || DEFAULT_ACCENT}
          accent={props.theme.accentTwo ?? ""}
          wash={props.theme.wash}
          softness={props.theme.softness}
          // Same trade as the row above, for the accent that reaches the icons.
          onPick={(value) => {
            writeAccentPreview(props.theme.accent, { accentTwo: value });
            props.onAccentTwo(value);
          }}
        />
      </div>
    </div>
  );
}

/** An independent high-contrast colour for controls, rings and active states. */
function AccentSelector(props: {
  /** Overrides the row's heading, for the second accent. */
  label?: string;
  hint?: string;
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
  /*
   * Track the palette; rebase in the effect argument, never the compute one.
   *
   * `onPick` writes the value this reads, so running it in the tracked phase
   * makes the write a dependency of its own computation - the same loop the
   * surface palette rebase avoids above.
   *
   * Both the mode and the accent are tracked, because a rebase has to follow
   * either. What matters is that `onPick` runs in the *effect* argument: the
   * write still re-enters this computation, but through the ordinary effect
   * queue rather than from inside the tracked phase, and the
   * `next[selected]?.value !== props.accent` guard below stops the second
   * pass, so it settles instead of looping.
   */
  createEffect(
    /*
       Track the palette, not the value.

       This tracked `props.accent` as well, so the effect re-ran on every pick
       and rebased the value the user had just chosen: the first click landed
       and every one after it was snapped back to the same option, because the
       index found in `previous` was written straight back from `next`. With
       two accent rows sharing one set of harmonies that made the second row
       look completely dead after its first use.

       The rebase exists for a *palette* change: the harmonies are derived from
       the mode, the surface, the strength and the softness, so moving any of
       those re-renders all seven swatches and a stored hex has to migrate to
       whichever one is nearest now. Those are what this watches.

       `props.accent` is not one of them. It is the *output* of this control,
       and tracking your own output is what makes a control fight its user.
    */
    () => [prefs.colorMode, props.surface, props.wash, props.softness] as const,
    () => {
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
    },
  );
  return (
    <div class="flex flex-col gap-1.5">
      <div class="flex items-baseline gap-2">
        <span class="font-semibold text-[11px] text-az-muted uppercase tracking-[.04em]">
          {props.label ?? t("appearance.accentColour")}
        </span>
        <span class="text-[11px] text-az-faint">
          {props.hint ?? t("appearance.accentColourHint")}
        </span>
      </div>
      <Flex align="center" gap="sm">
        <For each={options()}>
          {(option, index) => {
            const selected = () => props.accent === option.value;
            /*
              Named for the row it belongs to, so the two accent rows do not
              answer to the same accessible name. Two swatches called "Accent
              colour 2" in one pane is ambiguous to anyone navigating by name,
              and it silently doubled a test that counts them.
            */
            const row = () => props.label ?? t("appearance.accentColour");
            const label = () =>
              index() === 0
                ? `${row()}: ${t("appearance.designedYellow")}`
                : `${row()} ${index() + 1}`;
            return (
              <Button
                type="button"
                aria-label={label()}
                title={label()}
                aria-pressed={selected() ? "true" : "false"}
                onClick={() => props.onPick(option.value)}
                /*
                  A selected swatch cannot be marked in the accent.

                  `border-primary` is the accent, so ringing the *selected*
                  accent draws its own colour around itself and the one swatch
                  that matters is the only one with no visible ring. Both accent
                  rows and the wheel had it. The ring takes the text ladder's top
                  rung instead, which is chosen to be legible against every
                  surface this app paints, and a second inset ring separates it
                  from the swatch beneath.
                */
                class={`size-7 overflow-hidden rounded-full border-2 p-0 transition-[border-color,transform] hover:scale-110 ${
                  selected()
                    ? "border-az-title ring-2 ring-az-void ring-inset"
                    : "border-az-hairline-strong hover:border-az-title"
                }`}
              >
                {/* The fill is a child: the library's Button drops `style`. */}
                <span
                  aria-hidden="true"
                  class="block size-full rounded-full"
                  style={{ "background-color": option.color }}
                />
              </Button>
            );
          }}
        </For>
      </Flex>
    </div>
  );
}
