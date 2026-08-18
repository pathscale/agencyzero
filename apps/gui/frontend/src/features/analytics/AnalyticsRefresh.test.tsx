import { flush } from "solid-js";
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
  items: [],
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
    // The first load resolves into a signal, so land it before querying for
    // the controls that only render once the panel has data.
    flush();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    flush();
    await waitFor(() => expect(getUsageAnalytics).toHaveBeenCalledTimes(2));
  });

  /*
   * Two tile footnotes are whole sentences — the Sol cache-write estimate runs
   * past a hundred characters — and a tile in this grid is about 150px wide.
   * `truncate` gave them one line and clipped the rest, so the caveat that the
   * latest turn is unknown never reached the screen. That caveat is the point
   * of the sentence, which makes a taller tile the cheaper cost.
   */
  it("wraps tile footnotes rather than clipping them to one line", async () => {
    const screen = render(() => <AnalyticsTab />);
    await waitFor(() => expect(screen.getByText("Largest agent run")).toBeInTheDocument());

    expect(screen.getByText("completed and reconstructed agent runs")).not.toHaveClass("truncate");
  });

  it("keeps the headline compact and exposes each report as a tab", async () => {
    const screen = render(() => <AnalyticsTab />);
    await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());
    expect(screen.getByRole("tablist")).toHaveClass("shrink-0");

    expect(screen.getAllByRole("tab")).toHaveLength(6);
    expect(screen.getByRole("tab", { name: "Value" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "Efficiency" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Largest turn" })).not.toBeInTheDocument();
    expect(screen.getByText("Efficiency")).toBeInTheDocument();
    expect(screen.getByText("Billable traffic")).toBeInTheDocument();
    expect(screen.getByText("Largest agent run")).toBeInTheDocument();
    expect(screen.getByText("Usage records")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Models" }));
    flush();
    expect(screen.getByRole("tab", { name: "Models" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAccessibleName("Models");
    expect(screen.getByText("Per model")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("tab", { name: "Models" }), { key: "ArrowRight" });
    flush();
    expect(screen.getByRole("tab", { name: "Value" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Value" }), { key: "End" });
    flush();
    expect(screen.getByRole("tab", { name: "Models" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows measured agent time and distinct turns per item", async () => {
    getUsageAnalytics.mockResolvedValue({
      ...EMPTY_USAGE,
      items: [
        {
          itemId: "item-a",
          itemTitle: "Repair settings drift",
          projectId: "project-a",
          projectName: "AgencyZero",
          agents: ["codex"],
          durationMs: 3_754_000,
          turns: 4,
          completed: true,
          lastAt: "2026-08-08T16:00:00Z",
        },
      ],
    });

    const screen = render(() => <AnalyticsTab />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Items" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Items" }));
    flush();

    expect(screen.getByText("Repair settings drift")).toBeInTheDocument();
    expect(screen.getByText("1h 3m")).toBeInTheDocument();
    expect(screen.getByText(/4 turns/)).toBeInTheDocument();
  });

  it("labels inferred Sol cache writes and uses them in the efficiency ratio", async () => {
    getUsageAnalytics.mockResolvedValue({
      ...EMPTY_USAGE,
      totalCacheReadTokens: 8_192,
      estimatedCacheWriteTokens: 2_048,
    });

    const screen = render(() => <AnalyticsTab />);

    await waitFor(() => expect(screen.getByText("4.0 : 1")).toBeInTheDocument());
    expect(screen.getByText("~2.0K")).toBeInTheDocument();
    expect(screen.getByText(/Sol cache writes inferred/)).toBeInTheDocument();
  });

  it("signals a 19:1 cache reuse ratio as healthy", async () => {
    getUsageAnalytics.mockResolvedValue({
      ...EMPTY_USAGE,
      totalCacheReadTokens: 19_000,
      totalCacheWriteTokens: 1_000,
    });

    const screen = render(() => <AnalyticsTab />);

    const value = await screen.findByText("19.0 : 1");
    expect(value).toHaveClass("text-success");
    expect(screen.getByText("Healthy cache reuse")).toBeInTheDocument();
  });
});
