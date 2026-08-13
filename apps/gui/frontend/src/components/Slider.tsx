import { createSignal, type JSX, onCleanup, Show } from "solid-js";

/**
 * A slider the application owns.
 *
 * PathScale/UI ships one, and it was replaced rather than patched again. Three
 * separate rounds of `!important` overrides went into making its browser
 * assumptions survive this renderer, and each one fixed the paint without
 * reaching the logic underneath:
 *
 * - It positions the thumb with `transform: translateX(-50%)`. Transforms are
 *   paint-only in blitz, so the box that receives the pointer stayed half a
 *   thumb to the right of the thumb you could see. Measured on the live window
 *   at value 30: painted across x 868..888, hit box at 878..897, so pressing
 *   the left half of the knob missed it, hit the track, and jumped the value
 *   away from the pointer.
 * - Its thumb travels the full width of the track, so at either end half the
 *   knob hangs outside the rail it is supposed to ride.
 * - It paints the thumb with `--color-accent-foreground`, which this theme
 *   derives from `readableInk(accent)`: the colour chosen for *text on* the
 *   accent. Against a light blue accent that is near black, so the knob came
 *   out as a dark blob welded to the end of the fill.
 *
 * The interaction model is egui's, which is the reference worth copying here
 * because it is written for a renderer with no DOM and no native controls:
 *
 * ```rust
 * position_range = rect.x_range().shrink(handle_radius)
 * normalized = remap_clamp(position, position_range, 0.0..=1.0)
 * ```
 *
 * The thumb's *centre* travels a range inset by half the thumb at each end, and
 * the same inset range converts a pointer position back to a value. Those two
 * have to be the same range or the knob and the number disagree at the ends.
 */
export type SliderProps = {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  /** Every change, including each tick of a drag. Use for live preview. */
  onInput?: (value: number) => void;
  /** The settled value: pointer released, or a keypress. Use for persistence. */
  onChange: (value: number) => void;
  /**
   * The value as a person reads it. Always used for `aria-valuetext`, and shown
   * beside the track unless `showValue` says otherwise: some callers print the
   * same label themselves and do not want it twice.
   */
  formatValue?: (value: number) => string;
  showValue?: boolean;
  /** Rendered beside the readout, e.g. a reset affordance. */
  trailing?: JSX.Element;
  class?: string;
};

export function Slider(props: SliderProps): JSX.Element {
  let track!: HTMLDivElement;
  let thumb!: HTMLDivElement;
  const [dragging, setDragging] = createSignal(false);

  const clampToStep = (raw: number): number => {
    const stepped = Math.round((raw - props.min) / props.step) * props.step + props.min;
    const bounded = Math.min(props.max, Math.max(props.min, stepped));
    /*
     * Re-rounded to the step's own precision. `0.1 * 3` is `0.30000000000000004`,
     * and a value like that reaches the readout, the store and the stylesheet.
     */
    const decimals = (String(props.step).split(".")[1] ?? "").length;
    return Number(bounded.toFixed(decimals));
  };

  const fraction = (): number => {
    const span = props.max - props.min;
    if (span <= 0) return 0;
    return Math.min(1, Math.max(0, (props.value - props.min) / span));
  };

  /**
   * A pointer x, in client space, as a value.
   *
   * Inset by half the thumb at each end so that the far ends are reachable:
   * without it, the pointer would have to travel outside the track to reach
   * the extremes that the thumb can actually display.
   */
  const valueAt = (clientX: number): number => {
    const rail = track.getBoundingClientRect();
    const inset = thumb.getBoundingClientRect().width / 2;
    const usable = rail.width - inset * 2;
    if (usable <= 0) return props.value;
    const ratio = Math.min(1, Math.max(0, (clientX - rail.x - inset) / usable));
    return clampToStep(props.min + ratio * (props.max - props.min));
  };

  const emit = (value: number, settled: boolean): void => {
    if (value !== props.value) props.onInput?.(value);
    if (settled) props.onChange(value);
  };

  /*
   * Listeners on the window, not the thumb.
   *
   * A drag has to keep tracking after the pointer leaves the 10px-high knob,
   * which it does immediately. `setPointerCapture` would be the browser answer
   * and is not something to rely on here.
   */
  let stopDrag: (() => void) | undefined;
  onCleanup(() => stopDrag?.());

  const beginDrag = (event: PointerEvent, jumpTo: boolean): void => {
    if (props.disabled) return;
    event.preventDefault();
    setDragging(true);
    // Pressing the track moves the value under the pointer. Pressing the thumb
    // does not: grabbing a knob should not shift what it is holding.
    let latest = jumpTo ? valueAt(event.clientX) : props.value;
    if (jumpTo) emit(latest, false);

    const move = (moved: PointerEvent): void => {
      latest = valueAt(moved.clientX);
      emit(latest, false);
    };
    const up = (): void => {
      stopDrag?.();
      setDragging(false);
      props.onChange(latest);
    };
    stopDrag = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      stopDrag = undefined;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const key = (event: KeyboardEvent): void => {
    if (props.disabled) return;
    const page = Math.max(props.step, (props.max - props.min) / 10);
    const moves: Record<string, number | undefined> = {
      ArrowLeft: -props.step,
      ArrowDown: -props.step,
      ArrowRight: props.step,
      ArrowUp: props.step,
      PageDown: -page,
      PageUp: page,
    };
    let next: number | undefined;
    if (event.key === "Home") next = props.min;
    else if (event.key === "End") next = props.max;
    else {
      const delta = moves[event.key];
      if (delta !== undefined) next = clampToStep(props.value + delta);
    }
    if (next === undefined) return;
    event.preventDefault();
    // A keypress is settled the moment it happens: there is no release to wait
    // for, and holding a key repeats, which the caller can debounce.
    emit(next, true);
  };

  return (
    <div class={`az-slider ${props.disabled ? "az-slider--disabled" : ""} ${props.class ?? ""}`}>
      <Show when={props.showValue !== false && props.formatValue}>
        {(format) => (
          <div class="az-slider__readout">
            <span>{format()(props.value)}</span>
            <Show when={props.trailing}>{props.trailing}</Show>
          </div>
        )}
      </Show>
      {/*
        One handler, and it decides for itself whether the press landed on the
        knob. Two handlers plus `stopPropagation` is the browser way and it does
        not survive here: Solid delegates these events, so the child's
        `stopPropagation` did not stop the parent's, both handlers began a drag,
        and each registered its own release listener. Measured on the live
        window: grabbing the knob moved the value 58 to 56, and three presses
        and a drag cost 11 settings writes instead of 4.

        `stopPropagation` itself is fine in this engine, which was checked
        separately with two plain listeners before blaming it.
      */}
      <div
        ref={track}
        class="az-slider__track"
        onPointerDown={(event) => beginDrag(event, event.target !== thumb)}
      >
        <div class="az-slider__fill" style={{ "--az-slider-fraction": `${fraction()}` }} />
        <div
          ref={thumb}
          class="az-slider__thumb"
          role="slider"
          tabindex={props.disabled ? -1 : 0}
          aria-label={props.label}
          aria-valuemin={props.min}
          aria-valuemax={props.max}
          aria-valuenow={props.value}
          aria-valuetext={props.formatValue?.(props.value)}
          aria-disabled={props.disabled ? "true" : undefined}
          data-dragging={dragging() ? "true" : "false"}
          style={{ "--az-slider-fraction": `${fraction()}` }}
          onKeyDown={key}
        />
      </div>
    </div>
  );
}

export default Slider;
