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
  totalProcessedTokens: 0,
  largestTurn: null,
  turns: 0,
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
});
