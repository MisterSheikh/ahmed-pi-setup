/**
 * Live worker dashboard and read-only/takeover worker view.
 *
 * The components render from transient `WorkerPresentation` snapshots supplied
 * by `SubagentManager.presentation()` and never mutate worker state. The only
 * state-changing calls are the explicit human controls (takeover, send,
 * interrupt); plain viewing never calls them.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { currentTask, sanitizeTerminalText, workerStatus } from "./format.ts";
import type {
  TaskStatus,
  ToolExecutionStatus,
  TranscriptPart,
  WorkerPresentation,
  WorkerRecord,
  WorkerTask,
} from "./types.ts";

// --- Host interfaces (structural subsets for testability) ---------------------

export type LiveThemeColor =
  | "accent"
  | "border"
  | "borderMuted"
  | "success"
  | "error"
  | "warning"
  | "muted"
  | "dim"
  | "text"
  | "toolTitle"
  | "toolOutput"
  | "userMessageText"
  | "thinkingText"
  | "customMessageText"
  | "customMessageLabel";

export interface LiveTheme {
  fg(color: LiveThemeColor, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
}

export interface LiveTui {
  requestRender(): void;
  terminal: { rows: number };
}

/** The subset of `SubagentManager` the live UI needs. */
export interface LiveManager {
  list(): WorkerRecord[];
  get(id: string): WorkerRecord | undefined;
  activeCount(): number;
  presentation(id: string): WorkerPresentation;
  subscribe(listener: () => void): () => void;
  beginTakeover(id: string): void;
  endTakeover(id: string): void;
  humanSend(id: string, message: string): void | Promise<void>;
  interrupt(id: string, human?: boolean): Promise<unknown> | unknown;
}

export type LiveNotify = (
  message: string,
  type?: "info" | "warning" | "error",
) => void;

export type DashboardResult = { id: string; takeover: boolean };

// --- Small formatting helpers -------------------------------------------------

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function padTo(text: string, width: number) {
  // Frame rows must be exactly one terminal row: embedded metadata LFs become
  // spaces. Transcript rows are already wrapped into separate entries.
  const oneLine = text.replace(/\n+/g, " ");
  const truncated = truncateToWidth(oneLine, Math.max(0, width));
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

/** Collapse metadata to a single terminal row (embedded LFs become spaces). */
function singleLine(text: string) {
  return sanitizeTerminalText(text).replace(/\n+/g, " ");
}

function compactNumber(value: number) {
  if (!Number.isFinite(value)) return "?";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.max(0, Math.round(value)));
}

