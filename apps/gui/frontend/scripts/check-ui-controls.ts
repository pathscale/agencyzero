import ts from "typescript";

const sourceRoot = `${import.meta.dir}/../src`;
const qaRoot = `${import.meta.dir}/../../../../tests/ps-qa`;

/**
 * Components whose rendered output contains the control QA addresses.
 *
 * Compound roots such as Select and Tabs derive IDs for their trigger/tab
 * children from this base. Requiring the base at the call site keeps product
 * identity out of framework creation order while letting the component own
 * its internal suffixes.
 */
const alwaysIdOwnedControls = new Set([
  "Button",
  "LanguageSwitcher",
  "PillMenu",
  "button",
  "input",
  "select",
  "textarea",
]);
const uiIdOwnedControls = new Set([
  "Checkbox",
  "ComplexColorWheel",
  "InlineEdit",
  "Input.Field",
  "Select",
  "Slider",
  "Switch",
  "Tabs.Root",
  "Textarea",
]);

// Every value-bearing @pathscale/ui primitive. Keep this list broader than the
// imports below: adding one of these to AgencyZero must also add real rendered
// outcomes, or this check fails before the component reaches a pull request.
const inputComponents = new Set([
  "Checkbox",
  // Reached through `~/components/PillMenu`, not imported here directly, which
  // is exactly why it went uncovered: the composer's Model, Effort and
  // Permission pills are all Dropdown, and nothing gated any of them.
  "Dropdown",
  "DateField",
  "DatePicker",
  "DateRangePicker",
  "Form",
  "InlineEdit",
  "Input",
  "RadioGroup",
  "Select",
  "Slider",
  "Switch",
  "Textarea",
  "TimeField",
]);

// More than a paint check: each used primitive has explicit outcomes for its
// meaningful state change and every required exit or restore path.
const inputCoverage: Record<string, readonly string[]> = {
  Checkbox: ["toggles-raw-exchange", "toggles-raw-exchange-restores"],
  Dropdown: [
    "pillmenu-effort-opens",
    "pillmenu-effort-selects-low",
    "pillmenu-effort-selects-high-by-pointer",
  ],
  InlineEdit: [
    "rename-commits-typed-name",
    "rename-escape-keeps-name",
    "rename-closes-on-pointer-away",
    "rename-closes-on-project-switch",
    "rename-restores-the-original-name",
  ],
  Input: ["home-search-filters", "home-search-restores"],
  Select: ["select-session-displays", "select-session-changes", "select-session-restores"],
  Slider: ["verbosity-slider-changes", "verbosity-slider-restores"],
  Switch: ["theme-glass-toggle", "theme-glass-restores"],
  Textarea: ["notes-draft-enables-save", "notes-forget-clears"],
};

const tsxFiles = Array.from(
  new Bun.Glob("**/*.tsx").scanSync({ cwd: sourceRoot, absolute: true, onlyFiles: true }),
);
const sources = new Map<string, string>();
for (const file of tsxFiles) sources.set(file, await Bun.file(file).text());

const violations = [...sources].flatMap(([file, source]) =>
  source.split("\n").flatMap((line, index) => {
    const matches = line.match(/<(?:button|input|select|textarea)\b/g) ?? [];
    return matches.map((tag) => `${file}:${index + 1}: ${tag}`);
  }),
);

const literalIds = new Map<string, string>();
for (const [file, source] of sources) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const uiImports = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    if (!statement.moduleSpecifier.text.startsWith("@pathscale/ui")) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const imported of bindings.elements) uiImports.add(imported.name.text);
  }

  const visit = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile);
      const rootTag = tag.split(".")[0];
      const ownsId =
        alwaysIdOwnedControls.has(tag) || (uiIdOwnedControls.has(tag) && uiImports.has(rootTag));
      if (ownsId) {
        const id = node.attributes.properties.find(
          (attribute): attribute is ts.JsxAttribute =>
            ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === "id",
        );
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        if (!id) {
          violations.push(`${file}:${line}: <${tag}> has no stable id`);
        } else if (id.initializer && ts.isStringLiteral(id.initializer)) {
          const prior = literalIds.get(id.initializer.text);
          if (prior) {
            violations.push(
              `${file}:${line}: duplicate literal id "${id.initializer.text}" (first at ${prior})`,
            );
          } else {
            literalIds.set(id.initializer.text, `${file}:${line}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

const importedInputs = new Set<string>();
for (const source of sources.values()) {
  for (const match of source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*["']@pathscale\/ui["']/g)) {
    for (const imported of match[1].split(",")) {
      const name = imported
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0];
      if (inputComponents.has(name)) importedInputs.add(name);
    }
  }
}

const outcomeContracts = new Map<string, string>();
for (const path of new Bun.Glob("*.ron").scanSync({
  cwd: qaRoot,
  absolute: true,
  onlyFiles: true,
})) {
  const source = await Bun.file(path).text();
  const matches = [...source.matchAll(/\bid:\s*"([^"]+)"/g)];
  for (const [index, match] of matches.entries()) {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? source.length;
    outcomeContracts.set(match[1], source.slice(start, end));
  }
}

for (const component of [...importedInputs].sort()) {
  const outcomes = inputCoverage[component];
  if (!outcomes) {
    violations.push(`${component}: imported input has no ps-qa coverage contract`);
    continue;
  }
  for (const outcome of outcomes) {
    const contract = outcomeContracts.get(outcome);
    if (!contract) {
      violations.push(`${component}: declared ps-qa outcome ${outcome} does not exist`);
      continue;
    }
    if (
      !/(?:prepare|click|type_into|key|key_on|hover|after_prepare_hover):\s*Some/.test(contract)
    ) {
      violations.push(
        `${component}: declared ps-qa outcome ${outcome} only observes paint and drives no control`,
      );
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`UI control contract violations:\n${violations.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(
  `UI control ownership: application JSX uses @pathscale/ui; ${importedInputs.size} imported input primitives have paired ps-qa outcomes; no raw interactive controls\n`,
);
