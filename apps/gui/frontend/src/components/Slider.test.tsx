import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { Slider } from "~/components/Slider";

const CSS = readFileSync(join(process.cwd(), "src/styles/theme.css"), "utf8");

/**
 * The library slider was replaced after three rounds of CSS overrides failed to
 * make its browser assumptions survive this renderer. These assert the two
 * things that kept regressing, plus the behaviour those overrides never reached.
 */
describe("Slider", () => {
  function mount(initial = 30, props: Record<string, unknown> = {}) {
    const [value, setValue] = createSignal(initial);
    const onChange = vi.fn((next: number) => setValue(next));
    const onInput = vi.fn();
    render(() => (
      <Slider
        label="Panel depth"
        min={0}
        max={60}
        step={2}
        value={value()}
        onInput={onInput}
        onChange={onChange}
        formatValue={(v) => `${v}%`}
        {...props}
      />
    ));
    return { value, onChange, onInput, thumb: screen.getByRole("slider") };
  }

  /*
   * The defect that survived every CSS round: `transform: translateX(-50%)` is
   * paint-only in blitz, so the thumb painted half a thumb left of the box that
   * received the pointer. Measured on the live window at value 30, it painted
   * across x 868..888 while its hit box sat at 878..897, so pressing the left
   * half of the visible knob missed it, hit the track, and jumped the value.
   */
  it("places the thumb by layout, never by transform", () => {
    const block = CSS.slice(CSS.indexOf(".az-slider__thumb {"));
    expect(block).toContain("left: calc(var(--az-slider-fraction) * (100% - var(--az-slider-thumb)))");
    expect(CSS).not.toContain("translateX(-50%)");
  });

  /*
   * egui: `position_range = rect.x_range().shrink(handle_radius)`. The thumb's
   * centre travels a range inset by half the thumb, so the knob stays on the
   * rail at both ends instead of hanging off it. `fraction * (100% - thumb)` is
   * that inset written as one expression, and the fill has to carry the same
   * inset or it stops short of the knob it is supposed to meet.
   */
  it("insets the travel range by half the thumb, fill included", () => {
    expect(CSS).toContain(
      "width: calc(\n      var(--az-slider-fraction) * (100% - var(--az-slider-thumb)) + var(--az-slider-thumb) / 2\n    )",
    );
  });

  /*
   * The knob must not be painted with `--color-accent-foreground`. This theme
   * derives that from `readableInk(accent)`, the colour for *text on* the
   * accent, which against a light blue accent is near black. That is what made
   * the thumb read as a dark blob welded to the end of the fill.
   */
  it("does not paint the knob with the accent's text colour", () => {
    const block = CSS.slice(CSS.indexOf(".az-slider__thumb {"), CSS.indexOf(".az-slider__thumb["));
    expect(block).not.toContain("accent-foreground");
    // The knob is the accent itself, as in both references: a round knob in the
    // fill colour riding a thin rail.
    expect(block).toContain("background-color: var(--color-primary)");
  });

  /*
   * The rail was `--color-base-300`, one rung from the panel it is drawn on, so
   * the range behind the knob was invisible: the control read as a dot floating
   * in space.
   */
  it("draws a visible rail behind the knob", () => {
    const block = CSS.slice(CSS.indexOf(".az-slider__track {"), CSS.indexOf(".az-slider__fill"));
    expect(block).toContain("color-mix(in oklab, var(--color-base-content) 18%, transparent)");
    expect(block).not.toContain("var(--color-base-300)");
  });

  it("reports its value to assistive technology", () => {
    const { thumb } = mount(30);
    expect(thumb.getAttribute("aria-valuenow")).toBe("30");
    expect(thumb.getAttribute("aria-valuemin")).toBe("0");
    expect(thumb.getAttribute("aria-valuemax")).toBe("60");
    expect(thumb.getAttribute("aria-valuetext")).toBe("30%");
  });

  it("steps with the arrow keys and jumps with Home and End", () => {
    const { thumb, onChange } = mount(30);

    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(32);

    fireEvent.keyDown(thumb, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith(30);

    fireEvent.keyDown(thumb, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(0);

    fireEvent.keyDown(thumb, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith(60);
  });

  it("holds the value still when the knob itself is pressed", () => {
    const { thumb, onChange, onInput } = mount(30);

    // Grabbing a knob must not shift what it is holding. The library moved the
    // value to the pointer on any press, so taking hold of the thumb slightly
    // off centre nudged it before the drag had begun.
    fireEvent.pointerDown(thumb, { clientX: 500 });
    expect(onInput).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores input while disabled", () => {
    const { thumb, onChange } = mount(30, { disabled: true });
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    expect(onChange).not.toHaveBeenCalled();
    expect(thumb.getAttribute("aria-disabled")).toBe("true");
  });

  /*
   * `0.1 * 3` is `0.30000000000000004`, and a value like that would reach the
   * readout, the settings row and the stylesheet.
   */
  it("keeps fractional steps at the step's own precision", () => {
    const [value, setValue] = createSignal(0.2);
    const onChange = vi.fn((next: number) => setValue(next));
    render(() => (
      <Slider
        label="Fraction"
        min={0}
        max={1}
        step={0.1}
        value={value()}
        onChange={onChange}
        formatValue={(v) => `${v}`}
      />
    ));
    const thumb = screen.getAllByRole("slider").at(-1) as HTMLElement;
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith(0.3);
  });
});
