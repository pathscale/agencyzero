/**
 * Where a drag lands.
 *
 * The canvas renders into the app's own document, which is the H6 decision, so a
 * hit test is an ordinary `elementFromPoint` walk and no bridge is involved.
 * That is the reason this file can be pure: the only thing the DOM
 * contributes is "which node id is under the pointer, and what is its
 * rectangle", and everything after that is arithmetic over the document.
 *
 * The gesture itself is built on pointer events rather than HTML5 drag and
 * drop. Blitz's `dragstart`/`dragover`/`drop` support is not something to
 * rest a core interaction on, and pointer capture gives the same gesture
 * with behaviour we own end to end.
 */

import type { CatalogEntry } from "./catalog";
import {
  canAccept,
  createNode,
  type DesignDocument,
  type DesignNode,
  findNode,
  insert,
  move,
  parentOf,
  ROOT_ID,
  subtreeIds,
} from "./document";

export type Rect = { top: number; left: number; width: number; height: number };
export type Point = { x: number; y: number };

/** The node under the pointer, as the canvas measured it. */
export type Hit = { id: string; rect: Rect };

export type DragSource =
  | { kind: "palette"; entry: CatalogEntry }
  | { kind: "node"; nodeId: string };

export type DropPlan = {
  parentId: string;
  index: number;
  /** What the drop marker draws, and where. */
  kind: "into" | "before" | "after";
  relativeTo: string;
};

/**
 * The band at each end of a container that means "beside me", not "inside me".
 *
 * A quarter of the box, clamped so that a 12px-tall Separator still has a
 * usable middle and a 900px-tall Card does not claim 220px of dead zone at
 * each end.
 */
function edgeBand(extent: number): number {
  return Math.min(14, Math.max(4, extent * 0.25));
}

/** Containers laid out in a row want a left/right marker, not top/bottom. */
function isHorizontal(node: DesignNode | null): boolean {
  if (!node) return false;
  if (node.type === "Grid") return true;
  if (node.type !== "Flex") return false;
  const direction = node.props.direction;
  return direction === "row" || direction === "row-reverse";
}

/**
 * Resolve a pointer position over a hit node into an insertion point.
 *
 * Returns null when the drag cannot land. Dropping a node inside itself is
 * the case that matters, because it would take the branch's new parent with
 * it and lose the subtree.
 */
export function resolveDrop(
  document: DesignDocument,
  hit: Hit | null,
  point: Point,
  source: DragSource,
): DropPlan | null {
  const rootEnd: DropPlan = {
    parentId: ROOT_ID,
    index: document.root.children.length,
    kind: "into",
    relativeTo: ROOT_ID,
  };

  if (!hit) return rootEnd;
  if (hit.id === ROOT_ID) return rootEnd;

  const node = findNode(document, hit.id);
  if (!node) return rootEnd;

  if (source.kind === "node") {
    if (subtreeIds(document, source.nodeId).has(hit.id)) return null;
  }

  const parent = parentOf(document, hit.id);
  const horizontal = isHorizontal(parent);
  const start = horizontal ? hit.rect.left : hit.rect.top;
  const extent = horizontal ? hit.rect.width : hit.rect.height;
  const position = (horizontal ? point.x : point.y) - start;
  const band = edgeBand(extent);

  if (canAccept(node.type) && position > band && position < extent - band) {
    return { parentId: node.id, index: node.children.length, kind: "into", relativeTo: node.id };
  }

  if (!parent) return rootEnd;
  const index = parent.children.findIndex((child) => child.id === hit.id);
  const after = position >= extent / 2;
  return {
    parentId: parent.id,
    index: after ? index + 1 : index,
    kind: after ? "after" : "before",
    relativeTo: hit.id,
  };
}

/**
 * Carry out a resolved drop.
 *
 * Returns the node that should now be selected, because both gestures end
 * with the user looking at one thing: a dropped component, or the one they
 * just moved.
 */
export function applyDrop(
  document: DesignDocument,
  source: DragSource,
  plan: DropPlan,
): { document: DesignDocument; selectedId: string } {
  if (source.kind === "palette") {
    const node = createNode(source.entry);
    return { document: insert(document, plan.parentId, plan.index, node), selectedId: node.id };
  }
  return {
    document: move(document, source.nodeId, plan.parentId, plan.index),
    selectedId: source.nodeId,
  };
}

/**
 * Append to the end of the artboard.
 *
 * The palette's click-to-add path and the keyboard path both use this, so
 * the designer is usable without a pointer at all, which is also what makes
 * it drivable by ps-qa through the accessibility tree.
 */
export function appendToRoot(
  document: DesignDocument,
  entry: CatalogEntry,
): { document: DesignDocument; selectedId: string } {
  return applyDrop(
    document,
    { kind: "palette", entry },
    {
      parentId: ROOT_ID,
      index: document.root.children.length,
      kind: "into",
      relativeTo: ROOT_ID,
    },
  );
}
