import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { IconSprite } from "~/components/IconSprite";
import { ReviewNote } from "~/features/project/TranscriptPane";
import type { Message } from "~/types";

const REVIEW: Message = {
  id: "review-1",
  projectId: "project-a",
  itemId: null,
  author: "review",
  agent: "copilot",
  moderation: null,
  model: "gpt-5.5",
  permission: "read_only",
  usage: null,
  stop: "https://github.com/pathscale/agencyzero/pull/121",
  exitCode: 1,
  body: "could not fetch the pull request diff: authentication required",
  createdAt: new Date().toISOString(),
};

describe("review transcript message", () => {
  it("renders a failed review in the agent lane with its reviewer named", () => {
    const screen = render(() => (
      <>
        <IconSprite />
        <ReviewNote message={REVIEW} />
      </>
    ));

    expect(screen.getByText("Review by Copilot")).toBeInTheDocument();
    expect(screen.getByText("Review failed")).toBeInTheDocument();
    expect(screen.getByText(/authentication required/)).toBeInTheDocument();
    expect(screen.getByText("Review by Copilot").closest("[data-selectable]")).toHaveClass(
      "self-start",
      "max-w-[88%]",
    );
  });
});
