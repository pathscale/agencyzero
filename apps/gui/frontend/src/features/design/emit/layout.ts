/**
 * The solid-layouts emitter.
 *
 * Output is an authored `*.layout.tsx` template plus the `*.recipe.ts` it
 * refers to: the pair `solid-layouts-library` discovers and compiles. The
 * model is the one chuzz already runs: `apps/chuzz/frontend/local-ui`
 * authors these pairs, `bun run layouts:local` compiles the directory into
 * `@chuzz/ui`, and application code imports the compiled package and never
 * the source. A designer that emits into that shape drops a folder into a
 * private library and the existing pipeline picks it up.
 *
 * One structural difference from the TSX emitter, and it is not cosmetic:
 * a layout template has exactly one root element, because `slot.root` has to
 * land on something. So this emitter always wraps, where the TSX emitter
 * returns a lone dropped Button bare. Both are correct for their target.
 */

import type { DesignDocument } from "../document";
import { collectImports, INDENT, printBody } from "./jsx";
import { camelCase, kebabCase, pascalCase } from "./names";
import type { EmittedFile, Emitter } from "./types";

const PACKAGE = "@pathscale/ui";
const TOOLCHAIN = "solid-layouts";

function template(document: DesignDocument): EmittedFile {
  const name = pascalCase(document.name);
  const recipeConst = camelCase(document.name);
  const imports = collectImports(document.root);
  const body = printBody(document.root, 2);

  const lines: string[] = [];
  if (imports.length > 0) lines.push(`import { ${imports.join(", ")} } from "${PACKAGE}";`);
  lines.push(`import type { Layout } from "${TOOLCHAIN}";`);
  lines.push(`import { ${recipeConst} } from "./${name}.recipe";`);
  lines.push("");
  // No designed props yet: the artboard has no parameters to expose. The
  // named type still exists so a hand edit has somewhere obvious to go.
  lines.push(`export type ${name}Props = Record<string, never>;`);
  lines.push("");
  lines.push(`const ${name}: Layout<typeof ${recipeConst}, ${name}Props> = () => (`);
  lines.push(`${INDENT}<div {...slot.root}>`);
  for (const line of body) lines.push(line);
  lines.push(`${INDENT}</div>`);
  lines.push(");");
  lines.push("");
  lines.push(`export const ${name}Layout = ${name};`);
  lines.push(`export default ${name};`);
  lines.push("");

  return { path: `${name}.layout.tsx`, language: "tsx", source: lines.join("\n") };
}

function recipe(document: DesignDocument): EmittedFile {
  const name = pascalCase(document.name);
  const recipeConst = camelCase(document.name);
  const component = kebabCase(document.name);

  const source = [
    `import { recipe } from "${TOOLCHAIN}";`,
    "",
    `export const ${recipeConst} = recipe({`,
    `${INDENT}component: "${component}",`,
    `${INDENT}element: "div",`,
    `${INDENT}slots: { root: { base: "${component}" } },`,
    "});",
    "",
  ].join("\n");

  return { path: `${name}.recipe.ts`, language: "ts", source };
}

export const layoutEmitter: Emitter = {
  id: "layout",
  label: "solid-layouts template",
  summary: "A .layout.tsx and .recipe.ts pair. Compile with solid-layouts-library.",
  emit: (document) => [template(document), recipe(document)],
};
