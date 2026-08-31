/**
 * The design document: one tree, edited by pure functions.
 *
 * Everything the designer does is a function from a document to a document,
 * and everything it produces is a function from a document to source text.
 * That split is the whole reason the emitted source is testable without a
 * renderer: `insert(empty, ROOT_ID, 0, button)` then `emit(doc)` is a string
 * comparison, not a screenshot.
 *
 * One IR, two emitters, per the H6 decision. Nothing in this file knows
 * whether the answer is plain TSX or a `.layout.tsx` template; see `emit/`.
 */

import { acceptsChildren, type CatalogEntry, lookup, type PropValue } from "./catalog";

export type DesignNode = {
  id: string;
  /** A catalog entry's `name`, or `ROOT_TYPE` for the artboard itself. */
  type: string;
  /** Only props the user set. A prop left at its default is absent. */
  props: Record<string, PropValue>;
  /** The literal child of a `children: "text"` component. */
  text?: string;
  children: DesignNode[];
};

export type DesignDocument = {
  /** The emitted symbol's name, and the artboard's title. */
  name: string;
  root: DesignNode;
};

/**
 * The artboard is a fragment, not a `<div>`.
 *
 * It means a single dropped Button emits the Button and nothing else, which
 * is what "dragging a Button onto an empty canvas emits exactly the import
 * and the element" has to mean. A wrapper the user did not ask for would be
 * a wrapper they then have to delete in their editor. Containers are dropped
 * in: Flex, Grid, Card. They are not implied.
 */
export const ROOT_TYPE = "Fragment";
export const ROOT_ID = "root";

let counter = 0;

/** A fresh node id. Tests pass their own ids and never call this. */
export function nextNodeId(): string {
  counter += 1;
  return `n${counter}`;
}

/** Reset the id counter. Only for tests that assert on generated ids. */
export function resetNodeIds(): void {
  counter = 0;
}

export function emptyDocument(name = "Untitled"): DesignDocument {
  return { name, root: { id: ROOT_ID, type: ROOT_TYPE, props: {}, children: [] } };
}

/** A node as the palette would drop it: catalog defaults, nothing more. */
export function createNode(entry: CatalogEntry, id: string = nextNodeId()): DesignNode {
  return {
    id,
    type: entry.name,
    props: { ...(entry.initialProps ?? {}) },
    ...(entry.children === "text" ? { text: entry.defaultText ?? entry.name } : {}),
    children: [],
  };
}

/** Whether a node of this type can hold children. The root always can. */
export function canAccept(type: string): boolean {
  return type === ROOT_TYPE || acceptsChildren(type);
}

export function findNode(doc: DesignDocument, id: string): DesignNode | null {
  return find(doc.root, id);
}

function find(node: DesignNode, id: string): DesignNode | null {
  if (node.id === id) return node;
  for (const child of node.children) {
    const hit = find(child, id);
    if (hit) return hit;
  }
  return null;
}

/** The node that holds `id`, or null for the root and for unknown ids. */
export function parentOf(doc: DesignDocument, id: string): DesignNode | null {
  if (id === doc.root.id) return null;
  return findParent(doc.root, id);
}

function findParent(node: DesignNode, id: string): DesignNode | null {
  for (const child of node.children) {
    if (child.id === id) return node;
    const hit = findParent(child, id);
    if (hit) return hit;
  }
  return null;
}

/** `id` and every node beneath it, so a move can refuse to reparent into itself. */
export function subtreeIds(doc: DesignDocument, id: string): Set<string> {
  const start = findNode(doc, id);
  const ids = new Set<string>();
  if (!start) return ids;
  const stack = [start];
  while (stack.length > 0) {
    const node = stack.pop() as DesignNode;
    ids.add(node.id);
    stack.push(...node.children);
  }
  return ids;
}

/** The trail from the root down to `id`, root first, for the breadcrumb. */
export function pathTo(doc: DesignDocument, id: string): DesignNode[] {
  const trail: DesignNode[] = [];
  const walk = (node: DesignNode): boolean => {
    trail.push(node);
    if (node.id === id) return true;
    for (const child of node.children) if (walk(child)) return true;
    trail.pop();
    return false;
  };
  return walk(doc.root) ? trail : [];
}

