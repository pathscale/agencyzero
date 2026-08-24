import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const sourceRoot = join(import.meta.dir, "..", "src");
const nativeSelectOwner = join(sourceRoot, "features", "settings", "SettingsTab.tsx");

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

if (violations.length > 0) {
  process.stderr.write(
    `Application JSX must use @pathscale/ui controls:\n${violations.join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write(
  "UI control ownership: application JSX uses @pathscale/ui; moderator model uses the one native semantic select\n",
);
