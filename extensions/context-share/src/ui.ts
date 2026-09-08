import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ShareMessage } from "./messages.ts";
import {
  moveCursor,
  selectionBounds,
  selectionCount,
  setAnchorAtCursor,
  type SelectionState,
} from "./selection.ts";

export interface SharePickerResult {
  readonly action: "copy" | "save";
  readonly selection: SelectionState;
}

// Strip OSC strings before the generic escape pass so an unterminated
// terminal control cannot leak into the overlay and corrupt its rendering.
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c|$)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

export function sanitizeDisplayText(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function oneLine(text: string) {
  return sanitizeDisplayText(text.replace(/\s+/g, " ").trim());
}

function pad(text: string, width: number) {
  const truncated = truncateToWidth(text, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

export function describeSelection(total: number, selection: SelectionState) {
  const { end } = selectionBounds(selection);
  const count = selectionCount(selection);
  const skipped = total - end - 1;
  const position =
    skipped === 0
      ? "includes latest"
      : `newest selected is ${skipped} message${skipped === 1 ? "" : "s"} back`;
  return `${count} selected · ${position}`;
}

export function selectedMessages(
  messages: readonly ShareMessage[],
  selection: SelectionState,
) {
  const { start, end } = selectionBounds(selection);
  return messages.slice(start, end + 1);
}

export async function openSharePicker(
  ctx: ExtensionCommandContext,
  messages: readonly ShareMessage[],
  initialSelection: SelectionState,
) {
  return ctx.ui.custom<SharePickerResult | null>(
    (tui, theme, keybindings, done) =>
      new SharePicker(
        tui,
        theme,
        keybindings,
        messages,
        initialSelection,
        done,
      ),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
    },
  );
}

export class SharePicker implements Component {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly messages: readonly ShareMessage[];
  private readonly done: (value: SharePickerResult | null) => void;
  private selection: SelectionState;
  private previewScroll = 0;
  private closed = false;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    messages: readonly ShareMessage[],
    initialSelection: SelectionState,
    done: (value: SharePickerResult | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.messages = messages;
    this.done = done;
    this.selection = { ...initialSelection };
  }

  private finish(action: "copy" | "save") {
    if (this.closed) return;
    this.closed = true;
    this.done({ action, selection: { ...this.selection } });
  }

  private cancel() {
    if (this.closed) return;
    this.closed = true;
    this.done(null);
  }

  private move(delta: number) {
    this.selection = moveCursor(this.selection, delta, this.messages.length);
    this.previewScroll = 0;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.cancel();
      return;
    }
    if (data === "c" || this.keybindings.matches(data, "tui.select.confirm")) {
      this.finish("copy");
      return;
    }
    if (data === "s") {
      this.finish("save");
      return;
    }
    if (data === "v" || data === " ") {
      this.selection = setAnchorAtCursor(this.selection);
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      this.move(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      this.move(1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.previewScroll = Math.max(
        0,
        this.previewScroll - this.previewPageSize(),
      );
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.previewScroll += this.previewPageSize();
      this.tui.requestRender();
      return;
    }
    if (data === "g") {
      this.selection = { ...this.selection, cursor: 0 };
      this.previewScroll = 0;
      this.tui.requestRender();
      return;
    }
    if (data === "G") {
      this.selection = {
        ...this.selection,
        cursor: this.messages.length - 1,
      };
      this.previewScroll = 0;
      this.tui.requestRender();
    }
  }

  private layoutHeights() {
    const rows = this.tui.terminal.rows || 30;
    const contentHeight = Math.max(2, rows - 7);
    const listHeight = Math.max(1, Math.floor(contentHeight * 0.45));
    return {
      listHeight,
      previewHeight: Math.max(1, contentHeight - listHeight),
    };
  }

  private previewPageSize() {
    return Math.max(1, this.layoutHeights().previewHeight - 1);
  }

  render(width: number): string[] {
    const usableWidth = Math.max(1, width);
    const { listHeight, previewHeight } = this.layoutHeights();
    const border = this.theme.fg(
      "border",
      "─".repeat(Math.max(1, usableWidth)),
    );
    const lines: string[] = [];

    const title = this.theme.fg("accent", this.theme.bold("Share context"));
    const summary = this.theme.fg(
      "muted",
      describeSelection(this.messages.length, this.selection),
    );
    const gap = Math.max(
      1,
      usableWidth - visibleWidth(title) - visibleWidth(summary) - 4,
    );
    lines.push(
      truncateToWidth(`  ${title}${" ".repeat(gap)}${summary}  `, usableWidth),
    );
    lines.push(border);
    lines.push(
      truncateToWidth(
        this.theme.fg(
          "dim",
          "  Messages, chronological. Tool activity and thinking are excluded.",
        ),
        usableWidth,
      ),
    );
    lines.push(...this.renderMessageList(usableWidth, listHeight));
    lines.push(border);
    lines.push(...this.renderPreview(usableWidth, previewHeight));
    lines.push(border);
    lines.push(
      truncateToWidth(
        this.theme.fg(
          "dim",
          `${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select · v/space reset anchor · ${configuredKeys(this.keybindings, "tui.select.pageUp")}/${configuredKeys(this.keybindings, "tui.select.pageDown")} preview · ${configuredKeys(this.keybindings, "tui.select.confirm")}/c copy · s save · ${configuredKeys(this.keybindings, "tui.select.cancel")} close`,
        ),
        usableWidth,
      ),
    );
    return lines;
  }

  private renderMessageList(width: number, height: number) {
    const { start, end } = selectionBounds(this.selection);
    const maxStart = Math.max(0, this.messages.length - height);
    const windowStart = Math.min(
      Math.max(0, this.selection.cursor - Math.floor(height / 2)),
      maxStart,
    );
    const visible = this.messages.slice(windowStart, windowStart + height);
    const lines: string[] = [];

    for (let offset = 0; offset < visible.length; offset += 1) {
      const index = windowStart + offset;
      const message = visible[offset]!;
      const focused = index === this.selection.cursor;
      const selected = index >= start && index <= end;
      const back = this.messages.length - index - 1;
      const marker = focused ? "❯" : selected ? "●" : " ";
      const role = message.role === "user" ? "USER " : "AGENT";
      const imageText =
        message.imageCount > 0
          ? ` [${message.imageCount} image${message.imageCount === 1 ? "" : "s"}]`
          : "";
      const preview = oneLine(message.text) || "(image-only message)";
      let row = ` ${marker} ${String(index + 1).padStart(3)} ${role}  ${back === 0 ? "latest" : `${back} back`}  ${preview}${imageText}`;
      row = pad(row, width);
      if (focused) row = this.theme.fg("accent", this.theme.bold(row));
      if (selected) row = this.theme.bg("selectedBg", row);
      lines.push(row);
    }

    while (lines.length < height) lines.push("".padEnd(width));
    return lines;
  }

  private renderPreview(width: number, height: number) {
    const message = this.messages[this.selection.cursor]!;
    const label = `${message.role === "user" ? "User" : "Agent"} · message ${this.selection.cursor + 1} of ${this.messages.length}`;
    const available = Math.max(10, width - 2);
    const wrapped: string[] = [];
    const display = sanitizeDisplayText(message.text);
    for (const rawLine of display.split("\n")) {
      if (!rawLine) {
        wrapped.push("");
      } else {
        wrapped.push(...wrapTextWithAnsi(rawLine, available));
      }
    }
    if (message.imageCount > 0) {
      if (wrapped.length > 0 && wrapped.at(-1) !== "") wrapped.push("");
      wrapped.push(
        `[${message.imageCount} image attachment${message.imageCount === 1 ? "" : "s"} omitted from export]`,
      );
    }

    const bodyHeight = Math.max(1, height - 1);
    const maxScroll = Math.max(0, wrapped.length - bodyHeight);
    this.previewScroll = Math.min(this.previewScroll, maxScroll);
    const body = wrapped.slice(
      this.previewScroll,
      this.previewScroll + bodyHeight,
    );
    const lines = [
      truncateToWidth(
        `  ${this.theme.fg("accent", this.theme.bold(label))}${
          maxScroll > 0
            ? this.theme.fg(
                "dim",
                ` · lines ${this.previewScroll + 1}-${Math.min(this.previewScroll + bodyHeight, wrapped.length)} of ${wrapped.length}`,
              )
            : ""
        }`,
        width,
      ),
      ...body.map((line) => truncateToWidth(`  ${line}`, width)),
    ];
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  invalidate(): void {}
}
