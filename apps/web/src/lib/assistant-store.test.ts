import { describe, expect, it } from "vitest";
import { applyStreamMessage, type AssistantMessage } from "./assistant-store";

const reply: AssistantMessage = {
  id: "m1",
  role: "assistant",
  text: null,
  parts: [],
  status: "running",
  error: null,
  createdAt: "2026-01-01T00:00:00Z",
};

describe("applyStreamMessage", () => {
  it("folds events into the matching reply and ends it", () => {
    let messages = [reply];
    messages = applyStreamMessage(messages, {
      type: "event",
      conversationId: "c",
      messageId: "m1",
      event: { type: "text_delta", text: "Hi" },
    });
    expect(messages[0]!.parts).toEqual([{ type: "text", text: "Hi", streaming: true }]);
    messages = applyStreamMessage(messages, {
      type: "ended",
      conversationId: "c",
      messageId: "m1",
      status: "cancelled",
    });
    expect(messages[0]).toMatchObject({ status: "cancelled", parts: [{ type: "text", text: "Hi" }] });
  });

  it("ignores other messages", () => {
    const messages = [reply];
    expect(
      applyStreamMessage(messages, {
        type: "event",
        conversationId: "c",
        messageId: "x",
        event: { type: "done" },
      }),
    ).toBe(messages);
  });
});
