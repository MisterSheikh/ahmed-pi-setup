import assert from "node:assert/strict";
import test from "node:test";
import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ShareMessage } from "./src/messages.ts";
import {
  describeSelection,
  selectedMessages,
  sanitizeDisplayText,
  SharePicker,
  type SharePickerResult,
} from "./src/ui.ts";

const messages: ShareMessage[] = Array.from({ length: 10 }, (_, index) => ({
  role: index % 2 === 0 ? "user" : "agent",
  text: `message ${index}`,
  imageCount: 0,
}));

test("describes the selected range relative to the newest message", () => {
  assert.equal(
    describeSelection(10, { anchor: 9, cursor: 4 }),
    "6 selected · includes latest",
  );
  assert.equal(
    describeSelection(10, { anchor: 7, cursor: 2 }),
    "6 selected · newest selected is 2 messages back",
  );
});

test("returns an inclusive chronological slice", () => {
  assert.deepEqual(
    selectedMessages(messages, { anchor: 7, cursor: 2 }).map(
      (message) => message.text,
    ),
    [
      "message 2",
      "message 3",
      "message 4",
      "message 5",
      "message 6",
      "message 7",
    ],
  );
});

function pickerHarness(rows = 24) {
  let result: SharePickerResult | null | undefined;
  const tui = {
    terminal: { rows },
    requestRender() {},
  } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
  const keybindings = {
    matches: (data: string, binding: string) =>
      (binding === "tui.select.up" && data === "UP") ||
      (binding === "tui.select.down" && data === "DOWN") ||
      (binding === "tui.select.confirm" && data === "ENTER") ||
      (binding === "tui.select.cancel" && data === "ESC"),
    getKeys: () => [],
  } as unknown as KeybindingsManager;
  const picker = new SharePicker(
    tui,
    theme,
    keybindings,
    messages,
    { anchor: 7, cursor: 2 },
    (value) => {
      result = value;
    },
  );
  return { picker, getResult: () => result };
}

test("picker output respects the width and height supplied by the TUI", () => {
  for (const rows of [8, 10, 14, 24]) {
    const { picker } = pickerHarness(rows);
    for (const width of [1, 10, 40, 100]) {
      const lines = picker.render(width);
      assert.ok(
        lines.every((line) => visibleWidth(line) <= width),
        `rendered line wider than ${width}`,
      );
      assert.ok(lines.length <= rows, `rendered more than ${rows} rows`);
    }
  }
});

test("display sanitization removes complete and unterminated terminal controls", () => {
  assert.equal(sanitizeDisplayText("\u001b[31mred\u001b[0m"), "red");
  assert.equal(sanitizeDisplayText("\u001b]0;title\u0007text"), "text");
  assert.equal(sanitizeDisplayText("safe\u001b]0;unterminated"), "safe");
  assert.equal(sanitizeDisplayText("a\tb\u0000"), "a  b");
});

test("picker moves the range endpoint, resets its anchor, and copies", () => {
  const { picker, getResult } = pickerHarness();
  picker.handleInput("UP");
  picker.handleInput("v");
  picker.handleInput("UP");
  picker.handleInput("ENTER");
  assert.deepEqual(getResult(), {
    action: "copy",
    selection: { anchor: 1, cursor: 0 },
  });
});
