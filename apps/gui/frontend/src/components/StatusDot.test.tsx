import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { StatusDot } from "~/components/StatusDot";
import type { TabStatus } from "~/types";

describe("tab status colours", () => {
  const expected: Record<TabStatus, string> = {
    ready: "bg-success",
    running: "bg-warning",
    blocked: "bg-error",
    error: "bg-error",
    quiet: "bg-white/25",
  };

  for (const [status, colour] of Object.entries(expected) as [TabStatus, string][]) {
    it(`${status} uses ${colour}`, () => {
      const { container } = render(() => <StatusDot status={status} />);
      expect(container.firstElementChild?.className).toContain(colour);
    });
  }
});