/**
 * Rewrite one node in place in a fresh tree.
 *
 * Every edit below is expressed through this, so the untouched branches keep
 * their identity and a Solid `<For>` over children does not rebuild the
 * whole canvas because a sibling's prop changed.
 */
function mapNode(
  node: DesignNode,
  id: string,
  change: (node: DesignNode) => DesignNode,
): DesignNode {
  if (node.id === id) return change(node);
  let touched = false;
  const children = node.children.map((child) => {
    const next = mapNode(child, id, change);
    if (next !== child) touched = true;
    return next;
  });
  return touched ? { ...node, children } : node;
}

/**
 * Put `node` into `parentId` at `index`.
 *
 * A parent that does not accept children, or an unknown parent, leaves the
 * document alone rather than throwing: the drag layer resolves drop targets
 * from the same predicate, so a rejection here means a bug upstream, not a
 * user error worth an exception.
 */
export function insert(
  doc: DesignDocument,
  parentId: string,
  index: number,
  node: DesignNode,
): DesignDocument {
  const parent = findNode(doc, parentId);
  if (!parent || !canAccept(parent.type)) return doc;
  const at = clamp(index, 0, parent.children.length);
  return {
    ...doc,
    root: mapNode(doc.root, parentId, (target) => ({
      ...target,
      children: [...target.children.slice(0, at), node, ...target.children.slice(at)],
    })),
  };
}

export function remove(doc: DesignDocument, id: string): DesignDocument {
  if (id === doc.root.id) return doc;
  const parent = parentOf(doc, id);
  if (!parent) return doc;
  return {
    ...doc,
    root: mapNode(doc.root, parent.id, (target) => ({
      ...target,
      children: target.children.filter((child) => child.id !== id),
    })),
  };
}

/**
 * Move `id` into `parentId` at `index`.
 *
 * Refuses to drop a node into its own subtree, the one drag gesture
 * that can destroy a tree, because the moved branch would take its new
 * parent with it. Indexes are resolved *after* the removal, so dragging the
 * first of three children to index 2 lands it last, which is what the drop
 * marker showed.
 */
export function move(
  doc: DesignDocument,
  id: string,
  parentId: string,
  index: number,
): DesignDocument {
  if (id === doc.root.id) return doc;
  const node = findNode(doc, id);
  const parent = findNode(doc, parentId);
  if (!node || !parent || !canAccept(parent.type)) return doc;
  if (subtreeIds(doc, id).has(parentId)) return doc;

  const from = parentOf(doc, id);
  const sameParent = from?.id === parentId;
  const before = sameParent ? from.children.findIndex((child) => child.id === id) : -1;
  const detached = remove(doc, id);
  const target = sameParent && before >= 0 && before < index ? index - 1 : index;
  return insert(detached, parentId, target, node);
}

/**
 * Set or clear one prop.
 *
 * `undefined` deletes it, and so does a value equal to the catalog default:
 * a document that records `variant="solid"` on a Button whose default is
 * already `solid` emits an attribute that changes nothing, and the source
 * pane is the deliverable.
 */
export function setProp(
  doc: DesignDocument,
  id: string,
  name: string,
  value: PropValue | undefined,
): DesignDocument {
  const node = findNode(doc, id);
  if (!node) return doc;
  const spec = lookup(node.type)?.props.find((candidate) => candidate.name === name);
  const clear = value === undefined || (spec?.default !== undefined && value === spec.default);
  return {
    ...doc,
    root: mapNode(doc.root, id, (target) => {
      const props = { ...target.props };
      if (clear) delete props[name];
      else props[name] = value as PropValue;
      return { ...target, props };
    }),
  };
}

export function setText(doc: DesignDocument, id: string, text: string): DesignDocument {
  return { ...doc, root: mapNode(doc.root, id, (target) => ({ ...target, text })) };
}

export function rename(doc: DesignDocument, name: string): DesignDocument {
  return { ...doc, name };
}

/** How the tree panel and the canvas outline label a node. */
export function nodeLabel(node: DesignNode): string {
  if (node.type === ROOT_TYPE) return "Artboard";
  return node.text ? `${node.type} · ${node.text}` : node.type;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
