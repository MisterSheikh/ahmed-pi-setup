import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  copyToClipboard,
  DynamicBorder,
  getSelectListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  SelectList,
  Text,
  type SelectItem,
} from "@earendil-works/pi-tui";

export interface CopyChoice {
  readonly label: string;
  readonly text: string;
  readonly preview: string | undefined;
}

interface OpenFence {
  readonly marker: "`" | "~";
  readonly length: number;
  readonly indent: number;
  readonly language: string | undefined;
  readonly content: string[];
}

function splitLines(source: string) {
  return source.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? [];
}

function withoutLineEnding(line: string) {
  return line.replace(/(?:\r\n|\n|\r)$/, "");
}

function openingFence(line: string): OpenFence | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)(?:\r\n|\n|\r)?$/.exec(line);
  if (!match) return undefined;
  const marker = match[2]![0] as "`" | "~";
  const info = match[3]!.trim();
  if (marker === "`" && info.includes("`")) return undefined;
  const language = info.split(/[,\s]/, 1)[0]?.trim() || undefined;
  return {
    marker,
    length: match[2]!.length,
    indent: match[1]!.length,
    language,
    content: [],
  };
}

function isClosingFence(line: string, fence: OpenFence) {
  const text = withoutLineEnding(line);
  const match = /^( {0,3})(`+|~+)[ \t]*$/.exec(text);
  return match?.[2]?.[0] === fence.marker && match[2].length >= fence.length;
}

function stripFenceIndent(line: string, indent: number) {
  let removed = 0;
  while (removed < indent && line[removed] === " ") removed += 1;
  return line.slice(removed);
}

/** Extract CommonMark-style fenced code blocks in source order. */
export function extractFencedCodeBlocks(markdown: string): CopyChoice[] {
  const choices: CopyChoice[] = [];
  let fence: OpenFence | undefined;

  for (const line of splitLines(markdown)) {
    if (!fence) {
      fence = openingFence(line);
      continue;
    }
    if (isClosingFence(line, fence)) {
      const text = fence.content.join("");
      choices.push({
        label: fence.language ? `${fence.language} code` : "Code block",
        text,
        preview: firstNonEmptyLine(text),
      });
      fence = undefined;
      continue;
    }
    fence.content.push(stripFenceIndent(line, fence.indent));
  }

  if (fence) {
    const text = fence.content.join("");
    choices.push({
      label: fence.language ? `${fence.language} code` : "Code block",
      text,
      preview: firstNonEmptyLine(text),
    });
  }
  return choices;
}

function firstNonEmptyLine(text: string) {
  const line = text.split(/\r\n|\n|\r/).find((candidate) => candidate.trim());
  if (!line) return undefined;
  const trimmed = line.trim();
  return trimmed.length > 72 ? `${trimmed.slice(0, 69)}...` : trimmed;
}

function textContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}

/** Find the newest assistant message containing visible text. */
export function latestAssistantResponse(entries: readonly SessionEntry[]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type !== "message" || entry.message.role !== "assistant")
      continue;
    const text = textContent(entry.message.content);
    if (text.trim()) return text;
  }
  return undefined;
}

export function copyChoices(markdown: string): CopyChoice[] {
  return [
    {
      label: "Whole response",
      text: markdown,
      preview: firstNonEmptyLine(markdown),
    },
    ...extractFencedCodeBlocks(markdown),
  ];
}

async function pickChoice(
  ctx: ExtensionCommandContext,
  choices: readonly CopyChoice[],
) {
  if (choices.length === 1) return choices[0];
  const items: SelectItem[] = choices.map((choice, index) => ({
    value: String(index),
    label: index < 9 ? `${index + 1}. ${choice.label}` : choice.label,
    description: choice.preview,
  }));
  const selected = await ctx.ui.custom<string | null>(
    (tui, theme, _keys, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
      container.addChild(
        new Text(theme.fg("accent", theme.bold("Copy to clipboard"))),
      );
      const list = new SelectList(
        items,
        Math.min(items.length, 12),
        getSelectListTheme(),
      );
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
      container.addChild(list);
      container.addChild(
        new Text(theme.fg("dim", "↑↓ navigate · enter copy · esc cancel")),
      );
      container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          if (/^[1-9]$/.test(data)) {
            const index = Number(data) - 1;
            if (index < choices.length) done(String(index));
            return;
          }
          list.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );
  return selected === null ? undefined : choices[Number(selected)];
}

export default function copyResponseExtension(pi: ExtensionAPI) {
  // Pi's built-in /copy always wins name collisions, so this must use a
  // distinct command name to remain reachable from the interactive UI.
  pi.registerCommand("copy-response", {
    description: "Choose the latest response or one of its code blocks to copy",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      await ctx.waitForIdle();
      const response = latestAssistantResponse(ctx.sessionManager.getBranch());
      if (!response) {
        ctx.ui.notify("No assistant response is available to copy.", "warning");
        return;
      }
      const choice = await pickChoice(ctx, copyChoices(response));
      if (!choice) return;
      try {
        await copyToClipboard(choice.text);
        ctx.ui.notify(
          `Copied ${choice.label.toLowerCase()} to clipboard.`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Could not copy to clipboard: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
