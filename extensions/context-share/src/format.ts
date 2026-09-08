import type { ShareMessage } from "./messages.ts";

function imageNotice(count: number) {
  if (count === 0) return "";
  return `[${count} image attachment${count === 1 ? "" : "s"} omitted]`;
}

export function formatSharedContext(messages: readonly ShareMessage[]) {
  const sections = messages.map((message) => {
    const content = [message.text, imageNotice(message.imageCount)]
      .filter(Boolean)
      .join("\n\n");
    return `## ${message.role === "user" ? "User" : "Agent"}\n\n${content}`;
  });
  return `${sections.join("\n\n---\n\n")}\n`;
}
