import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { MessageReceipt } from "~/features/project/TranscriptPane";

describe("message delivery receipts", () => {
  it("stays absent until the backend acknowledges the stored row", () => {
    const { queryByRole } = render(() => <MessageReceipt />);
    expect(queryByRole("img")).not.toBeInTheDocument();
  });

  it("shows one check when the message is sent", () => {
    const { getByRole } = render(() => <MessageReceipt status="sent" />);
    const receipt = getByRole("img", { name: "Sent" });
    expect(receipt.querySelectorAll("path")).toHaveLength(1);
  });

  it("shows two checks when the provider accepts the message", () => {
    const { getByRole } = render(() => <MessageReceipt status="read" />);
    const receipt = getByRole("img", { name: "Read by agent" });
    expect(receipt.querySelectorAll("path")).toHaveLength(2);
    expect(receipt).toHaveClass("text-primary");
  });
});
