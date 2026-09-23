import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  LiveDashboard,
  WorkerLiveView,
  formatContextUsage,
  formatElapsed,
  openWorkerView,
  reconcileDashboardSelection,
  type DashboardResult,
  type DashboardSelection,
  type LiveManager,
  type LiveTheme,
  type LiveTui,
} from "./src/live-ui.ts";
import type {
  SessionTranscriptItem,
  WorkerPresentation,
  WorkerRecord,
  WorkerTask,
} from "./src/types.ts";

const KEY = {
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  home: "\x1b[H",
  end: "\x1b[F",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  enter: "\r",
  ctrlX: "\x18",
  ctrlT: "\x14",
} as const;

const theme: LiveTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
};

function fakeTui(rows = 24) {
  const tui = {
    renders: 0,
    requestRender() {
      tui.renders += 1;
    },
    terminal: { rows },
  };
  return tui;
}

class FakeManager implements LiveManager {
  workers: WorkerRecord[] = [];
  presentations = new Map<string, WorkerPresentation>();
  listeners = new Set<() => void>();
  beginCalls: string[] = [];
  endCalls: string[] = [];
  sent: Array<{ id: string; message: string }> = [];
  interrupts: string[] = [];
  failBegin: string | undefined;

  list() {
    return this.workers;
  }

  get(id: string) {
    return this.workers.find((worker) => worker.id === id);
  }

  activeCount() {
    return this.workers.filter((worker) => {
      const status = worker.tasks.find(
        (task) => task.id === worker.currentTaskId,
      )?.status;
      return (
        status === "starting" || status === "working" || status === "stopping"
      );
    }).length;
  }

  presentation(id: string) {
    return this.presentations.get(id) ?? { transcript: [] };
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  beginTakeover(id: string) {
    if (this.failBegin) throw new Error(this.failBegin);
    this.beginCalls.push(id);
  }

  endTakeover(id: string) {
    this.endCalls.push(id);
  }

  humanSend(id: string, message: string) {
    this.sent.push({ id, message });
  }

  interrupt(id: string) {
    this.interrupts.push(id);
    return Promise.resolve();
  }

  emit() {
    for (const listener of [...this.listeners]) listener();
  }
}

function makeWorker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  const id = overrides.id ?? "sa-1";
  const taskId = overrides.currentTaskId ?? `${id}-t1`;
  const task: WorkerTask = {
    id: taskId,
    brief: "do the thing",
    status: "working",
    startedAt: Date.now() - 5_000,
  };
  return {
    id,
    name: "alpha",
    cwd: "/tmp/work",
    model: "fake/model",
    reasoning: "low",
    createdAt: 0,
    updatedAt: 0,
    takenOver: false,
    currentTaskId: taskId,
    tasks: [task],
    ...overrides,
  };
}

