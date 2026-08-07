import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsTab } from "~/features/analytics/AnalyticsTab";
import type { UsageAnalytics } from "~/types";

const { getUsageAnalytics } = vi.hoisted(() => ({
  getUsageAnalytics: vi.fn<() => Promise<UsageAnalytics>>(),
}));

vi.mock("~/stores/workspace", () => ({
  useWorkspace: () => ({ actions: { getUsageAnalytics } }),
}));

const EMPTY_USAGE: UsageAnalytics = {
  days: [],
  models: [],
  projects: [],
  sessions: [],
  agents: [],
  totalUsd: 0,
  estimatedCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  estimatedCacheWriteTokens: 0,
  totalProcessedTokens: 0,
  largestTurn: null,
  turns: 0,
  reconstructedTurns: 0,
  importedTurns: 0,
};

describe("analytics refresh", () => {
  beforeEach(() => {
    getUsageAnalytics.mockReset();
    getUsageAnalytics.mockResolvedValue(EMPTY_USAGE);
  });

  it("loads on open and refreshes only when the owner asks", async () => {
    const screen = render(() => <AnalyticsTab />);
    await waitFor(() => expect(getUsageAnalytics).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(getUsageAnalytics).toHaveBeenCalledTimes(2));
  });

  it("keeps the headline compact and exposes each report as a tab", async () => {
    const screen = render(() => <AnalyticsTab />);
    await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());

    expect(screen.getAllByRole("tab")).toHaveLength(7);
    expect(screen.getByRole("tab", { name: "Efficiency" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(screen.getByRole("tab", { name: "Models" }));
    expect(screen.getByRole("tab", { name: "Models" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Models");
    expect(screen.getByText("Per model")).toBeInTheDocument();
  });

  it("labels inferred Sol cache writes and uses them in the efficiency ratio", async () => {
    getUsageAnalytics.mockResolvedValue({
      ...EMPTY_USAGE,
      totalCacheReadTokens: 8_192,
      estimatedCacheWriteTokens: 2_048,
    });

    const screen = render(() => <AnalyticsTab />);

    await waitFor(() => expect(screen.getByText("4.0")).toBeInTheDocument());
    expect(screen.getByText("~2.0K")).toBeInTheDocument();
    expect(screen.getByText(/Sol cache writes inferred/)).toBeInTheDocument();
  });
});
