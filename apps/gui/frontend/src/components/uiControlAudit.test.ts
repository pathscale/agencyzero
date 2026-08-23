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
 * The exemption exists so a real finding can be recorded rather than silently
 * reverted, and so an audit that got in the way once was not simply deleted.
 *
 * It is deliberately empty now. `EditableTitle` was the case this was written
 * for: its pencil was a native `<button>` because the library's was believed to
 * drop clicks through `Dynamic`. Re-measured against a current build that is no
 * longer true, and the pencil is a library `Button` again. Before adding an
 * exemption, check the claim against a running app rather than inheriting it:
 * the last one outlived the defect it described by several releases and pulled
 * a second component out of the design system with it.
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
