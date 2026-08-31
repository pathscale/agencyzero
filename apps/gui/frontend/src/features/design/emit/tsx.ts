/**
 * The plain Solid emitter.
 *
 * Output is a component importing straight from `@pathscale/ui`, pasteable
 * into any Solid app with no build step and no toolchain opinion. It is the
 * emitter you reach for when the answer to "what do I do with this?" is
 * "put it in my file".
 */

import type { DesignDocument } from "../document";
import { collectImports, INDENT, printBody } from "./jsx";
import { pascalCase } from "./names";
import type { EmittedFile, Emitter } from "./types";

const PACKAGE = "@pathscale/ui";

function emit(document: DesignDocument): EmittedFile[] {
  const name = pascalCase(document.name);
  const imports = collectImports(document.root);
  const body = printBody(document.root, 1);

  const lines: string[] = [];
  if (imports.length > 0) {
    lines.push(`import { ${imports.join(", ")} } from "${PACKAGE}";`, "");
  }
  lines.push(`export function ${name}() {`);

  // A single-line body returns inline. Wrapping one short element in
  // parentheses over three lines is noise a formatter would undo anyway.
  if (body.length === 1) {
    lines.push(`${INDENT}return ${body[0].trim()};`);
  } else {
    lines.push(`${INDENT}return (`);
    for (const line of body) lines.push(INDENT + line);
    lines.push(`${INDENT});`);
  }
  lines.push("}", "");

  return [{ path: `${name}.tsx`, language: "tsx", source: lines.join("\n") }];
}

export const tsxEmitter: Emitter = {
  id: "tsx",
  label: "Solid TSX",
  summary: "A component importing from @pathscale/ui. Runs as-is.",
  emit,
};
