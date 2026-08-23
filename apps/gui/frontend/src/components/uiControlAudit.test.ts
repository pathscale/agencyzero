/*
 * @vitest-environment node
 *
 * This file reads the repository with `node:fs` rather than rendering
 * anything. Under the suite's default jsdom environment those builtins are
 * externalised for the browser and the import fails outright with "No such
 * built-in module: node:". Vitest 4 removed `environmentMatchGlobs`, so the
 * environment is declared per file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("interactive control ownership", () => {
  it("keeps browser-native controls out of application JSX", () => {
    const violations = tsxFiles(sourceRoot).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");
      return lines.flatMap((line) => {
        const matches = line.match(/<(?:button|input|select|textarea)\b/g) ?? [];
        if (matches.length === 0) return [];
        return matches.map((tag) => `${file}: ${tag}`);
      });
    });

    expect(violations).toEqual([]);
  });
});
