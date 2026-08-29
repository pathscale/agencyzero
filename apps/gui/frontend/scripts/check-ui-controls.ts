import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const sourceRoot = join(import.meta.dir, "..", "src");
const repositoryRoot = join(import.meta.dir, "..", "..", "..", "..");
const qaRoot = join(repositoryRoot, "tests", "ps-qa");
const nativeSelectOwner = join(sourceRoot, "features", "settings", "SettingsTab.tsx");

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
    "pillmenu-effort-leaves-fixture-value",
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

function tsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

const violations = tsxFiles(sourceRoot).flatMap((file) => {
  const source = readFileSync(file, "utf8");
  return source.split("\n").flatMap((line, index) => {
    const matches = line.match(/<(?:button|input|select|textarea)\b/g) ?? [];
    return matches
      .filter((tag) => tag !== "<select" || file !== nativeSelectOwner)
      .map((tag) => `${file}:${index + 1}: ${tag}`);
  });
});

const importedInputs = new Set<string>();
for (const file of tsxFiles(sourceRoot)) {
  const source = readFileSync(file, "utf8");
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
for (const entry of readdirSync(qaRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".ron")) continue;
  const source = readFileSync(join(qaRoot, entry.name), "utf8");
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
  `UI control ownership: application JSX uses @pathscale/ui; ${importedInputs.size} imported input primitives have paired ps-qa outcomes; moderator model uses the one native semantic select\n`,
);
