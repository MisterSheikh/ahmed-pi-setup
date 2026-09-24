import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import copyResponseExtension, {
  copyChoices,
  extractFencedCodeBlocks,
  latestAssistantResponse,
} from "./index.ts";

test("registers a reachable command instead of colliding with Pi's built-in /copy", () => {
  const commands: string[] = [];
  copyResponseExtension({
    registerCommand: (name: string) => {
      commands.push(name);
    },
  } as unknown as ExtensionAPI);
  assert.deepEqual(commands, ["copy-response"]);
});

test("offers the whole response followed by exact fenced code contents", () => {
  const markdown =
    "Intro\n\n```python title=example\nprint('hi')\n```\n\n~~~\nplain()\n~~~";
  assert.deepEqual(copyChoices(markdown), [
    { label: "Whole response", text: markdown, preview: "Intro" },
    { label: "python code", text: "print('hi')\n", preview: "print('hi')" },
    { label: "Code block", text: "plain()\n", preview: "plain()" },
  ]);
});

test("preserves CRLF and strips only the opening fence indentation", () => {
  assert.deepEqual(
    extractFencedCodeBlocks(
      "  ```powershell\r\n  Get-Item .\r\n Write-Output ok\r\n  ```\r\n",
    ),
    [
      {
        label: "powershell code",
        text: "Get-Item .\r\nWrite-Output ok\r\n",
        preview: "Get-Item .",
      },
    ],
  );
});

test("ignores indented code and accepts an unclosed fence at end of response", () => {
  assert.deepEqual(extractFencedCodeBlocks("    ignored()\n```sh\necho done"), [
    { label: "sh code", text: "echo done", preview: "echo done" },
  ]);
});

function message(role: "user" | "assistant", content: unknown): SessionEntry {
  return {
    type: "message",
    id: crypto.randomUUID(),
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: { role, content },
  } as SessionEntry;
}

test("uses the latest assistant response with text", () => {
  const entries = [
    message("assistant", [{ type: "text", text: "older" }]),
    message("user", "question"),
    message("assistant", [{ type: "toolCall", name: "read" }]),
    message("assistant", [
      { type: "text", text: "new" },
      { type: "text", text: " response" },
    ]),
  ];
  assert.equal(latestAssistantResponse(entries), "new response");
  assert.equal(
    latestAssistantResponse([message("user", "only user")]),
    undefined,
  );
});
