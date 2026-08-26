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

// More than a paint check: each used primitive has an outcome that changes its
// value or state and a second outcome that exits or restores it safely.
const inputCoverage: Record<string, readonly [string, string]> = {
  Checkbox: ["toggles-raw-exchange", "toggles-raw-exchange-restores"],
  InlineEdit: ["rename-commits-typed-name", "rename-restores-the-original-name"],
  Input: ["home-search-filters", "home-search-restores"],
  Select: ["select-session-changes", "select-session-restores"],
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

const outcomeIds = new Set<string>();
for (const entry of readdirSync(qaRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".ron")) continue;
  const source = readFileSync(join(qaRoot, entry.name), "utf8");
  for (const match of source.matchAll(/\bid:\s*"([^"]+)"/g)) outcomeIds.add(match[1]);
}

for (const component of [...importedInputs].sort()) {
  const outcomes = inputCoverage[component];
  if (!outcomes) {
    violations.push(`${component}: imported input has no ps-qa coverage contract`);
    continue;
  }
  for (const outcome of outcomes) {
    if (!outcomeIds.has(outcome)) {
      violations.push(`${component}: declared ps-qa outcome ${outcome} does not exist`);
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
