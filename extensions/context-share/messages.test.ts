import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { extractShareMessages } from "./src/messages.ts";

function entry(value: object) {
  return value as SessionEntry;
}

test("extracts only user and assistant text in branch order", () => {
  const entries = [
    entry({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-04-01T10:00:00.000Z",
      message: { role: "user", content: "hello", timestamp: 1 },
    }),
    entry({
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-04-01T10:00:01.000Z",
      message: {
        role: "assistant",
        timestamp: 2,
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "I will check." },
          { type: "toolCall", id: "call", name: "read", arguments: {} },
          { type: "text", text: "It is fixed." },
        ],
      },
    }),
    entry({
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: "2026-04-01T10:00:02.000Z",
      message: {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "secret tool output" }],
      },
    }),
    entry({
      type: "custom_message",
      id: "c1",
      parentId: "t1",
      timestamp: "2026-04-01T10:00:03.000Z",
      customType: "hidden",
      display: false,
      content: "injected context",
    }),
  ];

  assert.deepEqual(extractShareMessages(entries), [
    { role: "user", text: "hello", imageCount: 0 },
    {
      role: "agent",
      text: "I will check.\n\nIt is fixed.",
      imageCount: 0,
    },
  ]);
});

test("drops tool-only assistant entries and retains image-only user messages", () => {
  const entries = [
    entry({
      type: "message",
      id: "a1",
      parentId: null,
      timestamp: "2026-04-01T10:00:00.000Z",
      message: {
        role: "assistant",
        timestamp: 1,
        content: [
          { type: "thinking", thinking: "thinking" },
          { type: "toolCall", id: "call", name: "bash", arguments: {} },
        ],
      },
    }),
    entry({
      type: "message",
      id: "u1",
      parentId: "a1",
      timestamp: "2026-04-01T10:00:01.000Z",
      message: {
        role: "user",
        timestamp: 2,
        content: [{ type: "image", data: "base64", mimeType: "image/png" }],
      },
    }),
  ];

  assert.deepEqual(extractShareMessages(entries), [
    { role: "user", text: "", imageCount: 1 },
  ]);
});