function lineList(lines: string[]) {
  return lines.join("\n");
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function makeView(
  manager: FakeManager,
  options: {
    id?: string;
    takeover?: boolean;
    rows?: number;
    done?: () => void;
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
  } = {},
) {
  return new WorkerLiveView({
    tui: fakeTui(options.rows ?? 24),
    theme,
    manager,
    id: options.id ?? "sa-1",
    takeover: options.takeover,
    done: options.done ?? (() => {}),
    notify: options.notify,
  });
}

// --- Pure formatting ----------------------------------------------------------

test("formatElapsed and formatContextUsage render compact, explicit text", () => {
  assert.equal(formatElapsed(Date.now() - 5_000), "5s");
  assert.equal(formatElapsed(0, 65_000), "1m 05s");
  assert.equal(formatContextUsage(12_300, 128_000), "12.3k/128.0k (10%)");
  assert.equal(formatContextUsage(500), "500 tokens");
  assert.equal(formatContextUsage(undefined, 8_000), "window 8.0k");
  assert.equal(formatContextUsage(), "context ?");
});

// --- Dashboard ----------------------------------------------------------------

test("dashboard selection follows its worker id and falls back by row", () => {
  const selection: DashboardSelection = { id: "sa-7", index: 6 };
  reconcileDashboardSelection(selection, [
    { id: "sa-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `sa-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "sa-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sa-${index + 1}` })),
    { id: "sa-8" },
    { id: "sa-9" },
  ]);
  assert.deepEqual(selection, { id: "sa-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "sa-1" }, { id: "sa-2" }]);
  assert.deepEqual(selection, { id: "sa-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});

test("dashboard shows stable names, task, status, model, reasoning, elapsed, context and activity", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  manager.presentations.set("sa-1", {
    transcript: [],
    contextTokens: 12_300,
    contextWindow: 128_000,
    activity: "reading src/ui.ts",
  });
  const dashboard = new LiveDashboard({
    tui: fakeTui(30),
    theme,
    manager,
    done: () => {},
  });
  const text = lineList(dashboard.render(80));
  assert.match(text, /sa-1/);
  assert.match(text, /alpha/);
  assert.match(text, /sa-1-t1/);
  assert.match(text, /\[working\]/);
  assert.match(text, /fake\/model/);
  assert.match(text, /low/);
  assert.match(text, /12\.3k\/128\.0k \(10%\)/);
  assert.match(text, /reading src\/ui\.ts/);
  assert.match(text, /1 active · 1 worker/);
  dashboard.dispose();
});

test("dashboard renders disabled and empty states gracefully", () => {
  const empty = new LiveDashboard({
    tui: fakeTui(20),
    theme,
    manager: new FakeManager(),
    done: () => {},
  });
  assert.match(lineList(empty.render(50)), /No workers/);
  empty.dispose();

  const disabled = new LiveDashboard({
    tui: fakeTui(20),
    theme,
    done: () => {},
  });
  assert.match(
    lineList(disabled.render(50)),
    /Delegation is disabled or unavailable/,
  );
  disabled.dispose();
});

test("dashboard enter opens a read-only view and t requests takeover", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];

  let result: DashboardResult | null | undefined;
  const view = new LiveDashboard({
    tui: fakeTui(20),
    theme,
    manager,
    done: (value) => {
      result = value;
    },
  });
  view.handleInput(KEY.enter);
  assert.deepEqual(result, { id: "sa-1", takeover: false });
  assert.equal(view.isClosed, true);

  let takeoverResult: DashboardResult | null | undefined;
  const take = new LiveDashboard({
    tui: fakeTui(20),
    theme,
    manager,
    done: (value) => {
      takeoverResult = value;
    },
  });
  take.handleInput("t");
  assert.deepEqual(takeoverResult, { id: "sa-1", takeover: true });
  take.dispose();
});

test("dashboard subscribe and ticker are torn down on close and dispose", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  const tui = fakeTui(20);
  const dashboard = new LiveDashboard({ tui, theme, manager, done: () => {} });
  assert.equal(manager.listeners.size, 1);

  manager.emit();
  assert.ok(tui.renders >= 1, "presentation updates request a render");

  dashboard.dispose();
  assert.equal(manager.listeners.size, 0);
  assert.equal(dashboard.isClosed, true);
  dashboard.dispose();
  assert.equal(manager.listeners.size, 0);
});

test("closed dashboard ignores late input", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  let calls = 0;
  const dashboard = new LiveDashboard({
    tui: fakeTui(20),
    theme,
    manager,
    done: () => {
      calls += 1;
    },
  });
  dashboard.handleInput(KEY.escape);
  assert.equal(calls, 1);
  dashboard.handleInput(KEY.escape);
  dashboard.handleInput("t");
  dashboard.handleInput(KEY.enter);
  assert.equal(calls, 1);
  assert.deepEqual(manager.beginCalls, []);
});

test("dashboard interrupt only touches the selected worker", async () => {
  const manager = new FakeManager();
  manager.workers = [
    makeWorker({ id: "sa-1" }),
    makeWorker({ id: "sa-2", currentTaskId: "sa-2-t1" }),
  ];
  const notes: string[] = [];
  const dashboard = new LiveDashboard({
    tui: fakeTui(20),
    theme,
    manager,
    notify: (message) => notes.push(message),
    done: () => {},
  });
  dashboard.handleInput(KEY.down);
  dashboard.handleInput("i");
  assert.deepEqual(manager.interrupts, ["sa-2"]);
  await tick();
  assert.ok(
    notes.some((note) => note.includes("Stop request complete for sa-2")),
    notes.join(" | "),
  );
  dashboard.dispose();
});

// --- Worker view: read-only vs takeover ---------------------------------------

test("worker view is read-only until t explicitly takes over", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  const view = makeView(manager);
  assert.equal(view.isTakeover, false);
  assert.deepEqual(manager.beginCalls, []);

  // Typing and Enter in read-only mode must not send or take over.
  for (const character of "hello") view.handleInput(character);
  view.handleInput(KEY.enter);
  assert.deepEqual(manager.sent, []);
  assert.deepEqual(manager.beginCalls, []);

  view.handleInput("t");
  assert.equal(view.isTakeover, true);
  assert.deepEqual(manager.beginCalls, ["sa-1"]);

  view.dispose();
  assert.deepEqual(manager.endCalls, ["sa-1"]);
});

test("takeover input sends a human message and ctrl+x interrupts", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  const view = makeView(manager, { takeover: true });
  assert.equal(view.isTakeover, true);

  for (const character of "hello") view.handleInput(character);
  view.handleInput(KEY.enter);
  assert.deepEqual(manager.sent, [{ id: "sa-1", message: "hello" }]);

  view.handleInput(KEY.ctrlX);
  assert.deepEqual(manager.interrupts, ["sa-1"]);

  view.dispose();
});

test("ctrl+t hands back and closes a takeover view", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  const view = makeView(manager);
  view.handleInput("t");
  assert.deepEqual(manager.beginCalls, ["sa-1"]);
  view.handleInput(KEY.ctrlT);
  assert.equal(view.isClosed, true);
  assert.deepEqual(manager.endCalls, ["sa-1"]);
});

test("takeover input keeps printable t, x, q and i as text", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  const view = makeView(manager, { takeover: true });
  for (const character of "txqi") view.handleInput(character);
  view.handleInput(KEY.enter);
  assert.deepEqual(manager.sent, [{ id: "sa-1", message: "txqi" }]);
  assert.deepEqual(manager.interrupts, []);
  view.dispose();
});

test("read-only x interrupts the worker with an explicit human action", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  const view = makeView(manager);
  view.handleInput("x");
  assert.deepEqual(manager.interrupts, ["sa-1"]);
  assert.deepEqual(manager.beginCalls, []);
  view.dispose();
});

test("esc closes a takeover view and releases ownership", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  const view = makeView(manager);
  view.handleInput("t");
  assert.deepEqual(manager.beginCalls, ["sa-1"]);
  view.handleInput(KEY.escape);
  assert.equal(view.isClosed, true);
  assert.deepEqual(manager.endCalls, ["sa-1"]);
});

test("worker view subscribe is torn down on close", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  const view = makeView(manager);
  assert.equal(manager.listeners.size, 1);
  view.dispose();
  assert.equal(manager.listeners.size, 0);
});

// --- Scrolling / follow -------------------------------------------------------

test("scroll position is preserved when not following and Home/End jump", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  const transcript: SessionTranscriptItem[] = Array.from(
    { length: 60 },
    (_, index) => ({ role: "assistant", text: `line ${index}` }),
  );
  manager.presentations.set("sa-1", { transcript });
  const view = makeView(manager, { rows: 16 });

  view.render(60);
  assert.equal(view.isFollowing, true);
  const bottom = view.currentScrollTop;
  assert.ok(bottom > 0, "long transcript starts pinned to the bottom");

  view.handleInput(KEY.up);
  assert.equal(view.isFollowing, false);
  const scrolled = view.currentScrollTop;
  assert.ok(scrolled < bottom);

  // Appending while scrolled must not yank the viewport back to the bottom.
  manager.presentations.set("sa-1", {
    transcript: [
      ...transcript,
      ...Array.from({ length: 10 }, (_, index) => ({
        role: "assistant" as const,
        text: `new ${index}`,
      })),
    ],
  });
  view.render(60);
  assert.equal(view.currentScrollTop, scrolled);

  view.handleInput(KEY.home);
  assert.equal(view.currentScrollTop, 0);
  assert.equal(view.isFollowing, false);

  view.handleInput(KEY.end);
  assert.equal(view.isFollowing, true);
  view.render(60);
  assert.equal(view.currentScrollTop, view.currentScrollTop);

  view.dispose();
});

test("page keys move by a viewport and return to follow at the bottom", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  manager.presentations.set("sa-1", {
    transcript: Array.from({ length: 80 }, (_, index) => ({
      role: "assistant" as const,
      text: `line ${index}`,
    })),
  });
  const view = makeView(manager, { rows: 20 });
  view.render(60);
  view.handleInput(KEY.pageUp);
  assert.equal(view.isFollowing, false);
  view.handleInput(KEY.pageDown);
  assert.equal(view.isFollowing, true);
  view.dispose();
});

// --- Transcript content -------------------------------------------------------

test("transcript renders explicit direction labels and structured parts", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  manager.presentations.set("sa-1", {
    transcript: [
      { role: "user", text: "do it" },
      { role: "user", text: "from parent", source: "parent" },
      { role: "user", text: "from human", source: "human" },
      {
        role: "assistant",
        text: "",
        parts: [
          { type: "thinking", text: "considering options" },
          {
            type: "toolCall",
            id: "t1",
            name: "read",
            arguments: { path: "x" },
          },
          { type: "text", text: "finished" },
        ],
      },
      {
        role: "tool",
        text: "file contents",
        toolName: "read",
        status: "completed",
      },
      {
        role: "tool",
        text: "boom",
        toolName: "bash",
        isError: true,
      },
    ],
    streamingThinking: "live thought",
    streamingText: "live text",
    activeTools: [
      { id: "t2", name: "bash", arguments: "ls -la", status: "running" },
    ],
    queuedMessages: [{ kind: "steer", text: "please hurry" }],
  });
  const view = makeView(manager, { rows: 200 });
  const text = lineList(view.render(100));
  assert.match(text, /Instruction → sa-1/);
  assert.match(text, /Parent → sa-1/);
  assert.match(text, /Human → sa-1/);
  assert.match(text, /sa-1 "alpha" · Assistant/);
  assert.match(text, /live output/);
  assert.doesNotMatch(text, /→ Parent/);
  assert.match(text, /considering options/);
  assert.match(text, /read/);
  assert.match(text, /finished/);
  assert.match(text, /file contents/);
  assert.match(text, /boom/);
  assert.match(text, /live thought/);
  assert.match(text, /live text/);
  assert.match(text, /bash/);
  assert.match(text, /queued steer/);
  assert.match(text, /please hurry/);
  view.dispose();
});

test("live tools whose result is already in the transcript are not duplicated", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  manager.presentations.set("sa-1", {
    transcript: [
      {
        role: "assistant",
        text: "",
        parts: [{ type: "toolCall", id: "t1", name: "read" }],
      },
      {
        role: "tool",
        text: "RESULT_FROM_TRANSCRIPT",
        toolName: "read",
        toolCallId: "t1",
        status: "completed",
      },
    ],
    activeTools: [
      {
        id: "t1",
        name: "read",
        status: "completed",
        result: "LIVE_RESULT_DUPLICATE",
      },
      { id: "t2", name: "bash", status: "running" },
    ],
  });
  const view = makeView(manager, { rows: 200 });
  const text = lineList(view.render(100));
  assert.match(text, /RESULT_FROM_TRANSCRIPT/);
  assert.doesNotMatch(text, /LIVE_RESULT_DUPLICATE/);
  assert.match(text, /bash/);
  view.dispose();
});

test("redacted thinking shows a marker and never the signature text", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  manager.presentations.set("sa-1", {
    transcript: [
      {
        role: "assistant",
        text: "visible answer",
        parts: [
          { type: "thinking", text: "SECRET_SIGNATURE", redacted: true },
          { type: "text", text: "visible answer" },
        ],
      },
    ],
  });
  const view = makeView(manager, { rows: 200 });
  const text = lineList(view.render(100));
  assert.match(text, /\[redacted reasoning\]/);
  assert.doesNotMatch(text, /SECRET_SIGNATURE/);
  assert.match(text, /visible answer/);
  view.dispose();
});

test("tool arguments wrap below the header instead of being truncated", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  const tail = "ARG_TAIL_SENTINEL";
  manager.presentations.set("sa-1", {
    transcript: [
      {
        role: "assistant",
        text: "",
        parts: [
          {
            type: "toolCall",
            id: "t1",
            name: "read",
            arguments: { path: `/very/long/path/${tail}` },
          },
        ],
      },
    ],
    activeTools: [
      {
        id: "t2",
        name: "bash",
        arguments: { command: `echo ${tail}` },
        status: "running",
        result: `output ${tail}`,
      },
    ],
  });
  const view = makeView(manager, { rows: 200 });
  const text = lineList(view.render(40));
  // The tail survives wrapping for both settled and active tool calls.
  assert.match(text, /ARG_TAIL_SENTINEL/);
  assert.match(text, /args:/);
  assert.match(text, /result:/);
  view.dispose();
});

test("closed worker view ignores late input", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  const view = makeView(manager);
  view.handleInput("t");
  view.handleInput(KEY.escape);
  assert.equal(view.isClosed, true);
  assert.deepEqual(manager.endCalls, ["sa-1"]);
  // A queued key after dispose must not send, interrupt, or re-enter takeover.
  for (const character of "late") view.handleInput(character);
  view.handleInput(KEY.enter);
  view.handleInput(KEY.ctrlX);
  assert.deepEqual(manager.sent, []);
  assert.deepEqual(manager.interrupts, []);
  assert.deepEqual(manager.beginCalls, ["sa-1"]);
});

test("dashboard keeps a near-bottom selection visible at 12 rows", () => {
  const manager = new FakeManager();
  manager.workers = Array.from({ length: 10 }, (_, index) =>
    makeWorker({ id: `sa-${index + 1}`, currentTaskId: `sa-${index + 1}-t1` }),
  );
  const dashboard = new LiveDashboard({
    tui: fakeTui(12),
    theme,
    manager,
    done: () => {},
  });
  dashboard.handleInput(KEY.end);
  const lines = dashboard.render(60);
  const text = lineList(lines);
  assert.ok(lines.length <= 11, `rendered ${lines.length} lines for 12 rows`);
  assert.match(text, /sa-10/);
  assert.match(text, /sa-9/);
  assert.match(text, /esc close/);
  assert.doesNotMatch(text, /sa-1 "/);
  dashboard.dispose();
});

test("interrupt acknowledgement reports a stop request, not a completed interrupt", async () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  const notes: string[] = [];
  const view = makeView(manager, {
    takeover: true,
    notify: (message) => notes.push(message),
  });
  view.handleInput(KEY.ctrlX);
  await tick();
  assert.ok(
    notes.some((note) => note.includes("Stop request complete for sa-1")),
    notes.join(" | "),
  );
  assert.ok(!notes.some((note) => note.startsWith("Interrupted")));
  view.dispose();
});

test("multiline worker metadata never injects extra terminal rows", () => {
  const manager = new FakeManager();
  const worker = makeWorker({ name: "alpha\nbeta", model: "fake\nmodel" });
  worker.tasks[0].report = {
    kind: "question",
    message: "line one\nline two",
    at: 0,
  };
  manager.workers = [worker];
  manager.presentations.set("sa-1", {
    transcript: [],
    activity: "reading\nwriting",
  });

  const dashboard = new LiveDashboard({
    tui: fakeTui(24),
    theme,
    manager,
    done: () => {},
  });
  const view = makeView(manager, { rows: 24 });
  const dashboardLines = dashboard.render(80);
  const viewLines = view.render(80);

  for (const lines of [dashboardLines, viewLines]) {
    for (const line of lines) {
      assert.doesNotMatch(
        line,
        /\n/,
        `embedded LF in row: ${JSON.stringify(line)}`,
      );
    }
    assert.match(lineList(lines), /alpha beta/);
    assert.match(lineList(lines), /fake model/);
  }
  assert.match(lineList(dashboardLines), /reading writing/);
  assert.match(lineList(viewLines), /line one line two/);
  assert.match(lineList(viewLines), /reading writing/);

  dashboard.dispose();
  view.dispose();
});

test("takeover at 12x40 keeps ownership, input and essential hints", () => {
  const manager = new FakeManager();
  manager.workers = [
    makeWorker({ name: "A long worker name must not hide ownership" }),
  ];
  manager.presentations.set("sa-1", {
    transcript: [{ role: "assistant", text: "some output" }],
    activity: "working",
  });
  const view = makeView(manager, { takeover: true, rows: 12 });
  const lines = view.render(40);
  const text = lineList(lines);
  assert.ok(lines.length <= 11, `rendered ${lines.length} lines for 12 rows`);
  assert.match(text, /sa-1/);
  assert.match(text, /\[TAKEOVER\]/);
  assert.match(text, /esc close/);
  assert.match(text, /ctrl\+x stop/);
  assert.match(text, /ctrl\+t handback/);
  assert.match(text, /home\/end/);
  view.dispose();
});

test("takeover view shows an obvious ownership banner and inline input", () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  const view = makeView(manager, { takeover: true, rows: 30 });
  const text = lineList(view.render(80));
  assert.match(text, /\[TAKEOVER\]/);
  assert.match(text, /Human takeover active/);
  assert.match(text, /handback/);
  view.dispose();
});

// --- Narrow dimensions --------------------------------------------------------

test("both views keep every line within very narrow widths", () => {
  const manager = new FakeManager();
  manager.workers = [
    makeWorker({ name: "a".repeat(60), model: "very/long-model-name" }),
  ];
  manager.presentations.set("sa-1", {
    transcript: [
      { role: "user", text: "hello world ".repeat(20) },
      {
        role: "assistant",
        text: "assistant text ".repeat(20),
        parts: [
          { type: "thinking", text: "thought ".repeat(20) },
          { type: "toolCall", id: "t1", name: "read", arguments: { a: 1 } },
        ],
      },
    ],
    streamingText: "x".repeat(200),
    streamingThinking: "y".repeat(200),
    activeTools: [
      { id: "t", name: "bash", arguments: { cmd: "ls" }, status: "running" },
    ],
    queuedMessages: [{ kind: "followup", text: "later ".repeat(20) }],
    contextTokens: 1,
    contextWindow: 2,
    activity: "busy ".repeat(20),
  });

  const dashboard = new LiveDashboard({
    tui: fakeTui(24),
    theme,
    manager,
    done: () => {},
  });
  const readOnly = makeView(manager, { rows: 24 });
  const takeover = makeView(manager, { takeover: true, rows: 24 });

  for (const width of [1, 2, 3, 4, 5, 8, 12, 20, 40]) {
    for (const line of dashboard.render(width)) {
      assert.ok(
        visibleWidth(line) <= width,
        `dashboard width ${width} overflowed: ${JSON.stringify(line)}`,
      );
    }
    for (const line of readOnly.render(width)) {
      assert.ok(
        visibleWidth(line) <= width,
        `view width ${width} overflowed: ${JSON.stringify(line)}`,
      );
    }
    for (const line of takeover.render(width)) {
      assert.ok(
        visibleWidth(line) <= width,
        `takeover width ${width} overflowed: ${JSON.stringify(line)}`,
      );
    }
  }
  dashboard.dispose();
  readOnly.dispose();
  takeover.dispose();
});

// --- openWorkerView takeover lifecycle ----------------------------------------

test("openWorkerView releases takeover in finally when the overlay fails", async () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  const failing = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify() {},
      custom: () => Promise.reject(new Error("overlay failed")),
    },
  } as unknown as ExtensionCommandContext;

  await assert.rejects(() => openWorkerView(failing, manager, "sa-1", true));
  assert.deepEqual(manager.beginCalls, ["sa-1"]);
  assert.deepEqual(manager.endCalls, ["sa-1"]);
});

test("openWorkerView releases takeover the view entered when the overlay fails", async () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify() {},
      custom: (
        factory: (
          tui: LiveTui,
          t: LiveTheme,
          kb: unknown,
          done: (r: null) => void,
        ) => { handleInput(data: string): void },
      ) =>
        new Promise((_resolve, reject) => {
          const component = factory(fakeTui(24), theme, {}, () => {});
          component.handleInput("t");
          reject(new Error("overlay failed"));
        }),
    },
  } as unknown as ExtensionCommandContext;

  await assert.rejects(() => openWorkerView(ctx, manager, "sa-1", false));
  assert.deepEqual(manager.beginCalls, ["sa-1"]);
  assert.deepEqual(manager.endCalls, ["sa-1"]);
});

test("openWorkerView read-only mode never begins or ends takeover", async () => {
  const manager = new FakeManager();
  manager.workers = [makeWorker()];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify() {},
      custom: (
        factory: (
          tui: LiveTui,
          t: LiveTheme,
          kb: unknown,
          done: (r: null) => void,
        ) => { handleInput(data: string): void },
      ) =>
        new Promise((resolve) => {
          const component = factory(fakeTui(24), theme, {}, (result) =>
            resolve(result),
          );
          component.handleInput(KEY.escape);
        }),
    },
  } as unknown as ExtensionCommandContext;

  await openWorkerView(ctx, manager, "sa-1", false);
  assert.deepEqual(manager.beginCalls, []);
  assert.deepEqual(manager.endCalls, []);
  assert.equal(manager.listeners.size, 0);
});