export function formatElapsed(startedAt: number, settledAt?: number) {
  const end = settledAt ?? Date.now();
  const seconds = Math.max(0, Math.floor((end - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

export function formatContextUsage(tokens?: number, contextWindow?: number) {
  if (
    tokens !== undefined &&
    contextWindow !== undefined &&
    contextWindow > 0
  ) {
    const percent = Math.min(100, Math.round((tokens / contextWindow) * 100));
    return `${compactNumber(tokens)}/${compactNumber(contextWindow)} (${percent}%)`;
  }
  if (tokens !== undefined) return `${compactNumber(tokens)} tokens`;
  if (contextWindow !== undefined)
    return `window ${compactNumber(contextWindow)}`;
  return "context ?";
}

function statusColor(status: TaskStatus | "idle"): LiveThemeColor {
  switch (status) {
    case "starting":
    case "working":
    case "stopping":
      return "warning";
    case "completed":
      return "success";
    case "question":
    case "blocked":
      return "warning";
    case "failed":
      return "error";
    default:
      return "muted";
  }
}

function toolStatusColor(status: ToolExecutionStatus): LiveThemeColor {
  if (status === "running") return "warning";
  if (status === "completed") return "success";
  return "error";
}

function formatArguments(value: unknown): string {
  if (value === undefined) return "";
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return sanitizeTerminalText(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function wrapWithPrefix(text: string, width: number, prefix: string): string[] {
  const clean = sanitizeTerminalText(text).trim();
  if (!clean) return [];
  const prefixWidth = visibleWidth(prefix);
  const available = Math.max(1, width - prefixWidth);
  const wrapped = wrapTextWithAnsi(clean, available);
  const blank = " ".repeat(prefixWidth);
  return wrapped.map((line, index) => (index === 0 ? prefix : blank) + line);
}

function errorMessage(error: unknown) {
  return sanitizeTerminalText(
    error instanceof Error ? error.message : String(error),
  ).slice(0, 4_096);
}

function readPresentation(
  manager: LiveManager | undefined,
  id: string,
): WorkerPresentation {
  if (!manager) return { transcript: [] };
  try {
    return manager.presentation(id) ?? { transcript: [] };
  } catch {
    return { transcript: [] };
  }
}

// --- Dashboard selection ------------------------------------------------------

export interface DashboardSelection {
  id?: string;
  index: number;
}

/**
 * Keep the selected worker stable by id as the roster changes; fall back to the
 * previous row index when that worker is gone.
 */
export function reconcileDashboardSelection(
  selection: DashboardSelection,
  workers: ReadonlyArray<Pick<WorkerRecord, "id">>,
) {
  const stableIndex = selection.id
    ? workers.findIndex((worker) => worker.id === selection.id)
    : -1;
  selection.index =
    stableIndex >= 0
      ? stableIndex
      : clamp(selection.index, 0, Math.max(0, workers.length - 1));
  selection.id = workers[selection.index]?.id;
}

// --- Frame helpers ------------------------------------------------------------

function separator(width: number, theme: LiveTheme) {
  return theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
}

/**
 * Wrap interior lines in a border. Very narrow widths fall back to plain
 * truncation so every rendered line still fits the supplied width.
 */
function boxed(interior: string[], width: number, theme: LiveTheme): string[] {
  const safeWidth = Math.max(1, Math.floor(width));
  if (safeWidth < 6) {
    return interior.map((line) =>
      truncateToWidth(line.replace(/\n+/g, " "), safeWidth),
    );
  }
  const inner = safeWidth - 4;
  const border = (text: string) => theme.fg("border", text);
  const top = border(`┌${"─".repeat(safeWidth - 2)}┐`);
  const bottom = border(`└${"─".repeat(safeWidth - 2)}┘`);
  const body = interior.map(
    (line) => `${border("│")} ${padTo(line, inner)} ${border("│")}`,
  );
  return [top, ...body, bottom];
}

function fitInterior(interior: string[], height: number) {
  const target = Math.max(1, Math.floor(height));
  if (interior.length > target) return interior.slice(0, target);
  const padded = [...interior];
  while (padded.length < target) padded.push("");
  return padded;
}

function dashboardRowLines(
  worker: WorkerRecord,
  presentation: WorkerPresentation,
  selected: boolean,
  width: number,
  theme: LiveTheme,
): string[] {
  const task = currentTask(worker);
  const status = workerStatus(worker);
  const marker = selected ? theme.fg("accent", "❯") : " ";
  const name = singleLine(worker.name);
  const id = singleLine(worker.id);
  const statusText = theme.fg(
    statusColor(task?.status ?? "idle"),
    `[${status}]`,
  );
  const taskText = task ? ` task ${singleLine(task.id)}` : "";
  const title = selected ? theme.fg("accent", theme.bold(name)) : name;
  const first = `${marker} ${statusText} ${id} "${title}"${theme.fg("muted", taskText)}`;

  const model = singleLine(worker.model);
  const elapsed = task ? formatElapsed(task.startedAt, task.settledAt) : "—";
  const context = formatContextUsage(
    presentation.contextTokens,
    presentation.contextWindow,
  );
  const activity = presentation.activity
    ? singleLine(presentation.activity)
    : worker.unavailableReason
      ? singleLine(worker.unavailableReason)
      : "idle";
  const second = `    ${theme.fg("muted", `${model} · ${worker.reasoning} · ${elapsed} · ${context} · ${activity}`)}`;
  return [truncateToWidth(first, width), truncateToWidth(second, width)];
}

// --- Dashboard ----------------------------------------------------------------

export interface LiveDashboardOptions {
  tui: LiveTui;
  theme: LiveTheme;
  manager?: LiveManager;
  notify?: LiveNotify;
  done(result: DashboardResult | null): void;
}

export class LiveDashboard implements Component {
  readonly tui: LiveTui;
  readonly theme: LiveTheme;
  readonly manager?: LiveManager;
  private readonly notify: LiveNotify;
  private readonly done: (result: DashboardResult | null) => void;
  private readonly unsubscribe?: () => void;
  private readonly ticker?: ReturnType<typeof setInterval>;
  private readonly selection: DashboardSelection = { index: 0 };
  private closed = false;

  constructor(options: LiveDashboardOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.manager = options.manager;
    this.notify = options.notify ?? (() => {});
    this.done = options.done;
    this.unsubscribe = options.manager?.subscribe(() =>
      this.tui.requestRender(),
    );
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.ticker.unref?.();
  }

  get selectedIndex() {
    return this.selection.index;
  }

  get selectedId() {
    return this.selection.id;
  }

  get isClosed() {
    return this.closed;
  }

  private workers(): WorkerRecord[] {
    try {
      return this.manager?.list() ?? [];
    } catch {
      return [];
    }
  }

  private activeCount() {
    try {
      return this.manager?.activeCount() ?? 0;
    } catch {
      return 0;
    }
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    if (this.ticker) clearInterval(this.ticker);
    this.unsubscribe?.();
    return true;
  }

  private close(result: DashboardResult | null) {
    if (this.cleanup()) this.done(result);
  }

  dispose() {
    this.cleanup();
  }

  private move(delta: number) {
    const workers = this.workers();
    if (workers.length === 0) return;
    reconcileDashboardSelection(this.selection, workers);
    this.selection.index = clamp(
      this.selection.index + delta,
      0,
      workers.length - 1,
    );
    this.selection.id = workers[this.selection.index]?.id;
    this.tui.requestRender();
  }

  private async interruptSelected() {
    const workers = this.workers();
    reconcileDashboardSelection(this.selection, workers);
    const worker = workers[this.selection.index];
    if (!worker || !this.manager) return;
    try {
      await this.manager.interrupt(worker.id, true);
      this.notify(`Stop request complete for ${worker.id}.`, "info");
    } catch (error) {
      this.notify(
        `Could not interrupt ${worker.id}: ${errorMessage(error)}`,
        "error",
      );
    }
  }

  handleInput(data: string) {
    if (this.closed) return;
    if (matchesKey(data, Key.escape) || data === "q") {
      this.close(null);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      const workers = this.workers();
      reconcileDashboardSelection(this.selection, workers);
      const worker = workers[this.selection.index];
      if (worker && this.manager)
        this.close({ id: worker.id, takeover: false });
      return;
    }
    if (data === "t" && this.manager) {
      const workers = this.workers();
      reconcileDashboardSelection(this.selection, workers);
      const worker = workers[this.selection.index];
      if (worker) this.close({ id: worker.id, takeover: true });
      return;
    }
    if ((data === "i" || data === "x") && this.manager) {
      void this.interruptSelected();
      return;
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.move(-1);
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.move(1);
      return;
    }
    if (matchesKey(data, Key.home)) {
      const workers = this.workers();
      this.selection.index = 0;
      this.selection.id = workers[0]?.id;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.end)) {
      const workers = this.workers();
      this.selection.index = Math.max(0, workers.length - 1);
      this.selection.id = workers[this.selection.index]?.id;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.move(-5);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.move(5);
    }
  }

  render(width: number): string[] {
    const theme = this.theme;
    const safeWidth = Math.max(1, Math.floor(width));
    const workers = this.workers();
    reconcileDashboardSelection(this.selection, workers);
    const rows = Math.max(6, Math.floor(this.tui.terminal.rows) - 1);
    const interiorHeight = rows - 2;
    const innerWidth = Math.max(1, safeWidth - 4);

    const headerLine = (range?: string) =>
      truncateToWidth(
        `${theme.fg("accent", theme.bold("Subagents"))} ${theme.fg("muted", `· ${this.activeCount()} active · ${workers.length} worker${workers.length === 1 ? "" : "s"}${range ? ` · ${range}` : ""}`)}`,
        safeWidth,
      );
    let header = headerLine();
    const controls = this.manager
      ? "esc close · enter view · t takeover · i interrupt · ↑/↓ select"
      : "esc close";
    const footer = truncateToWidth(theme.fg("dim", `  ${controls}`), safeWidth);

    if (workers.length === 0) {
      const empty = this.manager
        ? [
            theme.fg("muted", "No workers."),
            theme.fg(
              "dim",
              "Start one with subagent_spawn. Workers appear here while they run.",
            ),
          ]
        : [
            theme.fg("warning", "Delegation is disabled or unavailable."),
            theme.fg("dim", "Configure worker models with /subagent-config."),
          ];
      const interior = fitInterior(
        [header, separator(innerWidth, theme), ...empty],
        interiorHeight,
      );
      return boxed(interior, safeWidth, theme);
    }

    const bodyHeight = Math.max(1, interiorHeight - 4);
    const rowHeight = 2;
    const visibleCount = Math.max(1, Math.floor(bodyHeight / rowHeight));
    const start = clamp(
      this.selection.index - Math.floor(visibleCount / 2),
      0,
      Math.max(0, workers.length - visibleCount),
    );
    const visible = workers.slice(start, start + visibleCount);
    if (visibleCount < workers.length)
      header = headerLine(`showing ${start + 1}-${start + visible.length}`);

    const body: string[] = [];
    for (let index = 0; index < visible.length; index++) {
      const worker = visible[index];
      const presentation = readPresentation(this.manager, worker.id);
      body.push(
        ...dashboardRowLines(
          worker,
          presentation,
          start + index === this.selection.index,
          innerWidth,
          theme,
        ),
      );
    }

    const interior = fitInterior(
      [
        header,
        separator(innerWidth, theme),
        ...fitInterior(body, bodyHeight),
        separator(innerWidth, theme),
        footer,
      ],
      interiorHeight,
    );
    return boxed(interior, safeWidth, theme);
  }

  invalidate() {}
}

// --- Worker live view ---------------------------------------------------------

const SCROLL_STEP = 3;

export interface WorkerLiveViewOptions {
  tui: LiveTui;
  theme: LiveTheme;
  manager: LiveManager;
  id: string;
  takeover?: boolean;
  /** Shared flag so the opener can release takeover the view entered. */
  ownership?: { tookOver: boolean };
  notify?: LiveNotify;
  done(result: null): void;
}

export class WorkerLiveView implements Component, Focusable {
  readonly tui: LiveTui;
  readonly theme: LiveTheme;
  readonly manager: LiveManager;
  readonly id: string;
  private readonly notify: LiveNotify;
  private readonly done: (result: null) => void;
  private readonly input = new Input();
  private readonly unsubscribe: () => void;
  private readonly ticker: ReturnType<typeof setInterval>;
  private readonly ownership?: { tookOver: boolean };
  private mode: "view" | "takeover";
  private ownsTakeover = false;
  private following = true;
  private scrollTop = 0;
  private maxScroll = 0;
  private viewport = 1;
  private closed = false;
  private _focused = false;

  constructor(options: WorkerLiveViewOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.manager = options.manager;
    this.id = options.id;
    this.notify = options.notify ?? (() => {});
    this.done = options.done;
    this.ownership = options.ownership;
    this.mode = options.takeover ? "takeover" : "view";
    this.input.onSubmit = (value: string) => this.send(value);
    this.unsubscribe = options.manager.subscribe(() =>
      this.tui.requestRender(),
    );
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.ticker.unref?.();
  }

  get focused() {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  get isTakeover() {
    return this.mode === "takeover";
  }

  get isFollowing() {
    return this.following;
  }

  get isClosed() {
    return this.closed;
  }

  get currentScrollTop() {
    return this.scrollTop;
  }

  private worker(): WorkerRecord | undefined {
    try {
      return this.manager.get(this.id);
    } catch {
      return undefined;
    }
  }

  private presentation(): WorkerPresentation {
    return readPresentation(this.manager, this.id);
  }

  private cleanup() {
    if (this.closed) return false;
    this.closed = true;
    clearInterval(this.ticker);
    this.unsubscribe();
    if (this.ownsTakeover) {
      this.ownsTakeover = false;
      if (this.ownership) this.ownership.tookOver = false;
      try {
        this.manager.endTakeover(this.id);
      } catch {
        // Releasing takeover must never block closing the view.
      }
    }
    // Stop the inline input from retaining focus after the view is disposed.
    this.input.focused = false;
    return true;
  }

  private close() {
    if (this.cleanup()) this.done(null);
  }

  dispose() {
    this.cleanup();
  }

  private enterTakeover() {
    if (this.mode === "takeover") return;
    try {
      this.manager.beginTakeover(this.id);
      this.ownsTakeover = true;
      if (this.ownership) this.ownership.tookOver = true;
      this.mode = "takeover";
      this.input.focused = this._focused;
      this.notify(`Human takeover of ${this.id}.`, "info");
    } catch (error) {
      this.notify(
        `Could not take over ${this.id}: ${errorMessage(error)}`,
        "error",
      );
    }
    this.tui.requestRender();
  }

  private send(value: string) {
    const text = value.trim();
    if (!text) return;
    this.input.setValue("");
    try {
      void Promise.resolve(this.manager.humanSend(this.id, text)).catch(
        (error) => this.notify(errorMessage(error), "error"),
      );
    } catch (error) {
      this.notify(errorMessage(error), "error");
    }
    this.following = true;
    this.tui.requestRender();
  }

  private async interrupt(label?: string) {
    try {
      await this.manager.interrupt(this.id, true);
      this.notify(
        label
          ? `Stop request complete for ${this.id} (${label}).`
          : `Stop request complete for ${this.id}.`,
        "info",
      );
    } catch (error) {
      this.notify(
        `Could not interrupt ${this.id}: ${errorMessage(error)}`,
        "error",
      );
    }
  }

  private scrollBy(delta: number) {
    this.following = false;
    this.scrollTop = clamp(this.scrollTop + delta, 0, this.maxScroll);
    if (this.scrollTop >= this.maxScroll) this.following = true;
    this.tui.requestRender();
  }

  handleInput(data: string) {
    if (this.closed) return;
    if (matchesKey(data, Key.escape)) {
      this.close();
      return;
    }
    // Home/End and the scroll keys stay bound to the transcript even while the
    // inline input is focused; the single-line input does not need them.
    if (matchesKey(data, Key.home)) {
      this.following = false;
      this.scrollTop = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.following = true;
      this.scrollTop = this.maxScroll;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.scrollBy(-SCROLL_STEP);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.scrollBy(SCROLL_STEP);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.scrollBy(-this.viewport);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollBy(this.viewport);
      return;
    }

    if (this.mode === "takeover") {
      // Only modified keys are controls, so ordinary letters (including
      // t/x/q) are always typed into the inline input. A human-initiated
      // interrupt uses the human path so the parent cannot be bypassed.
      if (matchesKey(data, Key.ctrl("x"))) {
        void this.interrupt();
        return;
      }
      if (matchesKey(data, Key.ctrl("t"))) {
        this.close();
        return;
      }
      this.input.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (data === "t") {
      this.enterTakeover();
      return;
    }
    if (data === "q") {
      this.close();
      return;
    }
    if (data === "x") {
      // Read-only inspection may still stop the worker, with an explicit label.
      void this.interrupt("read-only x");
      return;
    }
    if (data === "j") {
      this.scrollBy(SCROLL_STEP);
      return;
    }
    if (data === "k") {
      this.scrollBy(-SCROLL_STEP);
    }
  }

  private buildTranscript(
    worker: WorkerRecord | undefined,
    presentation: WorkerPresentation,
    width: number,
  ): string[] {
    const theme = this.theme;
    const lines: string[] = [];
    const workerId = singleLine(worker?.id ?? this.id);
    const name = singleLine(worker?.name ?? "");
    const task = worker ? currentTask(worker) : undefined;

    const push = (text: string[]) => {
      if (text.length > 0) lines.push(...text);
    };

    for (const item of presentation.transcript) {
      if (lines.length > 0) lines.push("");
      if (item.role === "user") {
        const label =
          item.source === "parent"
            ? `Parent → ${workerId}`
            : item.source === "human"
              ? `Human → ${workerId}`
              : `Instruction → ${workerId}`;
        lines.push(
          truncateToWidth(
            theme.fg("accent", theme.bold(`${label} "${name}"`)),
            width,
          ),
        );
        push(
          wrapWithPrefix(item.text, width, theme.fg("accent", "> ")).map(
            (line) => theme.fg("userMessageText", line),
          ),
        );
      } else if (item.role === "assistant") {
        lines.push(
          truncateToWidth(
            theme.fg(
              "text",
              theme.bold(`${workerId}${name ? ` "${name}"` : ""} · Assistant`),
            ),
            width,
          ),
        );
        const parts: TranscriptPart[] =
          item.parts && item.parts.length > 0
            ? item.parts
            : item.text
              ? [{ type: "text", text: item.text }]
              : [];
        for (const part of parts) {
          if (part.type === "thinking") {
            const thinking = part.redacted
              ? "[redacted reasoning]"
              : `Thinking: ${part.text}`;
            push(
              wrapWithPrefix(thinking, width, theme.fg("dim", "~ ")).map(
                (line) => theme.fg("thinkingText", theme.italic(line)),
              ),
            );
          } else if (part.type === "toolCall") {
            lines.push(
              truncateToWidth(
                theme.fg("toolTitle", `→ ${singleLine(part.name)}`),
                width,
              ),
            );
            const args = formatArguments(part.arguments);
            if (args)
              push(
                wrapWithPrefix(args, width, "  args: ").map((line) =>
                  theme.fg("dim", line),
                ),
              );
          } else {
            push(wrapWithPrefix(part.text, width, ""));
          }
        }
      } else if (item.role === "tool") {
        const failed = item.isError === true || item.status === "failed";
        const label = `tool result${item.toolName ? ` · ${singleLine(item.toolName)}` : ""}`;
        lines.push(
          truncateToWidth(
            theme.fg(
              failed ? "error" : "muted",
              `${failed ? "✗" : "✓"} ${label}`,
            ),
            width,
          ),
        );
        push(
          wrapWithPrefix(item.text, width, "  ").map((line) =>
            theme.fg(failed ? "error" : "toolOutput", line),
          ),
        );
      } else {
        lines.push(
          truncateToWidth(theme.fg("customMessageLabel", "custom"), width),
        );
        push(
          wrapWithPrefix(item.text, width, "  ").map((line) =>
            theme.fg("customMessageText", line),
          ),
        );
      }
    }

    if (presentation.streamingThinking?.trim()) {
      if (lines.length > 0) lines.push("");
      lines.push(
        truncateToWidth(
          theme.fg("dim", `${workerId} · thinking (live)`),
          width,
        ),
      );
      push(
        wrapWithPrefix(
          presentation.streamingThinking,
          width,
          theme.fg("dim", "~ "),
        ).map((line) => theme.fg("thinkingText", theme.italic(line))),
      );
    }

    if (presentation.streamingText?.trim()) {
      if (lines.length > 0) lines.push("");
      lines.push(
        truncateToWidth(theme.fg("text", `${workerId} · live output`), width),
      );
      push(wrapWithPrefix(presentation.streamingText, width, ""));
    }

    // SDK activeTools keeps completed/failed entries for the current run, so
    // skip any live tool whose result already landed in the transcript. This
    // dedupes by toolCallId; a running tool with no transcript result still
    // shows its live status.
    const finalizedToolIds = new Set<string>();
    for (const item of presentation.transcript) {
      if (item.role === "tool" && item.toolCallId)
        finalizedToolIds.add(item.toolCallId);
    }

    for (const tool of presentation.activeTools ?? []) {
      if (finalizedToolIds.has(tool.id)) continue;
      if (lines.length > 0) lines.push("");
      const status = theme.fg(toolStatusColor(tool.status), `[${tool.status}]`);
      lines.push(
        truncateToWidth(
          `${theme.fg("toolTitle", `→ ${singleLine(tool.name)}`)} ${status}`,
          width,
        ),
      );
      const args = formatArguments(tool.arguments);
      if (args)
        push(
          wrapWithPrefix(args, width, "  args: ").map((line) =>
            theme.fg("dim", line),
          ),
        );
      if (tool.result?.trim()) {
        push(
          wrapWithPrefix(tool.result, width, "  result: ").map((line) =>
            theme.fg("toolOutput", line),
          ),
        );
      }
    }

    for (const queued of presentation.queuedMessages ?? []) {
      if (lines.length > 0) lines.push("");
      lines.push(
        truncateToWidth(
          theme.fg("warning", `queued ${singleLine(queued.kind)} · pending`),
          width,
        ),
      );
      push(
        wrapWithPrefix(queued.text, width, "  ").map((line) =>
          theme.fg("muted", line),
        ),
      );
    }

    if (task?.error) {
      if (lines.length > 0) lines.push("");
      lines.push(truncateToWidth(theme.fg("error", "task error"), width));
      push(
        wrapWithPrefix(task.error, width, "  ").map((line) =>
          theme.fg("error", line),
        ),
      );
    }

    if (lines.length === 0) {
      lines.push(theme.fg("dim", "(no output yet)"));
    }
    return lines;
  }

  private headerLines(
    worker: WorkerRecord | undefined,
    presentation: WorkerPresentation,
    width: number,
  ): string[] {
    const theme = this.theme;
    const task = worker ? currentTask(worker) : undefined;
    const status = worker ? workerStatus(worker) : "unavailable";
    const workerId = singleLine(worker?.id ?? this.id);
    const name = singleLine(worker?.name ?? "");
    const modeLabel =
      this.mode === "takeover"
        ? theme.fg("warning", theme.bold("[TAKEOVER]"))
        : "";
    const first = `${modeLabel ? `${modeLabel} ` : ""}${theme.fg(statusColor(task?.status ?? "idle"), `[${status}]`)} ${theme.fg("accent", theme.bold(`${workerId} "${name}"`))}${task ? theme.fg("muted", ` · task ${singleLine(task.id)}`) : ""}`;
    const elapsed = task ? formatElapsed(task.startedAt, task.settledAt) : "—";
    const second = theme.fg(
      "muted",
      `${worker ? singleLine(worker.model) : "?"} · ${worker?.reasoning ?? "?"} · ${elapsed} · ${formatContextUsage(presentation.contextTokens, presentation.contextWindow)}`,
    );
    const lines = [
      truncateToWidth(first, width),
      truncateToWidth(second, width),
    ];
    if (task?.report) {
      const colour = task.report.kind === "fyi" ? "muted" : "warning";
      lines.push(
        truncateToWidth(
          theme.fg(
            colour,
            `${task.report.kind.toUpperCase()}: ${singleLine(task.report.message)}`,
          ),
          width,
        ),
      );
    }
    if (presentation.activity?.trim()) {
      lines.push(
        truncateToWidth(
          theme.fg("muted", `activity: ${singleLine(presentation.activity)}`),
          width,
        ),
      );
    }
    return lines;
  }

  /** Input and essential hints; always kept, even at the smallest height. */
  private essentialFooter(width: number): string[] {
    const theme = this.theme;
    if (this.mode === "takeover") {
      const lines = this.input
        .render(width)
        .map((line) => truncateToWidth(line, width));
      const hints =
        width < 90
          ? [
              "ctrl+x stop · ctrl+t handback",
              "esc close · enter send · home/end",
            ]
          : [
              "esc close · ctrl+x interrupt · ctrl+t handback · enter send · home/end · ↑/↓ scroll",
            ];
      lines.push(
        ...hints.map((hint) => truncateToWidth(theme.fg("dim", hint), width)),
      );
      return lines;
    }
    const follow = this.following ? "following" : "scrolled (end to follow)";
    const hints =
      width < 90
        ? [`read-only · ${follow}`, "esc · t takeover · home/end · ↑/↓"]
        : [
            `read-only · ${follow} · esc close · t take over · x interrupt · home/end · ↑/↓ scroll`,
          ];
    return hints.map((hint) => truncateToWidth(theme.fg("dim", hint), width));
  }

  /** Ownership banner; dropped first when the terminal is short. */
  private bannerLines(width: number): string[] {
    if (this.mode !== "takeover") return [];
    return [
      truncateToWidth(
        this.theme.fg(
          "warning",
          this.theme.bold(
            "Human takeover active — parent cannot steer this worker.",
          ),
        ),
        width,
      ),
    ];
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const worker = this.worker();
    const presentation = this.presentation();
    const rows = Math.max(6, Math.floor(this.tui.terminal.rows) - 1);
    const interiorHeight = rows - 2;
    const innerWidth = Math.max(1, safeWidth - 4);

    // Budget interior rows explicitly. The inline input plus essential hints
    // and one header line are mandatory, so a 12-row terminal still shows the
    // takeover input. The banner, separators, and extra header lines yield
    // before the transcript body does.
    let header = this.headerLines(worker, presentation, innerWidth);
    let banner = this.bannerLines(innerWidth);
    const footer = this.essentialFooter(innerWidth);
    let separators = 2;
    const minBody = 1;
    const used = () =>
      header.length + banner.length + footer.length + separators;
    while (used() + minBody > interiorHeight) {
      if (banner.length > 0) banner = [];
      else if (separators > 0) separators = 0;
      else if (header.length > 1) header = header.slice(0, -1);
      else break;
    }
    const viewport = Math.max(1, interiorHeight - used());
    this.viewport = viewport;

    const transcript = this.buildTranscript(worker, presentation, innerWidth);
    this.maxScroll = Math.max(0, transcript.length - viewport);
    if (this.following) this.scrollTop = this.maxScroll;
    else this.scrollTop = clamp(this.scrollTop, 0, this.maxScroll);

    const visible = transcript.slice(this.scrollTop, this.scrollTop + viewport);
    const body = fitInterior(visible, viewport);

    const parts = [...header];
    if (separators > 0) parts.push(separator(innerWidth, this.theme));
    parts.push(...body);
    if (separators > 0) parts.push(separator(innerWidth, this.theme));
    parts.push(...banner, ...footer);

    return boxed(fitInterior(parts, interiorHeight), safeWidth, this.theme);
  }

  invalidate() {
    this.input.invalidate();
  }
}

// --- Entry points -------------------------------------------------------------

export async function openWorkerView(
  ctx: ExtensionCommandContext,
  manager: LiveManager,
  id: string,
  takeover: boolean,
  notify?: LiveNotify,
): Promise<void> {
  const ownership = { tookOver: false };
  if (takeover) {
    try {
      manager.beginTakeover(id);
      ownership.tookOver = true;
    } catch (error) {
      notify?.(`Could not take over ${id}: ${errorMessage(error)}`, "error");
      return;
    }
  }
  try {
    await ctx.ui.custom<null>(
      (tui, theme, _keybindings, done) =>
        new WorkerLiveView({
          tui,
          theme,
          manager,
          id,
          takeover,
          ownership,
          notify,
          done,
        }),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "100%",
          maxHeight: "100%",
        },
      },
    );
  } finally {
    // Esc/back, an error, an aborted overlay, or a takeover entered from the
    // read-only view must all release ownership. The shared flag is only set
    // while this interaction owns takeover, so plain viewing never calls it.
    if (ownership.tookOver) {
      ownership.tookOver = false;
      try {
        manager.endTakeover(id);
      } catch {
        // Releasing takeover must never mask the original failure.
      }
    }
  }
}

export async function openDashboard(options: {
  ctx: ExtensionCommandContext;
  manager?: LiveManager;
}): Promise<void> {
  const { ctx, manager } = options;
  if (ctx.mode !== "tui") {
    if (ctx.hasUI)
      ctx.ui.notify(
        "The live worker dashboard is available in the TUI.",
        "warning",
      );
    return;
  }
  const notify: LiveNotify = (message, type = "info") =>
    ctx.ui.notify(sanitizeTerminalText(message).slice(0, 4_096), type);

  while (true) {
    const result = await ctx.ui.custom<DashboardResult | null>(
      (tui, theme, _keybindings, done) =>
        new LiveDashboard({ tui, theme, manager, notify, done }),
      {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "100%",
          maxHeight: "100%",
        },
      },
    );
    if (!result || !manager) return;
    await openWorkerView(ctx, manager, result.id, result.takeover, notify);
  }
}
