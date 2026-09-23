/**
 * Theme-aware presentation for Subagents V2 communication.
 *
 * This module is pure presentation: it never imports the manager or any
 * mutable/persisted state. The parent supplies plain records and, for
 * historical tasks, the current-task comparison (see `historical` /
 * `currentStatus`).
 *
 * ## Integration examples
 *
 * Outgoing tool call (renderCall) — identity only, no task id yet:
 * ```ts
 * renderCall(args, theme) {
 *   const worker = manager.get(args.id); // or match by name for spawn
 *   return renderCommunication(
 *     {
 *       direction: "outgoing",
 *       action: "TASK",
 *       workerId: worker?.id,
 *       name: worker?.name ?? args.name,
 *       body: args.task,
 *     },
 *     { expanded: false },
 *     theme,
 *   );
 * }
 * ```
 *
 * Outgoing tool result (renderResult) — use the record captured in execute:
 * ```ts
 * renderResult(result, { expanded }, theme) {
 *   const record = (result.details as { communication?: CommunicationRecord })
 *     ?.communication;
 *   return record
 *     ? renderCommunication(record, { expanded }, theme)
 *     : new Text(theme.fg("muted", "No worker acknowledgement recorded."), 0, 0);
 * }
 * ```
 *
 * Incoming result batch message renderer:
 * ```ts
 * pi.registerMessageRenderer("subagents-v2-results", (message, { expanded }, theme) =>
 *   renderResultBatch(
 *     decodeResultBatchDetails(message.details),
 *     { expanded },
 *     theme,
 *   ),
 * );
 * ```
 *
 * Incoming FYI message renderer — body comes from the message content:
 * ```ts
 * pi.registerMessageRenderer("subagents-v2-fyi", (message, { expanded }, theme) => {
 *   const body = typeof message.content === "string" ? message.content : "";
 *   const record = decodeCommunicationDetails(message.details, body);
 *   return record
 *     ? renderCommunication(record, { expanded }, theme)
 *     : new Text(theme.fg("dim", "Unreadable worker update."), 0, 0);
 * });
 * ```
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  Spacer,
  Text,
  VStack,
  truncateToWidth,
  type Component,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./format.ts";

export type Direction = "outgoing" | "incoming" | "system";
export type OutgoingAction =
  "TASK" | "FOLLOW-UP" | "STEER" | "INTERRUPT" | "WAIT" | "INSPECT";
export type IncomingAction =
  "RESULT" | "FYI" | "QUESTION" | "BLOCKED" | "FAILED";
export type SystemAction = "ACK" | "SNAPSHOT" | "LIST" | "STATUS";
export type CommunicationAction =
  OutgoingAction | IncomingAction | SystemAction;

/** Plain JSON record the parent persists in tool/message details. */
export interface CommunicationRecord {
  direction: Direction;
  action: CommunicationAction;
  workerId?: string;
  name?: string;
  /** Omitted for outgoing tool calls: the task does not exist yet. */
  taskId?: string;
  /** Status recorded with this record; rendered as `recorded: X` and may be stale. */
  status?: string;
  /** Live worker status supplied by the parent at render time; rendered as `worker now: Y`. */
  currentStatus?: string;
  /** True when this record's task is no longer the worker's current task. */
  historical?: boolean;
  body?: string;
}

/** Structural subset of the active Pi theme used for communication output. */
export interface CommunicationTheme {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  strikethrough(text: string): string;
}

export interface CommunicationRenderOptions {
  expanded?: boolean;
}

const OUTGOING_ACTIONS: readonly OutgoingAction[] = [
  "TASK",
  "FOLLOW-UP",
  "STEER",
  "INTERRUPT",
  "WAIT",
  "INSPECT",
];
const INCOMING_ACTIONS: readonly IncomingAction[] = [
  "RESULT",
  "FYI",
  "QUESTION",
  "BLOCKED",
  "FAILED",
];
const SYSTEM_ACTIONS: readonly SystemAction[] = [
  "ACK",
  "SNAPSHOT",
  "LIST",
  "STATUS",
];
const ALL_ACTIONS: readonly CommunicationAction[] = [
  ...OUTGOING_ACTIONS,
  ...INCOMING_ACTIONS,
  ...SYSTEM_ACTIONS,
];
const DIRECTIONS: readonly Direction[] = ["outgoing", "incoming", "system"];

