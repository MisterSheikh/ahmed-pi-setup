import assert from "node:assert/strict";
import test from "node:test";
import { formatSharedContext } from "./src/format.ts";
import type { ShareMessage } from "./src/messages.ts";

const messages: ShareMessage[] = [
  {
    role: "user",
    text: "Please inspect `src/index.ts`.",
    imageCount: 0,
  },
  {
    role: "agent",
    text: "I found **two** problems.",
    imageCount: 0,
  },
];

test("formats selected messages as chronological Markdown", () => {
  assert.equal(
    formatSharedContext(messages),
    "## User\n\nPlease inspect `src/index.ts`.\n\n---\n\n## Agent\n\nI found **two** problems.\n",
  );
});

test("marks image attachments without embedding stored image data", () => {
  assert.equal(
    formatSharedContext([{ ...messages[0]!, text: "See this", imageCount: 2 }]),
    "## User\n\nSee this\n\n[2 image attachments omitted]\n",
  );
});
