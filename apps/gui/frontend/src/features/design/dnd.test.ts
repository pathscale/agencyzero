import { describe, expect, it } from "vitest";
import { lookup } from "./catalog";
import { applyDrop, type DragSource, type Hit, resolveDrop } from "./dnd";
import { createNode, emptyDocument, findNode, insert, ROOT_ID } from "./document";

function entry(name: string) {
  const found = lookup(name);
  if (!found) throw new Error(`no catalog entry named ${name}`);
  return found;
}

/** A Flex at the artboard's top, holding one Button. */
function scene() {
  let document = insert(emptyDocument(), ROOT_ID, 0, createNode(entry("Flex"), "f1"));
  document = insert(document, "f1", 0, createNode(entry("Button"), "b1"));
  return document;
}

/** A 200x100 box at the origin, which puts its edge bands at 14px. */
const box: Hit = { id: "f1", rect: { top: 0, left: 0, width: 200, height: 100 } };
const button: Hit = { id: "b1", rect: { top: 20, left: 20, width: 80, height: 30 } };

const fromPalette: DragSource = { kind: "palette", entry: entry("Badge") };

describe("resolveDrop", () => {
  it("drops into a container when the pointer is past its edge band", () => {
    const plan = resolveDrop(scene(), box, { x: 100, y: 50 }, fromPalette);

    expect(plan).toEqual({ parentId: "f1", index: 1, kind: "into", relativeTo: "f1" });
  });

  it("drops before a sibling when the pointer is in its top half", () => {
    const plan = resolveDrop(scene(), button, { x: 60, y: 25 }, fromPalette);

    expect(plan).toEqual({ parentId: "f1", index: 0, kind: "before", relativeTo: "b1" });
  });

  it("drops after a sibling when the pointer is in its bottom half", () => {
    const plan = resolveDrop(scene(), button, { x: 60, y: 45 }, fromPalette);

    expect(plan).toEqual({ parentId: "f1", index: 1, kind: "after", relativeTo: "b1" });
  });

  it("uses the x axis inside a row, because that is where the marker goes", () => {
    let document = scene();
    document = { ...document, root: { ...document.root } };
    const row = findNode(document, "f1");
    if (row) row.props = { ...row.props, direction: "row" };

    const plan = resolveDrop(document, button, { x: 30, y: 45 }, fromPalette);

    expect(plan?.kind).toBe("before");
  });

  it("appends to the artboard when the pointer is over nothing", () => {
    const plan = resolveDrop(scene(), null, { x: 0, y: 0 }, fromPalette);

    expect(plan).toEqual({ parentId: ROOT_ID, index: 1, kind: "into", relativeTo: ROOT_ID });
  });

  it("refuses to land a node inside itself", () => {
    const plan = resolveDrop(scene(), box, { x: 100, y: 50 }, { kind: "node", nodeId: "f1" });

    expect(plan).toBeNull();
  });
});

describe("applyDrop", () => {
  it("creates the dropped component and selects it", () => {
    const result = applyDrop(scene(), fromPalette, {
      parentId: "f1",
      index: 0,
      kind: "into",
      relativeTo: "f1",
    });

    expect(findNode(result.document, "f1")?.children[0].type).toBe("Badge");
    expect(result.selectedId).toBe(findNode(result.document, "f1")?.children[0].id);
  });

  it("keeps the moved node selected", () => {
    const result = applyDrop(
      scene(),
      { kind: "node", nodeId: "b1" },
      { parentId: ROOT_ID, index: 0, kind: "before", relativeTo: "f1" },
    );

    expect(result.selectedId).toBe("b1");
    expect(result.document.root.children.map((child) => child.id)).toEqual(["b1", "f1"]);
  });
});
