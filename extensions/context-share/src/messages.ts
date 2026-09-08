import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type ShareRole = "user" | "agent";

export interface ShareMessage {
  readonly role: ShareRole;
  readonly text: string;
  readonly imageCount: number;
}

function textAndImages(content: unknown) {
  if (typeof content === "string") {
    return { text: content, imageCount: 0 };
  }
  if (!Array.isArray(content)) {
    return { text: "", imageCount: 0 };
  }

  const text: string[] = [];
  let imageCount = 0;
  for (const block of content) {
    if (typeof block !== "object" || block === null || !("type" in block)) {
      continue;
    }
    if (
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      text.push(block.text);
    } else if (block.type === "image") {
      imageCount += 1;
    }
  }
  return { text: text.join("\n\n"), imageCount };
}

/** Extract user-visible conversational text from the current session branch. */
export function extractShareMessages(
  entries: readonly SessionEntry[],
): ShareMessage[] {
  const messages: ShareMessage[] = [];

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;

    const { text, imageCount } = textAndImages(message.content);
    if (!text && imageCount === 0) continue;

    messages.push({
      role: message.role === "user" ? "user" : "agent",
      text,
      imageCount,
    });
  }

  return messages;
}