const PREVIEW_LINES = 8;

const ACTION_COLOR: Record<CommunicationAction, ThemeColor> = {
  TASK: "accent",
  "FOLLOW-UP": "accent",
  STEER: "accent",
  INTERRUPT: "accent",
  WAIT: "accent",
  INSPECT: "accent",
  RESULT: "success",
  FYI: "muted",
  QUESTION: "warning",
  BLOCKED: "warning",
  FAILED: "error",
  ACK: "dim",
  SNAPSHOT: "dim",
  LIST: "dim",
  STATUS: "dim",
};

/** Sanitize a single metadata field: no newlines may split a header line. */
function safeMeta(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return sanitizeTerminalText(value).replace(/\n+/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isDirection(value: unknown): value is Direction {
  return DIRECTIONS.includes(value as Direction);
}

function isAction(value: unknown): value is CommunicationAction {
  return ALL_ACTIONS.includes(value as CommunicationAction);
}

function inferDirection(action: CommunicationAction): Direction {
  if (OUTGOING_ACTIONS.includes(action as OutgoingAction)) return "outgoing";
  if (SYSTEM_ACTIONS.includes(action as SystemAction)) return "system";
  return "incoming";
}

function defaultAction(direction: Direction): CommunicationAction {
  if (direction === "outgoing") return "TASK";
  if (direction === "system") return "STATUS";
  return "RESULT";
}

function actionColor(record: CommunicationRecord): ThemeColor {
  const status = record.status?.toLowerCase();
  // Tool validation/UI failures stay system-authored but must still read red.
  if (status === "failed" || status === "error") return "error";
  return ACTION_COLOR[record.action] ?? "text";
}

function bodyColor(record: CommunicationRecord): ThemeColor {
  if (record.action === "FYI") return "muted";
  return "text";
}

function identityText(record: CommunicationRecord): string {
  const id = safeMeta(record.workerId);
  const name = safeMeta(record.name);
  if (name && id) return `${name} (${id})`;
  return name ?? id ?? "unknown worker";
}

function statusSegments(
  record: CommunicationRecord,
  theme: CommunicationTheme,
): string[] {
  const segments: string[] = [];
  const status = safeMeta(record.status);
  const currentStatus = safeMeta(record.currentStatus);
  // `status` is a persisted snapshot and may be stale after a rerender, so it
  // is always labelled as recorded rather than live/current state.
  if (status) {
    segments.push(
      theme.fg(
        "dim",
        `${record.historical ? "historical · " : ""}recorded: ${status}`,
      ),
    );
  } else if (record.historical) {
    segments.push(theme.fg("dim", "historical task"));
  }
  if (currentStatus)
    segments.push(theme.fg("text", `worker now: ${currentStatus}`));
  return segments;
}

function routeText(record: CommunicationRecord): string {
  if (record.direction === "system") return "System → Parent";
  const worker = identityText(record);
  return record.direction === "outgoing"
    ? `Parent → ${worker}`
    : `${worker} → Parent`;
}

function headerText(
  record: CommunicationRecord,
  theme: CommunicationTheme,
  includeAction: boolean,
): string {
  const color = actionColor(record);
  const parts = [theme.fg(color, routeText(record))];
  if (record.direction === "system" && (record.workerId || record.name))
    parts.push(theme.fg("text", `for ${identityText(record)}`));
  if (includeAction)
    parts.push(theme.fg(color, theme.bold(`[${record.action}]`)));
  const taskId = safeMeta(record.taskId);
  if (taskId) parts.push(theme.fg("muted", `task ${taskId}`));
  parts.push(...statusSegments(record, theme));
  return parts.join(" · ");
}

function markdownTheme(theme: CommunicationTheme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", theme.bold(text)),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    strikethrough: (text) => theme.strikethrough(text),
    underline: (text) => theme.underline(text),
  };
}

function collapsedPreview(
  record: CommunicationRecord,
  theme: CommunicationTheme,
  color: ThemeColor,
): string {
  const text = sanitizeTerminalText(record.body ?? "").trimEnd();
  if (!text) return theme.fg("dim", "(no content)");
  const lines = text.split("\n");
  const shown = lines
    .slice(0, PREVIEW_LINES)
    .map((line) => theme.fg(color, line));
  if (lines.length > PREVIEW_LINES)
    shown.push(
      theme.fg(
        "dim",
        `... ${lines.length - PREVIEW_LINES} more lines (expand)`,
      ),
    );
  return shown.join("\n");
}

/** Build a themed string at render time so a theme change is not frozen in. */
function liveText(
  theme: CommunicationTheme,
  build: (theme: CommunicationTheme) => string,
): Component {
  return {
    invalidate() {},
    render(width: number) {
      return new Text(build(theme), 0, 0).render(width);
    },
  };
}

class LiveMarkdown implements Component {
  private readonly markdown: Markdown;
  private last = "";
  constructor(
    private readonly theme: CommunicationTheme,
    private readonly body: () => string,
  ) {
    this.markdown = new Markdown("", 0, 0, markdownTheme(theme));
  }
  invalidate() {
    this.markdown.invalidate();
    this.last = "";
  }
  render(width: number) {
    const text = this.body();
    if (!text)
      return new Text(this.theme.fg("dim", "(no content)"), 0, 0).render(width);
    if (text !== this.last) {
      this.markdown.setText(text);
      this.last = text;
    }
    return this.markdown.render(width);
  }
}

/** Indent a block under a coloured gutter so it clearly belongs to its header. */
function withGutter(
  inner: Component,
  theme: CommunicationTheme,
  color: ThemeColor,
): Component {
  return {
    invalidate() {
      inner.invalidate();
    },
    render(width: number) {
      const safeWidth = Math.max(1, Math.floor(width));
      const gutterWidth = safeWidth >= 3 ? 2 : 0;
      const gutter = gutterWidth ? theme.fg(color, "│ ") : "";
      const innerWidth = Math.max(1, safeWidth - gutterWidth);
      return inner
        .render(innerWidth)
        .map((line) => truncateToWidth(`${gutter}${line}`, safeWidth));
    },
  };
}

function bodyBlock(
  record: CommunicationRecord,
  expanded: boolean,
  theme: CommunicationTheme,
): Component {
  const inner: Component = expanded
    ? new LiveMarkdown(theme, () =>
        sanitizeTerminalText(record.body ?? "").trimEnd(),
      )
    : liveText(theme, (t) => collapsedPreview(record, t, bodyColor(record)));
  return withGutter(inner, theme, actionColor(record));
}

/** Render one communication: header plus collapsed preview or expanded Markdown. */
export function renderCommunication(
  record: CommunicationRecord,
  options: CommunicationRenderOptions,
  theme: CommunicationTheme,
): Component {
  const header = liveText(theme, (t) => headerText(record, t, true));
  const body = bodyBlock(record, options.expanded ?? false, theme);
  return new VStack([header, body]);
}

function groupKey(record: CommunicationRecord): string | undefined {
  if (!record.workerId && !record.taskId) return undefined;
  return `${record.direction}\u0000${record.workerId ?? ""}\u0000${record.taskId ?? ""}`;
}

function groupItems(
  items: readonly CommunicationRecord[],
): CommunicationRecord[][] {
  const groups: CommunicationRecord[][] = [];
  let current: CommunicationRecord[] | undefined;
  let key: string | undefined;
  for (const item of items) {
    const itemKey = groupKey(item);
    if (!current || itemKey === undefined || itemKey !== key) {
      current = [];
      groups.push(current);
      key = itemKey;
    }
    current.push(item);
  }
  return groups;
}

/**
 * Render an incoming batch with one header per worker/task group. Items that
 * share a worker id and task id are grouped under a single header.
 */
export function renderResultBatch(
  items: readonly CommunicationRecord[],
  options: CommunicationRenderOptions,
  theme: CommunicationTheme,
): Component {
  const children: Component[] = [];
  const expanded = options.expanded ?? false;
  groupItems(items).forEach((group, index) => {
    if (index > 0) children.push(new Spacer(1));
    const first = group[0];
    if (!first) return;
    // One header per worker/task group; the action badges carry each record.
    children.push(liveText(theme, (t) => headerText(first, t, false)));
    for (const item of group) {
      children.push(
        withGutter(
          liveText(theme, (t) =>
            t.fg(actionColor(item), t.bold(`[${item.action}]`)),
          ),
          theme,
          actionColor(item),
        ),
      );
      children.push(bodyBlock(item, expanded, theme));
    }
  });
  if (children.length === 0)
    children.push(liveText(theme, (t) => t.fg("dim", "(no worker results)")));
  return new VStack(children);
}

/**
 * Defensively decode one persisted communication record. Never throws; returns
 * undefined when the value cannot represent a communication at all.
 */
export function decodeCommunication(
  value: unknown,
  body?: string,
): CommunicationRecord | undefined {
  if (!isRecord(value)) return undefined;
  const workerId = asString(value.workerId) ?? asString(value.id);
  const name = asString(value.name) ?? asString(value.title);
  const taskId = asString(value.taskId);
  const text = asString(value.body) ?? body;
  const recognized =
    isDirection(value.direction) ||
    isAction(value.action) ||
    workerId !== undefined ||
    name !== undefined ||
    taskId !== undefined ||
    text !== undefined;
  if (!recognized) return undefined;
  const rawAction = isAction(value.action) ? value.action : undefined;
  const direction = isDirection(value.direction)
    ? value.direction
    : rawAction
      ? inferDirection(rawAction)
      : "incoming";
  const action = rawAction ?? defaultAction(direction);
  const record: CommunicationRecord = {
    direction,
    action,
    body: text ?? "",
  };
  const status = asString(value.status);
  const currentStatus = asString(value.currentStatus);
  if (workerId) record.workerId = workerId;
  if (name) record.name = name;
  if (taskId) record.taskId = taskId;
  if (status) record.status = status;
  if (currentStatus) record.currentStatus = currentStatus;
  if (value.historical === true) record.historical = true;
  return record;
}

/** Decode a bare array (or wrapper object) of communication records. */
export function decodeCommunicationList(
  value: unknown,
  body?: string,
): CommunicationRecord[] {
  const source = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.communications)
      ? value.communications
      : isRecord(value) && Array.isArray(value.results)
        ? value.results
        : [];
  const records: CommunicationRecord[] = [];
  for (const item of source) {
    const record = decodeCommunication(item, body);
    if (record) records.push(record);
  }
  return records;
}

/**
 * Decode batch details: `{ communications: [...] }`, legacy `{ results: [...] }`,
 * or a bare array. Malformed entries are skipped.
 */
export function decodeResultBatchDetails(
  details: unknown,
): CommunicationRecord[] {
  return decodeCommunicationList(details);
}

/**
 * Decode single-communication details: `{ communication: {...} }` or a legacy
 * flat record. `body` supplies message content for FYI payloads.
 */
export function decodeCommunicationDetails(
  details: unknown,
  body?: string,
): CommunicationRecord | undefined {
  const source =
    isRecord(details) && isRecord(details.communication)
      ? details.communication
      : details;
  const record = decodeCommunication(source, body);
  // Single-communication payloads are FYI updates; a legacy flat record has no
  // action, so default it to FYI rather than the batch-oriented RESULT.
  if (record && isRecord(source) && !isAction(source.action)) {
    record.direction = "incoming";
    record.action = "FYI";
  }
  return record;
}
