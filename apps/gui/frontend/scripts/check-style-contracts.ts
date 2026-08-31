const sourceRoot = `${import.meta.dir}/../src`;
const sourceFiles = Array.from(
  new Bun.Glob("**/*.{css,html,ts,tsx}").scanSync({
    cwd: sourceRoot,
    absolute: true,
    onlyFiles: true,
  }),
);

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
for (const file of sourceFiles) {
  const source = await Bun.file(file).text();
  for (const { label, pattern } of forbidden) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split("\n").length;
      violations.push(`${file.slice(sourceRoot.length + 1)}:${line}: ${label}: ${match[0]}`);
    }
  }
}

const theme = await Bun.file(`${sourceRoot}/styles/theme.css`).text();
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
