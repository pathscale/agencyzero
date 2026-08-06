import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { QuestionReplyPill } from "~/features/project/Composer";
import type { Question } from "~/types";

const QUESTION: Question = {
  id: "q-long",
  projectId: "project-a",
  text: "This deliberately long question should stay in the hover title, not consume the composer.",
  urgency: "blocking",
  answered: false,
  createdAt: "2026-08-07T00:00:00Z",
};

describe("question reply pill", () => {
  it("shows only the stable question number and keeps full text on hover", () => {
    const screen = render(() => <QuestionReplyPill question={QUESTION} number={3} />);
    const pill = screen.getByText("Reply to #3").parentElement;

    expect(pill).toHaveAttribute("title", QUESTION.text);
    expect(screen.queryByText(QUESTION.text)).not.toBeInTheDocument();
  });
});
