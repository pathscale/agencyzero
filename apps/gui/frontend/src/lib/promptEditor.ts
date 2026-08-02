import { type Directive, PromptSyntaxParser, type Reference, type Segment } from "promptsyntax";
import type { Agent } from "~/types";

export interface PromptModelOption {
  value: string;
  label: string;
  agent: Agent;
  model: string;
}

export interface CompiledAdvancedPrompt {
  dataPlane: string;
  segments: Segment[];
  model: PromptModelOption | null;
  errors: string[];
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function resolveModel(
  reference: Reference,
  options: PromptModelOption[],
): PromptModelOption | null {
  if (reference.namespace !== null && normalize(reference.namespace) !== "model") return null;
  const name = normalize(reference.name);
  const candidates = options.filter(
    (option) => normalize(option.model) === name || normalize(option.label) === name,
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function references(directive: Directive): Reference[] {
  switch (directive.kind) {
    case "reference":
      return [directive.reference];
    case "route":
      return directive.route.steps.map((step) => step.reference);
    default:
      return [];
  }
}

/**
 * Compile authored Prompt Syntax into the two channels used by the composer.
 *
 * Only model binding is executable today. Other recognized control islands are
 * rejected instead of being silently sent to the model or pretending AgencyZero
 * performed an operation it does not implement.
 */
export function compileAdvancedPrompt(
  source: string,
  options: PromptModelOption[],
): CompiledAdvancedPrompt {
  const entityNames = options.flatMap((option) => [option.model, option.label]);
  const parsed = new PromptSyntaxParser({
    entities: entityNames,
    authoringNamespaces: ["agency"],
  }).parse(source);
  const errors = parsed.diagnostics.map((diagnostic) => diagnostic.message);
  const selected: PromptModelOption[] = [];

  for (const segment of parsed.directives) {
    const directive = segment.directive;
    if (directive.kind === "route" && directive.route.steps.length > 1) {
      errors.push("Fallback model routes are not supported by this composer yet.");
      continue;
    }
    if (directive.kind === "route" && directive.route.terminal === "ask") {
      errors.push("The ask fallback terminal is not supported by this composer yet.");
      continue;
    }
    const refs = references(directive);
    if (refs.length === 0) {
      errors.push(`This Prompt Syntax control is not supported here: ${segment.source}`);
      continue;
    }
    for (const reference of refs) {
      const option = resolveModel(reference, options);
      if (option === null) {
        errors.push(`Unknown or ambiguous model reference: ${segment.source}`);
      } else {
        selected.push(option);
      }
    }
  }

  const unique = [...new Map(selected.map((option) => [option.value, option])).values()];
  if (unique.length > 1) errors.push("A prompt can bind only one model in this composer.");

  return {
    dataPlane: parsed.dataPlane.trim(),
    segments: parsed.segments,
    model: unique.length === 1 ? unique[0] : null,
    errors: [...new Set(errors)],
  };
}
