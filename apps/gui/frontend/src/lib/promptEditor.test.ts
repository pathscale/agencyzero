import { describe, expect, test } from "vitest";
import { compileAdvancedPrompt, type PromptModelOption } from "~/lib/promptEditor";

const models: PromptModelOption[] = [
  { value: "claude:sonnet", label: "Sonnet", agent: "claude", model: "sonnet" },
  {
    value: "codex:gpt-5.6-sol",
    label: "Sol",
    agent: "codex",
    model: "gpt-5.6-sol",
  },
];

describe("compileAdvancedPrompt", () => {
  test("separates a model island from the data plane", () => {
    const result = compileAdvancedPrompt("@model:gpt-5.6-sol Fix the test", models);
    expect(result.errors).toEqual([]);
    expect(result.model?.value).toBe("codex:gpt-5.6-sol");
    expect(result.dataPlane).toBe("Fix the test");
    expect(result.segments[0]?.type).toBe("directive");
  });

  test("supports a selected model as a bare entity", () => {
    const result = compileAdvancedPrompt("@sonnet! Review this", models);
    expect(result.errors).toEqual([]);
    expect(result.model?.value).toBe("claude:sonnet");
    expect(result.dataPlane).toBe("Review this");
  });

  test("rejects a fallback route the composer cannot execute", () => {
    const result = compileAdvancedPrompt("@sonnet else @gpt-5.6-sol Review this", models);
    expect(result.errors).toContain(
      "Fallback model routes are not supported by this composer yet.",
    );
  });

  test("keeps unknown bare references inert", () => {
    const result = compileAdvancedPrompt("Email @someone about this", models);
    expect(result.errors).toEqual([]);
    expect(result.dataPlane).toBe("Email @someone about this");
  });

  test("rejects an unresolved qualified control island", () => {
    const result = compileAdvancedPrompt("@model:missing Do this", models);
    expect(result.errors).toEqual(["Unknown or ambiguous model reference: @model:missing"]);
    expect(result.dataPlane).toBe("Do this");
  });
});
