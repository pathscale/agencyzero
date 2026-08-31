/**
 * What the palette knows about `@pathscale/ui`.
 *
 * `dist/layouts.manifest.json` names 189 components and says nothing else
 * about them: every entry is `{ "kind": "embedded" }`. A properties panel
 * offering "set `variant` to `soft`" has nothing to read there, so this file
 * carries the missing half by hand for a starter set.
 *
 * It is deliberately shaped like the metadata that already exists in the
 * library's own recipes, so a generator can replace it wholesale later:
 * `props` mirrors a recipe's `props` map (axis name to the values it accepts)
 * and `defaults` mirrors its `defaults`. `source` records which recipe each
 * entry was read from, so the generator has something to diff against.
 *
 * Two recipe dialects exist upstream and a generator has to read both:
 * newer components call `recipe({ props, defaults })` (Button, Card, Alert,
 * Skeleton, Spinner), older ones export a `CLASSES` const whose nested keys
 * are the same axes (Flex, Grid, Badge, Input, Select and the rest). The
 * values below were transcribed from whichever of the two each component
 * ships, against @pathscale/ui 2.11.9.
 *
 * One warning for whoever writes that generator: the manifest is not an
 * import list. `Kbd` is in it and is not exported from the package root, so
 * a curated entry for it typechecked as metadata and failed to compile the
 * moment the canvas tried to render it. Generate from the manifest and you
 * will emit imports that do not resolve; cross-check `dist/index.d.ts`.
 */

/** Every value a designed prop can hold. Emitted verbatim, per its kind. */
export type PropValue = string | number | boolean;

/** How the inspector edits a prop and how the emitter prints it. */
export type PropKind =
  | { kind: "enum"; values: readonly string[] }
  | { kind: "string" }
  | { kind: "number"; min?: number; max?: number; step?: number }
  | { kind: "boolean" };

export type PropSpec = {
  name: string;
  type: PropKind;
  /**
   * The component's own default. A node whose value equals this is not
   * emitted: the point of a default is that writing it changes nothing.
   */
  default?: PropValue;
  hint?: string;
};

/** What a component does with what is dropped or typed into it. */
export type ChildPolicy =
  | "none" // self-closing, e.g. Separator
  | "text" // one editable string, e.g. Button
  | "nodes"; // a drop target, e.g. Card.Body

export type CatalogEntry = {
  /** The element name as emitted, and the key `DesignNode.type` holds. */
  name: string;
  /** The named export imported from the package. `Card.Body` imports `Card`. */
  importName: string;
  group: "layout" | "display" | "form";
  summary: string;
  props: readonly PropSpec[];
  children: ChildPolicy;
  /** Starting text for a `text` component, so a fresh drop reads as something. */
  defaultText?: string;
  /** Props written on drop. Kept minimal: a drop should look like the default. */
  initialProps?: Readonly<Record<string, PropValue>>;
  /** Where the metadata above was transcribed from, for a future generator. */
  source: string;
};

const FLAVORS = [
  "neutral",
  "primary",
  "secondary",
  "accent",
  "destructive",
  "success",
  "warning",
  "info",
] as const;

const SIZES = ["xs", "sm", "md", "lg", "xl"] as const;
const SMALL_SIZES = ["sm", "md", "lg"] as const;
const SPACING = ["none", "sm", "md", "lg", "xl"] as const;
const RADII = ["none", "sm", "md", "lg", "full"] as const;

const enumProp = (
  name: string,
  values: readonly string[],
  fallback?: string,
  hint?: string,
): PropSpec => ({ name, type: { kind: "enum", values }, default: fallback, hint });

const stringProp = (name: string, fallback?: string, hint?: string): PropSpec => ({
  name,
  type: { kind: "string" },
  default: fallback,
  hint,
});

const boolProp = (name: string, fallback = false, hint?: string): PropSpec => ({
  name,
  type: { kind: "boolean" },
  default: fallback,
  hint,
});

