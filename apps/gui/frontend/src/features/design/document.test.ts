import { describe, expect, it } from "vitest";
import { lookup } from "./catalog";
import {
  createNode,
  emptyDocument,
  findNode,
  insert,
  move,
  pathTo,
  ROOT_ID,
  remove,
  setProp,
  subtreeIds,
} from "./document";

function entry(name: string) {
  const found = lookup(name);
  if (!found) throw new Error(`no catalog entry named ${name}`);
  return found;
}

/** A Flex holding two Buttons, so ordering and reparenting have somewhere to go. */
function nested() {
  let document = insert(emptyDocument(), ROOT_ID, 0, createNode(entry("Flex"), "f1"));
  document = insert(document, "f1", 0, createNode(entry("Button"), "b1"));
  document = insert(document, "f1", 1, createNode(entry("Button"), "b2"));
  return document;
}

describe("insert", () => {
  it("refuses a parent that does not accept children", () => {
    const document = insert(emptyDocument(), ROOT_ID, 0, createNode(entry("Button"), "b1"));
    const after = insert(document, "b1", 0, createNode(entry("Badge"), "g1"));

    expect(after).toBe(document);
  });

  it("clamps an index past the end rather than leaving a hole", () => {
    const document = insert(emptyDocument(), ROOT_ID, 9, createNode(entry("Button"), "b1"));

    expect(document.root.children.map((child) => child.id)).toEqual(["b1"]);
  });

  it("keeps untouched branches identical, so the canvas does not rebuild them", () => {
    const before = nested();
    const after = insert(before, ROOT_ID, 1, createNode(entry("Badge"), "g1"));

    expect(after.root.children[0]).toBe(before.root.children[0]);
  });
});

describe("move", () => {
  it("reorders within one parent using the index the marker showed", () => {
    const after = move(nested(), "b1", "f1", 2);

    expect(findNode(after, "f1")?.children.map((child) => child.id)).toEqual(["b2", "b1"]);
  });

  it("reparents out of a container", () => {
    const after = move(nested(), "b1", ROOT_ID, 0);

    expect(after.root.children.map((child) => child.id)).toEqual(["b1", "f1"]);
    expect(findNode(after, "f1")?.children.map((child) => child.id)).toEqual(["b2"]);
  });

  it("refuses to drop a node into its own subtree", () => {
    let document = nested();
    document = insert(document, "f1", 2, createNode(entry("Flex"), "f2"));
    const after = move(document, "f1", "f2", 0);

    expect(after).toBe(document);
  });
});

describe("setProp", () => {
  it("stores a value that differs from the catalog default", () => {
    const after = setProp(nested(), "b1", "flavor", "success");

    expect(findNode(after, "b1")?.props.flavor).toBe("success");
  });

  it("clears a value equal to the catalog default", () => {
    let after = setProp(nested(), "b1", "flavor", "success");
    after = setProp(after, "b1", "flavor", "primary");

    expect(findNode(after, "b1")?.props).not.toHaveProperty("flavor");
  });

  it("clears on undefined", () => {
    let after = setProp(nested(), "b1", "size", "lg");
    after = setProp(after, "b1", "size", undefined);

    expect(findNode(after, "b1")?.props).not.toHaveProperty("size");
  });
});

describe("navigation", () => {
  it("walks the trail from the artboard down to the node", () => {
    expect(pathTo(nested(), "b2").map((node) => node.id)).toEqual([ROOT_ID, "f1", "b2"]);
  });

  it("collects a node and everything under it", () => {
    expect([...subtreeIds(nested(), "f1")].sort()).toEqual(["b1", "b2", "f1"]);
  });

  it("never removes the artboard itself", () => {
    const document = nested();

    expect(remove(document, ROOT_ID)).toBe(document);
  });
});
