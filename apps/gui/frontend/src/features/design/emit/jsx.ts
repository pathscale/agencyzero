/**
 * Printing a design tree as JSX.
 *
 * Both emitters produce the same element markup and differ only in what they
 * wrap it in, so the markup lives here once. Keeping it separate is also what
 * makes the deliverable testable: the emitted text is a pure function of the
 * document, with no renderer and no DOM anywhere near it.
 */

import { lookup, type PropValue } from "../catalog";
import { type DesignNode, ROOT_TYPE } from "../document";

export const INDENT = "  ";

/** Wrap at this width before an element's attributes go one per line. */
const LINE_BUDGET = 92;

/**
 * A JSX attribute.
 *
 * `title="Save"` for plain strings, `{...}` for everything else. A string
 * containing a double quote takes the expression form rather than an entity:
 * `title={"He said \"no\""}` survives a round trip through a formatter, and
 * `&quot;` inside a JSX attribute reads as a bug even when it is not one.
 */
export function attribute(name: string, value: PropValue): string {
  if (typeof value === "boolean") return value ? name : `${name}={false}`;
  if (typeof value === "number") return `${name}={${value}}`;
  if (value.includes('"')) return `${name}={${JSON.stringify(value)}}`;
  return `${name}="${value}"`;
}

/**
 * A literal text child.
 *
 * JSX takes most text as-is. Braces and angle brackets are syntax, and
 * leading or trailing whitespace is silently trimmed by the parser, so those
 * cases become an explicit string expression instead.
 */
export function textChild(text: string): string {
  const safe = !/[<>{}]/.test(text) && text === text.trim() && text.length > 0;
  return safe ? text : `{${JSON.stringify(text)}}`;
}

/** The props of a node, in catalog order, with unknown props appended. */
function orderedProps(node: DesignNode): [string, PropValue][] {
  const spec = lookup(node.type);
  const order = new Map((spec?.props ?? []).map((prop, index) => [prop.name, index]));
  return Object.entries(node.props).sort(
    ([a], [b]) =>
      (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * One node and its subtree as JSX lines, each already indented by `depth`.
 *
 * Returns lines rather than a blob so a caller can re-indent a whole subtree
 * without re-walking it.
 */
export function printNode(node: DesignNode, depth: number): string[] {
  const pad = INDENT.repeat(depth);
  const entry = lookup(node.type);
  const attrs = orderedProps(node).map(([name, value]) => attribute(name, value));
  const policy = entry?.children ?? "nodes";

  const inner: string[] =
    policy === "text"
      ? node.text
        ? [INDENT.repeat(depth + 1) + textChild(node.text)]
        : []
      : policy === "nodes"
        ? node.children.flatMap((child) => printNode(child, depth + 1))
        : [];

  const selfClosing = inner.length === 0 && policy !== "nodes";
  const openInline = `<${node.type}${attrs.length > 0 ? ` ${attrs.join(" ")}` : ""}`;

  // The whole element on one line, when it fits and its only child is text.
  if (attrs.length > 0 && pad.length + openInline.length + 3 > LINE_BUDGET) {
    const lines = [`${pad}<${node.type}`];
    for (const attr of attrs) lines.push(INDENT.repeat(depth + 1) + attr);
    if (selfClosing) {
      lines.push(`${pad}/>`);
      return lines;
    }
    lines.push(`${pad}>`);
    lines.push(...inner);
    lines.push(`${pad}</${node.type}>`);
    return lines;
  }

  if (selfClosing) return [`${pad}${openInline} />`];
  if (inner.length === 0) return [`${pad}${openInline}></${node.type}>`];

  if (policy === "text" && inner.length === 1) {
    const single = `${pad}${openInline}>${inner[0].trim()}</${node.type}>`;
    if (single.length <= LINE_BUDGET) return [single];
  }

  return [`${pad}${openInline}>`, ...inner, `${pad}</${node.type}>`];
}

/**
 * The artboard's children as the body of a `return`, indented under `depth`.
 *
 * Empty is `null` rather than an empty fragment: a component that renders
 * nothing should say so. One child returns bare, with no fragment and no wrapper,
 * which is the rule that makes a single dropped Button emit only a Button.
 */
export function printBody(root: DesignNode, depth: number): string[] {
  if (root.type !== ROOT_TYPE) return printNode(root, depth);
  if (root.children.length === 0) return [`${INDENT.repeat(depth)}null`];
  if (root.children.length === 1) return printNode(root.children[0], depth);
  const pad = INDENT.repeat(depth);
  return [
    `${pad}<>`,
    ...root.children.flatMap((child) => printNode(child, depth + 1)),
    `${pad}</>`,
  ];
}

/** Every `@pathscale/ui` export the tree needs, deduplicated and sorted. */
export function collectImports(root: DesignNode): string[] {
  const names = new Set<string>();
  const walk = (node: DesignNode): void => {
    const entry = lookup(node.type);
    if (entry) names.add(entry.importName);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return [...names].sort((a, b) => a.localeCompare(b));
}
