import { PromptSyntaxParser } from "promptsyntax";

const promptSyntax = new PromptSyntaxParser({ authoringNamespaces: ["agency"] });

/** The same explicit authoring-line boundary Rust promotes. */
export function isPromptSyntaxDirectiveLine(line: string): boolean {
  if (line.startsWith("    ") || line.startsWith("\t")) return false;
  const trimmed = line.trim();
  if (trimmed.startsWith(">")) return false;
  const parsed = promptSyntax.parse(trimmed);
  if (parsed.segments.length !== 1) return false;
  const [segment] = parsed.segments;
  return (
    segment?.type === "directive" &&
    segment.span.start === 0 &&
    segment.span.end === trimmed.length &&
    segment.directive.kind === "authoring_segment"
  );
}