const numberProp = (
  name: string,
  bounds: { min?: number; max?: number; step?: number },
  fallback?: number,
): PropSpec => ({ name, type: { kind: "number", ...bounds }, default: fallback });

/**
 * The starter set: 22 entries covering layout, display and form.
 *
 * Curated rather than generated on purpose. The generator has to land in
 * `UI/` and `solid-layouts`, outside this package, and waiting for it would
 * mean shipping a designer with an empty properties panel.
 */
export const CATALOG: readonly CatalogEntry[] = [
  // ---------------------------------------------------------------- layout
  {
    name: "Flex",
    importName: "Flex",
    group: "layout",
    summary: "A flex row or column that accepts drops.",
    children: "nodes",
    source: "flex/Flex.recipe.ts",
    initialProps: { direction: "col", gap: "md" },
    props: [
      enumProp("direction", ["row", "col", "row-reverse", "col-reverse"], "row"),
      enumProp("justify", ["start", "center", "end", "between", "around", "evenly"], "start"),
      enumProp("align", ["start", "center", "end", "stretch", "baseline"], "stretch"),
      enumProp("wrap", ["wrap", "nowrap", "wrap-reverse"], "nowrap"),
      enumProp("gap", SPACING, "none"),
      enumProp("paddingInline", SPACING, "none"),
      enumProp("paddingBlock", SPACING, "none"),
      boolProp("grow"),
      boolProp("shrink"),
    ],
  },
  {
    name: "Grid",
    importName: "Grid",
    group: "layout",
    summary: "A column grid that accepts drops.",
    children: "nodes",
    source: "grid/Grid.recipe.ts",
    initialProps: { cols: "2", gap: "md" },
    props: [
      enumProp("cols", ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]),
      enumProp("rows", ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]),
      enumProp("flow", ["row", "col", "row-dense", "col-dense"], "row"),
      enumProp("gap", SPACING, "none"),
    ],
  },
  {
    name: "Card",
    importName: "Card",
    group: "layout",
    summary: "A surface. Drop Card.Header, Card.Body and Card.Footer inside.",
    children: "nodes",
    source: "card/Card.recipe.ts",
    props: [
      enumProp("variant", ["solid", "soft", "outline", "ghost", "plain"], "plain"),
      enumProp("material", ["solid", "glass"], "solid"),
      enumProp("elevation", ["none", "sm", "md", "lg"], "none"),
      enumProp("flavor", ["neutral", "primary", "secondary", "accent"], "neutral"),
      enumProp("padding", ["none", ...SIZES], "md"),
      enumProp("radius", RADII, "lg"),
      boolProp("isInteractive"),
    ],
  },
  {
    name: "Card.Header",
    importName: "Card",
    group: "layout",
    summary: "The card's heading row.",
    children: "nodes",
    source: "card/Card.recipe.ts",
    props: [],
  },
  {
    name: "Card.Body",
    importName: "Card",
    group: "layout",
    summary: "The card's content region.",
    children: "nodes",
    source: "card/Card.recipe.ts",
    props: [],
  },
  {
    name: "Card.Footer",
    importName: "Card",
    group: "layout",
    summary: "The card's action row.",
    children: "nodes",
    source: "card/Card.recipe.ts",
    props: [],
  },
  {
    name: "Separator",
    importName: "Separator",
    group: "layout",
    summary: "A rule between sections.",
    children: "none",
    source: "separator/Separator.recipe.ts",
    props: [
      enumProp("orientation", ["horizontal", "vertical"], "horizontal"),
      enumProp("variant", ["default", "secondary", "tertiary"], "default"),
    ],
  },

  // --------------------------------------------------------------- display
  {
    name: "Text",
    importName: "Text",
    group: "display",
    summary: "A line or paragraph of copy.",
    children: "text",
    defaultText: "Text",
    source: "text/Text.layout.tsx",
    props: [
      enumProp("size", ["xs", "sm", "base", "lg", "xl"], "base"),
      enumProp(
        "variant",
        ["default", "muted", "subtle", "success", "warning", "danger"],
        "default",
      ),
      enumProp("weight", ["normal", "medium", "semibold", "bold"], "normal"),
      enumProp("family", ["body", "heading", "display", "mono"], "body"),
      enumProp("transform", ["none", "uppercase", "lowercase", "capitalize"], "none"),
      enumProp("tracking", ["normal", "wide"], "normal"),
      enumProp("leading", ["normal", "none"], "normal"),
    ],
  },
  {
    name: "Badge",
    importName: "Badge",
    group: "display",
    summary: "A count or status pip.",
    children: "text",
    defaultText: "Badge",
    source: "badge/Badge.recipe.ts",
    props: [
      enumProp("size", SMALL_SIZES, "md"),
      enumProp("flavor", FLAVORS, "neutral"),
      enumProp("variant", ["solid", "soft", "outline"], "solid"),
    ],
  },
  {
    name: "Chip",
    importName: "Chip",
    group: "display",
    summary: "A removable token.",
    children: "text",
    defaultText: "Chip",
    source: "chip/Chip.recipe.ts",
    props: [
      enumProp("variant", ["solid", "flat", "bordered"], "solid"),
      enumProp("flavor", FLAVORS, "neutral"),
      enumProp("size", SMALL_SIZES, "md"),
    ],
  },
  {
    name: "Alert",
    importName: "Alert",
    group: "display",
    summary: "An inline or banner message.",
    children: "text",
    defaultText: "Something happened.",
    source: "alert/Alert.recipe.ts",
    initialProps: { flavor: "info" },
    props: [
      enumProp("flavor", FLAVORS, "neutral"),
      enumProp("variant", ["solid", "soft", "outline", "ghost", "plain"], "soft"),
      enumProp("placement", ["inline", "banner"], "inline"),
      stringProp("title"),
    ],
  },
  {
    name: "Avatar",
    importName: "Avatar",
    group: "display",
    summary: "A person or entity portrait.",
    children: "none",
    source: "avatar/Avatar.recipe.ts",
    props: [
      enumProp("size", SMALL_SIZES, "md"),
      enumProp("variant", ["default", "soft"], "default"),
      enumProp("flavor", FLAVORS, "neutral"),
      stringProp("src", undefined, "Leave empty for the initials fallback."),
      stringProp("alt"),
    ],
  },
  {
    name: "Progress",
    importName: "Progress",
    group: "display",
    summary: "A determinate bar.",
    children: "none",
    source: "progress/Progress.recipe.ts",
    initialProps: { value: 60 },
    props: [
      numberProp("value", { min: 0, max: 100, step: 1 }),
      numberProp("max", { min: 1, step: 1 }, 100),
      enumProp("size", SMALL_SIZES, "md"),
      enumProp("flavor", FLAVORS, "neutral"),
    ],
  },
  {
    name: "Spinner",
    importName: "Spinner",
    group: "display",
    summary: "A busy indicator.",
    children: "none",
    source: "spinner/Spinner.recipe.ts",
    props: [
      enumProp("size", SIZES, "md"),
      enumProp("flavor", ["current", ...FLAVORS], "current"),
      enumProp("shape", ["spinner", "dots", "ring", "ball", "bars", "infinity"], "spinner"),
      stringProp("label", "Loading"),
    ],
  },
  {
    name: "Skeleton",
    importName: "Skeleton",
    group: "display",
    summary: "A loading placeholder.",
    children: "none",
    source: "skeleton/Skeleton.recipe.ts",
    props: [
      enumProp("shape", ["line", "circle", "rect"], "line"),
      enumProp("width", ["auto", "full", "fit", "screen"], "full"),
      enumProp("size", SIZES, "md"),
      enumProp("radius", RADII, "sm"),
      enumProp("animation", ["shimmer", "pulse", "none"], "shimmer"),
    ],
  },
  {
    name: "Link",
    importName: "Link",
    group: "display",
    summary: "An anchor.",
    children: "text",
    defaultText: "Link",
    source: "link/Link.recipe.ts",
    initialProps: { href: "#" },
    props: [
      stringProp("href"),
      enumProp("underline", ["always", "hover", "none"], "hover"),
      boolProp("external"),
    ],
  },

  // ------------------------------------------------------------------ form
  {
    name: "Button",
    importName: "Button",
    group: "form",
    summary: "The call to action.",
    children: "text",
    defaultText: "Button",
    source: "button/Button.recipe.ts",
    props: [
      enumProp("variant", ["solid", "soft", "outline", "ghost", "plain"], "solid"),
      enumProp("flavor", FLAVORS, "primary"),
      enumProp(
        "state",
        ["default", "loading", "error", "invalid", "disabled", "hidden"],
        "default",
      ),
      enumProp("size", SIZES, "sm"),
      enumProp("width", ["auto", "full", "fit", "screen", "square"], "auto"),
      enumProp("radius", RADII, "md"),
    ],
  },
  {
    name: "Input",
    importName: "Input",
    group: "form",
    summary: "A single-line field with its own label and helper.",
    children: "none",
    source: "input/Input.recipe.ts",
    initialProps: { label: "Label", placeholder: "Type here" },
    props: [
      stringProp("label"),
      stringProp("placeholder"),
      stringProp("helperText"),
      enumProp("size", SMALL_SIZES, "md"),
      enumProp("state", ["default", "invalid", "disabled"], "default"),
      boolProp("fullWidth"),
    ],
  },
  {
    name: "Textarea",
    importName: "Textarea",
    group: "form",
    summary: "A multi-line field.",
    children: "none",
    source: "textarea/Textarea.recipe.ts",
    initialProps: { placeholder: "Type here" },
    props: [
      stringProp("placeholder"),
      enumProp("variant", ["primary", "secondary"], "primary"),
      numberProp("rows", { min: 1, max: 24, step: 1 }, 3),
      boolProp("fullWidth"),
    ],
  },
  {
    name: "Checkbox",
    importName: "Checkbox",
    group: "form",
    summary: "A single toggle with a label.",
    children: "text",
    defaultText: "Checkbox",
    source: "checkbox/Checkbox.recipe.ts",
    props: [
      enumProp("variant", ["primary", "secondary"], "primary"),
      boolProp("checked"),
      boolProp("disabled"),
    ],
  },
  {
    name: "Switch",
    importName: "Switch",
    group: "form",
    summary: "An on/off control with a label.",
    children: "text",
    defaultText: "Switch",
    source: "switch/Switch.recipe.ts",
    props: [
      enumProp("flavor", FLAVORS, "neutral"),
      enumProp("size", SMALL_SIZES, "md"),
      boolProp("checked"),
      boolProp("disabled"),
    ],
  },
  {
    name: "Radio",
    importName: "Radio",
    group: "form",
    summary: "One option in a group.",
    children: "text",
    defaultText: "Option",
    source: "radio/Radio.recipe.ts",
    initialProps: { value: "option" },
    props: [stringProp("value"), boolProp("disabled")],
  },
];

const BY_NAME = new Map(CATALOG.map((entry) => [entry.name, entry]));

/** The catalog entry a node's `type` names, or null for an unknown type. */
export function lookup(type: string): CatalogEntry | null {
  return BY_NAME.get(type) ?? null;
}

/** Whether a node of this type can hold dropped children. */
export function acceptsChildren(type: string): boolean {
  return lookup(type)?.children === "nodes";
}

export const CATALOG_GROUPS = ["layout", "display", "form"] as const;
export type CatalogGroup = (typeof CATALOG_GROUPS)[number];

/** The palette's sections, in the order it draws them. */
export function grouped(): { group: CatalogGroup; entries: CatalogEntry[] }[] {
  return CATALOG_GROUPS.map((group) => ({
    group,
    entries: CATALOG.filter((entry) => entry.group === group),
  }));
}
