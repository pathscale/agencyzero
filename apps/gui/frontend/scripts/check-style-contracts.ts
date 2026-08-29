import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const sourceRoot = join(import.meta.dir, "..", "src");
const sourceExtensions = new Set([".css", ".html", ".ts", ".tsx"]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return sourceExtensions.has(extname(entry.name)) ? [path] : [];
  });
}

const forbidden = [
  {
    label: "arbitrary font utility; use a named --text-* theme token",
    pattern: /text-\[[^\]]*\d(?:\.\d+)?(?:px|r?em|%)\]/g,
  },
  {
    label: "numeric font declaration; use a named --text-* theme token",
    pattern: /font-size\s*:\s*[^;}\n]*\d(?:\.\d+)?(?:px|r?em|%)\b/g,
  },
  {
    label: "numeric inline font size; use a named --text-* theme token",
    pattern: /fontSize\s*[:=]\s*["'`][^"'`\n]*\d(?:\.\d+)?(?:px|r?em|%)\b/g,
  },
] as const;

const violations: string[] = [];
for (const file of sourceFiles(sourceRoot)) {
  const source = readFileSync(file, "utf8");
  for (const { label, pattern } of forbidden) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(`${relative(sourceRoot, file)}:${line}: ${label}: ${match[0]}`);
    }
  }
}

const theme = readFileSync(join(sourceRoot, "styles", "theme.css"), "utf8");
const typography = [...theme.matchAll(/--text-ui-[a-z-]+:\s*([^;]+);/g)];
if (typography.length === 0) {
  violations.push("styles/theme.css: typography ladder declares no --text-ui-* tokens");
}
for (const token of typography) {
  if (!/^\d+(?:\.\d+)?rem$/.test(token[1].trim())) {
    violations.push(`styles/theme.css: ${token[0]} must be a rem value`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`Style contract violations:\n${violations.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write("Style contracts: typography uses named rem theme tokens\n");
