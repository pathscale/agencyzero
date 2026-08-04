/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE = join(process.cwd(), "src");
const USER_FACING_ATTRIBUTES = new Set([
  "title",
  "aria-label",
  "placeholder",
  "label",
  "hint",
  "description",
  "fallback",
]);

function productionTsx(dir = SOURCE): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return productionTsx(path);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    // Hidden, aria-hidden SVG metadata; no person can see or focus it.
    if (entry.name === "IconSprite.tsx") return [];
    return [path];
  });
}

function rawEnglish(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const failures: string[] = [];

  function report(node: ts.Node, kind: string, value: string): void {
    if (!/[A-Za-z]{2}/.test(value)) return;
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    failures.push(
      `${relative(SOURCE, path)}:${line} ${kind}: ${value.replace(/\s+/g, " ").trim()}`,
    );
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) report(node, "text", node.getText(file));
    if (
      ts.isJsxAttribute(node) &&
      USER_FACING_ATTRIBUTES.has(node.name.getText(file)) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      report(node, node.name.getText(file), node.initializer.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(file);
  return failures;
}

describe("English source audit", () => {
  it("routes rendered copy and accessibility labels through the locale catalogue", () => {
    const failures = productionTsx().flatMap(rawEnglish);
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
