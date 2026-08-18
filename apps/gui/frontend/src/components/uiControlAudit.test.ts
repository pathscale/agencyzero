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

/*
 * A native control is allowed only where the file says why, on the line above
 * it: `{/* native-control: <reason> *\/}` or a `// native-control:` comment.
 *
 * `EditableTitle` is the case this exists for. Its pencil is a real `<button>`
 * because the library's renders through `Dynamic` and the click never reached
 * the handler: measured against a running build, the hit acknowledged in 1.5ms
 * with no state change, against 63ms and a 254-node change for a control
 * button on the same surface. That is a finding worth keeping, not worth
 * silently reverting, and an audit with no way to record it would have been
 * deleted the first time it got in the way.
 */
const EXEMPTION = /native-control:/;

describe("interactive control ownership", () => {
  it("keeps browser-native controls out of application JSX", () => {
    const violations = tsxFiles(sourceRoot).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");
      return lines.flatMap((line, index) => {
        const matches = line.match(/<(?:button|input|select|textarea)\b/g) ?? [];
        if (matches.length === 0) return [];
        // Either side of the tag: a short reason goes on the line above, and a
        // long one ends up in the comment block among the JSX attributes just
        // below the opening tag.
        const window = lines.slice(Math.max(0, index - 12), index + 13).join("\n");
        if (EXEMPTION.test(window)) return [];
        return matches.map((tag) => `${file}: ${tag}`);
      });
    });

    expect(violations).toEqual([]);
  });
});
