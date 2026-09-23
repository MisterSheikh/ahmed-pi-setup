/**
 * Independent boundary tests for the Subagents V2 Pi extension.
 *
 * These tests drive the public extension surface only: `registerTool`,
 * `registerCommand`, `on(...)` hooks, active-tool synchronization, config
 * persistence, owner/branch guards, and the deferred result/FYI delivery path.
 * They use fake `ExtensionAPI`/`ExtensionContext` objects and never touch the
 * real Pi state.
 *
 * Isolation:
 * - `PI_CODING_AGENT_DIR` points at a throwaway temp directory before
 *   `index.ts` is imported, so `CONFIG_PATH` resolves inside it.
 * - `PiWorkerSessionFactory.prototype.create`/`readTranscript` are replaced
 *   with an in-memory fake for the delivery/FYI tests. No provider, session,
 *   or model-call code runs.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionUIContext,
  ModelRegistry,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createDeferredDelivery } from "./src/delivery.ts";
import { LiveDashboard } from "./src/live-ui.ts";
import type {
  ConfigPicker,
  ConfigPickerTheme,
  ConfigPickerTui,
} from "./src/config-picker.ts";
import type { TaskResult } from "./src/manager.ts";
import { PiWorkerSessionFactory } from "./src/pi-session.ts";
import { STATE_ENTRY_TYPE } from "./src/state.ts";
import type {
  SessionTranscriptItem,
  SubagentsConfig,
  WorkerRecord,
  WorkerSession,
  WorkerSessionCallbacks,
  WorkerTask,
} from "./src/types.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "subagents-v2-boundary-"),
);
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: subagentsV2 } = await import("./index.ts");

const CONFIG_FILE = path.join(agentDir, "subagents-v2", "config.json");

const SUBAGENT_TOOL_NAMES = [
  "subagent_spawn",
  "subagent_followup",
  "subagent_steer",
  "subagent_interrupt",
  "subagent_wait",
  "subagent_list",
] as const;

const ENABLED_CONFIG: SubagentsConfig = {
  version: 2,
  enabled: true,
  allowedModels: ["fake/model", "fake/other"],
  modelReasoning: {
    "fake/model": { allowed: ["low", "medium"], default: "low" },
    "fake/other": { allowed: ["high"], default: "high" },
  },
  defaultModel: "fake/model",
  maxActive: 4,
};

const fakeModel = {
  provider: "fake",
  id: "model",
  reasoning: true,
} as unknown as Model<never>;

const fakeOtherModel = {
  provider: "fake",
  id: "other",
  reasoning: true,
} as unknown as Model<never>;

function fakeRegistry(
  models: readonly Model<never>[] = [fakeModel],
): ModelRegistry {
  return {
    find: (provider: string, id: string) =>
      models.find((model) => model.provider === provider && model.id === id),
    getAvailable: () => [...models],
  } as unknown as ModelRegistry;
}

function writeConfig(config: SubagentsConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

// ---------------------------------------------------------------------------
// Fake ExtensionAPI / UI / context
// ---------------------------------------------------------------------------

interface SelectStep {
  title: string;
  value: string | undefined;
}

/**
 * The config popup is now a `ctx.ui.custom` overlay rather than a chain of
 * `ui.select` prompts. Tests capture the factory passed to `ui.custom`, build
 * the picker with a fake TUI/theme, and drive it with raw key sequences.
 */
type PickerFactory = (
  tui: ConfigPickerTui,
  theme: ConfigPickerTheme,
  keybindings: unknown,
  done: (value?: unknown) => void,
) => unknown;

const fakeTui: ConfigPickerTui = {
  requestRender: () => {},
  terminal: { rows: 24 },
};
const fakeTheme: ConfigPickerTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

/**
 * Minimal theme for the communication and tool renderers. Only `fg`, `bold`,
 * `italic`, `underline`, and `strikethrough` are used by the renderers under
 * test; the cast bridges the wider host `Theme` type.
 */
const renderTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

type StoredMessageRenderer = (
  message: { content?: unknown; details?: unknown },
  options: { expanded: boolean; outputPad?: number },
  theme: Theme,
) => { render(width: number): string[] } | undefined;

function rendered(component: { render(width: number): string[] }): string {
  return component.render(200).join("\n");
}

const PICKER_KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  escape: "\x1b",
  space: " ",
  d: "d",
} as const;

async function drive(
  picker: ConfigPicker<SubagentsConfig>,
  keys: Array<keyof typeof PICKER_KEYS>,
): Promise<void> {
  for (const key of keys) {
    picker.handleInput(PICKER_KEYS[key]);
    await picker.flush();
  }
}

class ScriptedUI {
  readonly notifies: Array<{
    message: string;
    type?: "info" | "warning" | "error";
  }> = [];
  readonly statuses: Array<{ key: string; text: string | undefined }> = [];
  readonly selectTitles: string[] = [];
  picker?: ConfigPicker<SubagentsConfig>;
  dashboard?: LiveDashboard;
  customCalls = 0;
  private steps: SelectStep[] = [];
  private stepIndex = 0;

  script(steps: SelectStep[]): void {
    this.steps = steps;
    this.stepIndex = 0;
  }

  async select(title: string): Promise<string | undefined> {
    this.selectTitles.push(title);
    const step = this.steps[this.stepIndex];
    if (!step)
      throw new Error(
        `Unexpected select at step ${this.stepIndex}: "${title}"`,
      );
    if (step.title !== title) {
      throw new Error(
        `Select step ${this.stepIndex} expected "${step.title}" but got "${title}".`,
      );
    }
    this.stepIndex += 1;
    return step.value;
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
    this.notifies.push({ message, type });
  }

  setStatus(key: string, text: string | undefined): void {
    this.statuses.push({ key, text });
  }

  async editor(): Promise<string | undefined> {
    return undefined;
  }

  async input(): Promise<string | undefined> {
    return undefined;
  }

  async custom<T>(factory: unknown, _options?: unknown): Promise<T> {
    this.customCalls++;
    this.picker = undefined;
    this.dashboard = undefined;
    return new Promise<T>((resolve) => {
      const component: unknown = (factory as PickerFactory)(
        fakeTui,
        fakeTheme,
        undefined,
        (value?: unknown) => resolve(value as T),
      );
      if (component instanceof LiveDashboard) this.dashboard = component;
      else this.picker = component as ConfigPicker<SubagentsConfig>;
    });
  }
}

type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => Promise<void>;
type AnyHandler = (event: unknown, ctx: unknown) => unknown;

class FakePi {
  readonly tools = new Map<string, ToolDefinition>();
  readonly commands = new Map<string, { handler: CommandHandler }>();
  readonly messageRenderers = new Map<string, StoredMessageRenderer>();
  readonly handlers = new Map<string, AnyHandler[]>();
  readonly activeToolSets: string[][] = [];
  readonly entries: Array<{ customType: string; data: unknown }> = [];
  readonly sendMessages: Array<{ message: unknown; options: unknown }> = [];
  private active = ["read", "bash"];

  readonly api = {
    on: (event: string, handler: AnyHandler) => {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return () => {};
    },
    registerTool: (tool: ToolDefinition) => {
      this.tools.set(tool.name, tool);
    },
    registerCommand: (name: string, options: { handler: CommandHandler }) => {
      this.commands.set(name, options);
    },
    registerMessageRenderer: (
      customType: string,
      renderer: StoredMessageRenderer,
    ) => {
      this.messageRenderers.set(customType, renderer);
    },
    getActiveTools: () => [...this.active],
    setActiveTools: (names: string[]) => {
      this.active = [...names];
      this.activeToolSets.push([...names]);
    },
    appendEntry: (customType: string, data?: unknown) => {
      this.entries.push({ customType, data });
    },
    sendMessage: (message: unknown, options?: unknown) => {
      this.sendMessages.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  async emit(event: string, payload: unknown, ctx: unknown): Promise<void> {
    for (const handler of this.handlers.get(event) ?? [])
      await handler(payload, ctx);
  }

  lastActiveTools(): string[] {
    return this.activeToolSets.at(-1) ?? [...this.active];
  }
}

interface ContextInput {
  hasUI?: boolean;
  ui?: ScriptedUI;
  sessionId?: string;
  branch?: unknown[];
  idle?: () => boolean;
  registry?: ModelRegistry;
}

function makeContext(input: ContextInput = {}): ExtensionCommandContext {
  const ui = input.ui ?? new ScriptedUI();
  return {
    ui: ui as unknown as ExtensionUIContext,
    mode: "tui",
    hasUI: input.hasUI ?? true,
    cwd: process.cwd(),
    sessionManager: {
      getBranch: () => input.branch ?? [],
      getSessionId: () => input.sessionId ?? "owner-session",
    },
    modelRegistry: input.registry ?? fakeRegistry(),
    model: undefined,
    scopedModels: [],
    isIdle: input.idle ?? (() => true),
    isProjectTrusted: () => false,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({}),
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: true }),
    fork: async () => ({ cancelled: true }),
    navigateTree: async () => ({ cancelled: true }),
    switchSession: async () => ({ cancelled: true }),
    reload: async () => {},
  } as unknown as ExtensionCommandContext;
}

function makeHarness(input: ContextInput = {}) {
  const ui = input.ui ?? new ScriptedUI();
  return { pi: new FakePi(), ctx: makeContext({ ...input, ui }), ui };
}

async function start(
  pi: FakePi,
  ctx: ExtensionCommandContext,
  reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup",
): Promise<void> {
  subagentsV2(pi.api);
  await pi.emit("session_start", { type: "session_start", reason }, ctx);
}

// ---------------------------------------------------------------------------
// Fake worker sessions (prototype replacement; no live session is created)
// ---------------------------------------------------------------------------

class BoundaryFakeSession implements WorkerSession {
  readonly sessionFile: string;
  readonly starts: string[] = [];
  readonly steers: string[] = [];
  closed = false;

  constructor(
    readonly workerId: string,
    private readonly callbacks: WorkerSessionCallbacks,
  ) {
    this.sessionFile = path.join(
      agentDir,
      "fake-sessions",
      `${workerId}.jsonl`,
    );
  }

  start(brief: string): void {
    this.starts.push(brief);
    this.callbacks.onStarted();
  }

  async steer(message: string): Promise<void> {
    this.steers.push(message);
  }

  async interrupt(): Promise<void> {
    this.callbacks.onSettled({ result: "", interrupted: true });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  transcript(): SessionTranscriptItem[] {
    return this.starts.map((text) => ({ role: "user", text }));
  }

  report(kind: "fyi" | "question" | "blocked", message: string): void {
    this.callbacks.onReport(kind, message);
  }

  settle(result: string): void {
    this.callbacks.onSettled({ result });
  }
}

class FakeWorkerSessions {
  readonly sessions = new Map<string, BoundaryFakeSession>();
  private originalCreate?: typeof PiWorkerSessionFactory.prototype.create;
  private originalRead?: typeof PiWorkerSessionFactory.prototype.readTranscript;

  install(): void {
    this.originalCreate = PiWorkerSessionFactory.prototype.create;
    this.originalRead = PiWorkerSessionFactory.prototype.readTranscript;
    PiWorkerSessionFactory.prototype.create = async (worker, callbacks) => {
      const session = new BoundaryFakeSession(worker.id, callbacks);
      this.sessions.set(worker.id, session);
      return session;
    };
    PiWorkerSessionFactory.prototype.readTranscript = (worker) =>
      this.sessions.get(worker.id)?.transcript() ?? [];
  }

  restore(): void {
    if (this.originalCreate)
      PiWorkerSessionFactory.prototype.create = this.originalCreate;
    if (this.originalRead)
      PiWorkerSessionFactory.prototype.readTranscript = this.originalRead;
  }

  require(workerId: string): BoundaryFakeSession {
    const session = this.sessions.get(workerId);
    assert.ok(session, `no fake session for ${workerId}`);
    return session;
  }
}

let fakeSessions: FakeWorkerSessions;

const flushImmediate = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

function definition(pi: FakePi, name: string): ToolDefinition {
  const tool = pi.tools.get(name);
  assert.ok(tool, `tool "${name}" was not registered`);
  return tool;
}

async function callTool(
  pi: FakePi,
  name: string,
  params: Record<string, unknown>,
  ctx: ExtensionCommandContext,
): Promise<ToolResult> {
  return (await definition(pi, name).execute(
    `call-${name}`,
    params,
    undefined,
    undefined,
    ctx,
  )) as unknown as ToolResult;
}

function workerIdFrom(result: ToolResult): string {
  const details = result.details as { workerId?: string } | undefined;
  assert.ok(details?.workerId, "tool result is missing a workerId");
  return details.workerId;
}

function resultText(result: ToolResult): string {
  return result.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

beforeEach(() => {
  fs.rmSync(path.join(agentDir, "subagents-v2"), {
    recursive: true,
    force: true,
  });
  fakeSessions = new FakeWorkerSessions();
  fakeSessions.install();
});

afterEach(() => {
  fakeSessions?.restore();
});

after(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

// ---------------------------------------------------------------------------
// Registration and defaults
// ---------------------------------------------------------------------------

test("delegation is off by default: tools register but stay inactive and the command exists", async () => {
  const { pi, ctx, ui } = makeHarness();
  await start(pi, ctx);

  assert.deepEqual(
    [...pi.tools.keys()].sort(),
    [...SUBAGENT_TOOL_NAMES].sort(),
  );
  assert.ok(pi.commands.has("subagents"), "expected /subagents command");
  assert.ok(
    pi.commands.has("subagent-config"),
    "expected /subagent-config command",
  );
  assert.deepEqual([...pi.messageRenderers.keys()].sort(), [
    "subagents-v2-fyi",
    "subagents-v2-results",
  ]);
  assert.equal(pi.handlers.get("agent_settled")?.length, 1);
  assert.equal(pi.handlers.get("session_shutdown")?.length, 1);

  const active = pi.lastActiveTools();
  for (const name of SUBAGENT_TOOL_NAMES) {
    assert.equal(
      active.includes(name),
      false,
      `${name} must stay inactive while disabled`,
    );
  }
  assert.ok(
    ui.statuses.some(
      ({ key, text }) => key === "subagents-v2" && text === undefined,
    ),
    "disabled status should be cleared",
  );
  assert.equal(fs.existsSync(CONFIG_FILE), false);
});

test("a valid persisted config enables delegation and activates all subagent tools", async () => {
  writeConfig(ENABLED_CONFIG);
  const { pi, ctx } = makeHarness();
  await start(pi, ctx);

  const active = pi.lastActiveTools();
  for (const name of SUBAGENT_TOOL_NAMES) {
    assert.ok(active.includes(name), `${name} should be active when enabled`);
  }
});

// ---------------------------------------------------------------------------
// /subagents config
// ---------------------------------------------------------------------------

test("model-specific reasoning config rejects disallowed levels and applies per-model defaults through subagent_spawn", async () => {
  writeConfig(ENABLED_CONFIG);
  const { pi, ctx } = makeHarness({
    registry: fakeRegistry([fakeModel, fakeOtherModel]),
    idle: () => false,
  });
  await start(pi, ctx);

  const defaulted = await callTool(
    pi,
    "subagent_spawn",
    { name: "defaulted", task: "t" },
    ctx,
  );
  assert.match(
    resultText(defaulted),
    /fake\/model \(low\)/,
    "an omitted selection uses the default model and that model's default reasoning",
  );

  const perModel = await callTool(
    pi,
    "subagent_spawn",
    { name: "per-model", task: "t", model: "fake/other" },
    ctx,
  );
  assert.match(
    resultText(perModel),
    /fake\/other \(high\)/,
    "an omitted reasoning level uses the selected model's own default",
  );

  await assert.rejects(
    callTool(
      pi,
      "subagent_spawn",
      { name: "wrong-level", task: "t", model: "fake/other", reasoning: "low" },
      ctx,
    ),
    /not allowed/,
    "a reasoning level allowed for another model must be rejected for this model",
  );
  await assert.rejects(
    callTool(
      pi,
      "subagent_spawn",
      { name: "unknown", task: "t", model: "other/model" },
      ctx,
    ),
    /not allowed/,
  );

  await flushImmediate();
  await pi.emit(
    "session_shutdown",
    { type: "session_shutdown", reason: "quit" },
    ctx,
  );
});

test("an enabled configuration without model-specific reasoning stays disabled and reports the error", async () => {
  writeConfig({
    version: 2,
    enabled: true,
    allowedModels: ["fake/model"],
    modelReasoning: {},
    maxActive: 4,
  });
  const { pi, ctx, ui } = makeHarness({ registry: fakeRegistry() });
  await start(pi, ctx);

  assert.ok(
    ui.notifies.some(
      ({ type, message }) => type === "error" && /disabled/i.test(message),
    ),
    "invalid enablement should surface a validation error",
  );
  const active = pi.lastActiveTools();
  for (const name of SUBAGENT_TOOL_NAMES) {
    assert.equal(
      active.includes(name),
      false,
      `${name} must not activate on invalid config`,
    );
  }
  await assert.rejects(
    callTool(pi, "subagent_spawn", { name: "w", task: "t" }, ctx),
    /disabled/,
  );
});

test("the configuration popup applies model-specific settings and activates tools", async () => {
  const ui = new ScriptedUI();
  const { pi, ctx } = makeHarness({
    ui,
    registry: fakeRegistry([fakeModel, fakeOtherModel]),
  });
  await start(pi, ctx);

  const pending = pi.commands.get("subagents")!.handler("config", ctx);
  const picker = ui.picker;
  assert.ok(picker, "the config popup must be built through ui.custom");

  await drive(picker, [
    "down",
    "down",
    "down",
    "enter",
    "right",
    "down",
    "down",
    "space",
    "d",
    "escape",
    "escape",
    "up",
    "up",
    "up",
    "space",
    "escape",
  ]);
  await pending;

  const saved = JSON.parse(
    fs.readFileSync(CONFIG_FILE, "utf8"),
  ) as SubagentsConfig;
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.allowedModels, ["fake/model"]);
  assert.deepEqual(saved.modelReasoning["fake/model"], {
    allowed: ["low"],
    default: "low",
  });
  const active = pi.lastActiveTools();
  for (const name of SUBAGENT_TOOL_NAMES) {
    assert.ok(
      active.includes(name),
      `${name} should be active after the popup enables delegation`,
    );
  }
});

test("the configuration popup refuses enablement without a valid model and reasoning level", async () => {
  const ui = new ScriptedUI();
  const { pi, ctx } = makeHarness({ ui, registry: fakeRegistry() });
  await start(pi, ctx);

  const pending = pi.commands.get("subagents")!.handler("config", ctx);
  const picker = ui.picker;
  assert.ok(picker, "the config popup must be built through ui.custom");

  await drive(picker, ["space"]);
  assert.match(
    picker.render(80).join("\n"),
    /allowed model/i,
    "the popup must show the rejected-write error",
  );
  assert.equal(
    picker.config.enabled,
    false,
    "a rejected enable must revert the draft",
  );
  assert.equal(
    fs.existsSync(CONFIG_FILE),
    false,
    "invalid enablement must not persist a config",
  );

  await drive(picker, ["escape"]);
  await pending;
  for (const name of SUBAGENT_TOOL_NAMES) {
    assert.equal(
      pi.lastActiveTools().includes(name),
      false,
      `${name} must not activate on invalid config`,
    );
  }
});

test("unavailable startup configuration stays disabled and spawn rejects disallowed selections", async () => {
  writeConfig(ENABLED_CONFIG);
  const unavailable = makeHarness({ registry: fakeRegistry([]) });
  await start(unavailable.pi, unavailable.ctx);
  await assert.rejects(
    callTool(
      unavailable.pi,
      "subagent_spawn",
      { name: "w", task: "t" },
      unavailable.ctx,
    ),
    /disabled/,
  );
  assert.ok(
    unavailable.ui.notifies.some(({ message }) =>
      /available|authenticated/.test(message),
    ),
  );
  assert.ok(!unavailable.pi.lastActiveTools().includes("subagent_spawn"));

  const allowed = makeHarness({ registry: fakeRegistry() });
  await start(allowed.pi, allowed.ctx);
  await assert.rejects(
    callTool(
      allowed.pi,
      "subagent_spawn",
      { name: "w", task: "t", model: "other/model" },
      allowed.ctx,
    ),
    /not allowed/,
  );
});

test("registered tools and commands work without interactive UI", async () => {
  writeConfig(ENABLED_CONFIG);
  const { pi, ctx, ui } = makeHarness({ hasUI: false });
  await start(pi, ctx);

  await pi.commands.get("subagents")!.handler("", ctx);
  await pi.commands.get("subagents")!.handler("config", ctx);
  await pi.commands.get("subagent-config")!.handler("", ctx);
  assert.equal(
    ui.selectTitles.length,
    0,
    "the command must not prompt when there is no UI",
  );
  assert.equal(ui.customCalls, 0, "headless commands must not open an overlay");
  assert.equal(ui.notifies.length, 0, "headless commands must stay silent");

  const listed = await callTool(pi, "subagent_list", {}, ctx);
  assert.match(resultText(listed), /No workers/);
});

test("commands dispatch /subagent-config to the popup and /subagents to the live dashboard", async () => {
  writeConfig(ENABLED_CONFIG);
  const ui = new ScriptedUI();
  const { pi, ctx } = makeHarness({
    ui,
    registry: fakeRegistry([fakeModel, fakeOtherModel]),
  });
  await start(pi, ctx);

  const configCommand = pi.commands.get("subagent-config")!.handler("", ctx);
  const configPicker = ui.picker;
  assert.ok(
    configPicker,
    "/subagent-config must open the configure popup directly",
  );
  assert.equal(ui.dashboard === undefined, true);
  await drive(configPicker, ["escape"]);
  await configCommand;

  const alias = pi.commands.get("subagents")!.handler("config", ctx);
  const aliasPicker = ui.picker;
  assert.ok(aliasPicker, "/subagents config must remain a configure alias");
  assert.equal(ui.dashboard === undefined, true);
  await drive(aliasPicker, ["escape"]);
  await alias;

  const dashboardCommand = pi.commands.get("subagents")!.handler("", ctx);
  const dashboard = ui.dashboard;
  assert.ok(dashboard, "/subagents must open the live dashboard");
  assert.equal(ui.picker === undefined, true);
  dashboard.handleInput("q");
  await dashboardCommand;
  assert.equal(dashboard.isClosed, true, "escape/q closes the dashboard");
});

test("command usage errors never open a UI", async () => {
  const { pi, ctx, ui } = makeHarness();
  await start(pi, ctx);

  await pi.commands.get("subagent-config")!.handler("unexpected", ctx);
  await pi.commands.get("subagents")!.handler("bogus", ctx);

  assert.equal(ui.customCalls, 0);
  assert.equal(ui.selectTitles.length, 0);
  assert.equal(
    ui.notifies.filter(({ type }) => type === "warning").length,
    2,
    "both commands report usage without opening a view",
  );
});

// ---------------------------------------------------------------------------
// Branch / fork ownership
// ---------------------------------------------------------------------------

test("a forked branch with another owner's workers rejects control instead of mutating them", async () => {
  const foreignWorker = {
    id: "foreign-1",
    name: "foreign",
    cwd: process.cwd(),
    model: "fake/model",
    reasoning: "low",
    createdAt: 0,
    updatedAt: 0,
    takenOver: false,
    tasks: [],
  } as unknown as WorkerRecord;
  const branch = [
    {
      type: "custom",
      customType: STATE_ENTRY_TYPE,
      data: {
        version: 1,
        ownerSessionId: "other-parent",
        workers: [foreignWorker],
      },
    },
  ];
  const { pi, ctx, ui } = makeHarness({ branch, sessionId: "current-parent" });
  await start(pi, ctx, "fork");

  assert.ok(
    ui.notifies.some(
      ({ type, message }) => type === "warning" && /other-parent/.test(message),
    ),
    "expected a cross-owner warning",
  );
  await assert.rejects(
    callTool(pi, "subagent_list", { id: foreignWorker.id }, ctx),
    /Cross-session worker control is unsupported/,
  );
  await assert.rejects(
    callTool(
      pi,
      "subagent_followup",
      { id: foreignWorker.id, task: "new work" },
      ctx,
    ),
    /Cross-session worker control is unsupported/,
  );
  assert.equal(
    pi.entries.length,
    0,
    "the forked session must not persist or mutate the other owner's workers",
  );
});

// ---------------------------------------------------------------------------
// FYI and deferred result delivery
// ---------------------------------------------------------------------------

test("fyi information reaches the parent without waking it", async () => {
  writeConfig(ENABLED_CONFIG);
  const { pi, ctx, ui } = makeHarness();
  await start(pi, ctx);
  const workerId = workerIdFrom(
    await callTool(
      pi,
      "subagent_spawn",
      { name: "reporter", task: "work" },
      ctx,
    ),
  );
  await flushImmediate();

  fakeSessions.require(workerId).report("fyi", "halfway there");

  assert.ok(
    ui.notifies.some(({ message }) => message.includes("halfway there")),
    "fyi should surface a UI notification",
  );
  const fyiMessages = pi.sendMessages.filter(({ message }) =>
    JSON.stringify(message).includes("halfway there"),
  );
  assert.ok(
    fyiMessages.length > 0,
    "expected fyi information in a parent context message, not only ui.notify",
  );
  assert.equal(
    pi.sendMessages.some(
      ({ options }) =>
        (options as { triggerTurn?: boolean } | undefined)?.triggerTurn ===
        true,
    ),
    false,
    "fyi must not trigger an automatic parent wake",
  );
});

test("results are buffered while the parent is busy and combined into one wake", async () => {
  writeConfig(ENABLED_CONFIG);
  let idle = false;
  const { pi, ctx } = makeHarness({ idle: () => idle });
  await start(pi, ctx);

  const one = workerIdFrom(
    await callTool(pi, "subagent_spawn", { name: "one", task: "t1" }, ctx),
  );
  const two = workerIdFrom(
    await callTool(pi, "subagent_spawn", { name: "two", task: "t2" }, ctx),
  );
  await flushImmediate();

  fakeSessions.require(one).settle("one done");
  fakeSessions.require(two).settle("two done");
  assert.equal(
    pi.sendMessages.length,
    0,
    "a busy parent must not be woken per result",
  );

  idle = true;
  await pi.emit("agent_settled", { type: "agent_settled" }, ctx);

  assert.equal(pi.sendMessages.length, 1);
  const { message, options } = pi.sendMessages[0]!;
  const content = (message as { content?: string }).content ?? "";
  assert.match(content, /one done/);
  assert.match(content, /two done/);
  assert.equal((options as { deliverAs?: string }).deliverAs, "followUp");
  assert.equal((options as { triggerTurn?: boolean }).triggerTurn, true);

  await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
  assert.equal(
    pi.sendMessages.length,
    1,
    "drained results must not be delivered twice",
  );
});

test("a wait that returns a buffered result prevents duplicate automatic delivery", async () => {
  writeConfig(ENABLED_CONFIG);
  let idle = false;
  const { pi, ctx } = makeHarness({ idle: () => idle });
  await start(pi, ctx);

  const workerId = workerIdFrom(
    await callTool(pi, "subagent_spawn", { name: "waiter", task: "t1" }, ctx),
  );
  await flushImmediate();
  fakeSessions.require(workerId).settle("waited result");
  assert.equal(pi.sendMessages.length, 0, "busy results stay buffered");

  const waited = await callTool(
    pi,
    "subagent_wait",
    { ids: [workerId], mode: "all" },
    ctx,
  );
  assert.match(resultText(waited), /waited result/);

  idle = true;
  await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
  assert.equal(
    pi.sendMessages.length,
    0,
    "a wait result must not be auto-delivered again",
  );
});

test("cached worker followups reject newly unavailable selections without changing the task", async () => {
  writeConfig(ENABLED_CONFIG);
  const models = [fakeModel];
  const { pi, ctx } = makeHarness({ registry: fakeRegistry(models) });
  await start(pi, ctx);
  const spawned = await callTool(
    pi,
    "subagent_spawn",
    { name: "reuse", task: "first" },
    ctx,
  );
  const id = workerIdFrom(spawned);
  await flushImmediate();
  fakeSessions.require(id).settle("original result");
  models.splice(0);
  await assert.rejects(
    callTool(pi, "subagent_followup", { id, task: "second" }, ctx),
    /unavailable|authentication/,
  );
  assert.equal(fakeSessions.require(id).starts.length, 1);
  assert.match(
    resultText(await callTool(pi, "subagent_list", { id }, ctx)),
    /original result/,
  );
  await pi.emit(
    "session_shutdown",
    { type: "session_shutdown", reason: "quit" },
    ctx,
  );
});

test("interrupt reports every selected failure and still stops other workers", async () => {
  writeConfig(ENABLED_CONFIG);
  const { pi, ctx } = makeHarness({ idle: () => false });
  await start(pi, ctx);
  const ids: string[] = [];
  for (const name of ["bad-one", "bad-two", "good"]) {
    ids.push(
      workerIdFrom(
        await callTool(pi, "subagent_spawn", { name, task: name }, ctx),
      ),
    );
  }
  await flushImmediate();
  fakeSessions.require(ids[0]).interrupt = async () => {
    throw new Error("first stop failed");
  };
  fakeSessions.require(ids[1]).interrupt = async () => {
    throw new Error("second stop failed");
  };
  const result = resultText(
    await callTool(pi, "subagent_interrupt", { ids }, ctx),
  );
  assert.match(result, /first stop failed/);
  assert.match(result, /second stop failed/);
  assert.match(result, new RegExp(`${ids[2]}: interrupted`));
  await pi.emit(
    "session_shutdown",
    { type: "session_shutdown", reason: "quit" },
    ctx,
  );
});

test("the configuration popup disables workers and a later enable does not restart them", async () => {
  writeConfig(ENABLED_CONFIG);
  const ui = new ScriptedUI();
  const { pi, ctx } = makeHarness({
    ui,
    registry: fakeRegistry([fakeModel, fakeOtherModel]),
    idle: () => false,
  });
  await start(pi, ctx);
  const id = workerIdFrom(
    await callTool(pi, "subagent_spawn", { name: "saved", task: "task" }, ctx),
  );
  await flushImmediate();
  const worker = fakeSessions.require(id);

  const disable = pi.commands.get("subagents")!.handler("config", ctx);
  const picker = ui.picker;
  assert.ok(picker, "the config popup must be built through ui.custom");
  assert.equal(picker.config.enabled, true);
  await drive(picker, ["space", "escape"]);
  await disable;

  assert.equal(worker.closed, true, "disabling stops the active worker");
  assert.ok(!pi.lastActiveTools().includes("subagent_spawn"));
  for (const event of ["session_before_tree", "session_before_fork"]) {
    const guard = pi.handlers.get(event)?.[0];
    assert.ok(guard);
    assert.deepEqual(
      await guard({ type: event }, ctx),
      { cancel: true },
      `${event} must remain guarded while disabled`,
    );
  }

  const enable = pi.commands.get("subagents")!.handler("config", ctx);
  const second = ui.picker;
  assert.ok(second, "the config popup must be rebuilt for the second call");
  assert.equal(second.config.enabled, false);
  await drive(second, ["space", "escape"]);
  await enable;

  assert.equal(worker.starts.length, 1, "enablement never restarts the task");
  assert.ok(pi.lastActiveTools().includes("subagent_spawn"));
  assert.match(
    resultText(await callTool(pi, "subagent_list", {}, ctx)),
    new RegExp(id),
  );
  await pi.emit(
    "session_shutdown",
    { type: "session_shutdown", reason: "quit" },
    ctx,
  );
});

test("explicit inspection retrieves an earlier task after worker reuse", async () => {
  writeConfig(ENABLED_CONFIG);
  const { pi, ctx } = makeHarness({ idle: () => false });
  await start(pi, ctx);
  const spawned = await callTool(
    pi,
    "subagent_spawn",
    { name: "reuse-results", task: "first" },
    ctx,
  );
  const id = workerIdFrom(spawned);
  const firstTaskId = (spawned.details as { taskId: string }).taskId;
  await flushImmediate();
  fakeSessions.require(id).settle("FIRST_RESULT");
  await callTool(pi, "subagent_followup", { id, task: "second" }, ctx);
  fakeSessions.require(id).settle("SECOND_RESULT");
  const earlier = resultText(
    await callTool(pi, "subagent_list", { id, task_id: firstTaskId }, ctx),
  );
  assert.match(earlier, /FIRST_RESULT/);
  assert.doesNotMatch(earlier, /SECOND_RESULT/);
  await assert.rejects(
    callTool(pi, "subagent_list", { id, task_id: "missing" }, ctx),
    /Unknown task/,
  );
  await pi.emit(
    "session_shutdown",
    { type: "session_shutdown", reason: "quit" },
    ctx,
  );
});

test("result batches carry communication DTOs while preserving legacy result details", async () => {
  writeConfig(ENABLED_CONFIG);
  let idle = false;
  const { pi, ctx } = makeHarness({ idle: () => idle });
  await start(pi, ctx);
  const one = workerIdFrom(
    await callTool(pi, "subagent_spawn", { name: "one", task: "t1" }, ctx),
  );
  const two = workerIdFrom(
    await callTool(pi, "subagent_spawn", { name: "two", task: "t2" }, ctx),
  );
  await flushImmediate();
  fakeSessions.require(one).settle("one done");
  fakeSessions.require(two).settle("two done");
  idle = true;
  await pi.emit("agent_settled", { type: "agent_settled" }, ctx);

  assert.equal(pi.sendMessages.length, 1);
  const message = pi.sendMessages[0]!.message as {
    customType?: string;
    details?: {
      communications?: Array<Record<string, unknown>>;
      results?: Array<{ workerId: string; taskId: string; status: string }>;
    };
  };
  assert.equal(message.customType, "subagents-v2-results");
  const communications = message.details?.communications ?? [];
  assert.equal(communications.length, 2);
  for (const record of communications) {
    assert.equal(record.direction, "incoming");
    assert.equal(record.action, "RESULT");
    assert.equal(record.status, "completed");
    assert.equal(typeof record.workerId, "string");
    assert.equal(typeof record.taskId, "string");
    assert.match(String(record.body), /done/);
  }
  assert.deepEqual(
    (message.details?.results ?? []).map((result) => result.workerId).sort(),
    [one, two].sort(),
    "legacy result details must remain for existing consumers",
  );
  await pi.emit(
    "session_shutdown",
    { type: "session_shutdown", reason: "quit" },
    ctx,
  );
});

test("fyi messages carry one communication DTO and keep flat identity fields", async () => {
  writeConfig(ENABLED_CONFIG);
  const { pi, ctx } = makeHarness();
  await start(pi, ctx);
  const spawned = await callTool(
    pi,
    "subagent_spawn",
    { name: "reporter", task: "work" },
    ctx,
  );
  const id = workerIdFrom(spawned);
  const taskId = (spawned.details as { taskId: string }).taskId;
  await flushImmediate();
  fakeSessions.require(id).report("fyi", "halfway there");

  const fyiMessage = pi.sendMessages.find(
    ({ message }) =>
      (message as { customType?: string }).customType === "subagents-v2-fyi",
  );
  assert.ok(fyiMessage, "expected an fyi message");
  const details = (
    fyiMessage.message as {
      details?: {
        communication?: Record<string, unknown>;
        workerId?: string;
        taskId?: string;
      };
    }
  ).details;
  const communication = details?.communication;
  assert.ok(communication, "fyi must carry a communication DTO");
  assert.equal(communication.direction, "incoming");
  assert.equal(communication.action, "FYI");
  assert.equal(communication.workerId, id);
  assert.equal(communication.taskId, taskId);
  assert.equal(communication.status, "working");
  assert.match(String(communication.body), /halfway there/);
  assert.equal(
    details?.workerId,
    id,
    "flat identity fields stay for legacy consumers",
  );
  assert.equal(details?.taskId, taskId);
  await pi.emit(
    "session_shutdown",
    { type: "session_shutdown", reason: "quit" },
    ctx,
  );
});

test("registered message renderers render both result batches and fyi updates", async () => {
  writeConfig(ENABLED_CONFIG);
  let idle = false;
  const { pi, ctx } = makeHarness({ idle: () => idle });
  await start(pi, ctx);
  const id = workerIdFrom(
    await callTool(
      pi,
      "subagent_spawn",
      { name: "rendered", task: "work" },
      ctx,
    ),
  );
  await flushImmediate();
  fakeSessions.require(id).report("fyi", "FYI_BODY");

  const fyiRenderer = pi.messageRenderers.get("subagents-v2-fyi");
  assert.ok(fyiRenderer, "fyi renderer must be registered");
  const fyiMessage = pi.sendMessages.find(
    ({ message }) =>
      (message as { customType?: string }).customType === "subagents-v2-fyi",
  )!;
  const fyiComponent = fyiRenderer(
    fyiMessage.message as { content?: unknown; details?: unknown },
    { expanded: false },
    renderTheme,
  );
  assert.ok(fyiComponent);
  assert.match(rendered(fyiComponent), /FYI/);
  assert.match(rendered(fyiComponent), /FYI_BODY/);

  fakeSessions.require(id).settle("RESULT_BODY");
  idle = true;
  await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
  const resultRenderer = pi.messageRenderers.get("subagents-v2-results");
  assert.ok(resultRenderer, "result renderer must be registered");
  const resultMessage = pi.sendMessages.find(
    ({ message }) =>
      (message as { customType?: string }).customType ===
      "subagents-v2-results",
  )!;
  const resultComponent = resultRenderer(
    resultMessage.message as { content?: unknown; details?: unknown },
    { expanded: false },
    renderTheme,
  );
  assert.ok(resultComponent);
  assert.match(rendered(resultComponent), /RESULT_BODY/);
  assert.match(rendered(resultComponent), new RegExp(id));
  await pi.emit(
    "session_shutdown",
    { type: "session_shutdown", reason: "quit" },
    ctx,
  );
});

test("delegation tools register call and result renderers that identify workers", async () => {
  writeConfig(ENABLED_CONFIG);
  const { pi, ctx } = makeHarness({ idle: () => false });
  await start(pi, ctx);

  for (const name of SUBAGENT_TOOL_NAMES) {
    const tool = definition(pi, name);
    assert.equal(typeof tool.renderCall, "function", `${name} renderCall`);
    assert.equal(typeof tool.renderResult, "function", `${name} renderResult`);
  }

  const spawnCall = definition(pi, "subagent_spawn").renderCall!(
    { name: "alpha", task: "write docs" },
    renderTheme,
    {} as never,
  );
  assert.match(rendered(spawnCall), /TASK/);
  assert.match(rendered(spawnCall), /alpha/);
  assert.match(rendered(spawnCall), /write docs/);

  const spawned = await callTool(
    pi,
    "subagent_spawn",
    { name: "beta", task: "task" },
    ctx,
  );
  const id = workerIdFrom(spawned);
  await flushImmediate();
  const followCall = definition(pi, "subagent_followup").renderCall!(
    { id, task: "next" },
    renderTheme,
    {} as never,
  );
  assert.match(rendered(followCall), /FOLLOW-UP/);
  assert.match(rendered(followCall), new RegExp(id));
  await pi.emit(
    "session_shutdown",
    { type: "session_shutdown", reason: "quit" },
    ctx,
  );
});

test("tool result renderers separate historical tasks from the current worker state", async () => {
  writeConfig(ENABLED_CONFIG);
  const { pi, ctx } = makeHarness({ idle: () => false });
  await start(pi, ctx);
  const spawned = await callTool(
    pi,
    "subagent_spawn",
    { name: "history", task: "first" },
    ctx,
  );
  const id = workerIdFrom(spawned);
  const firstTaskId = (spawned.details as { taskId: string }).taskId;
  await flushImmediate();
  fakeSessions.require(id).settle("FIRST");
  await callTool(pi, "subagent_followup", { id, task: "second" }, ctx);
  await flushImmediate();

  const renderResult = definition(pi, "subagent_list").renderResult!;
  const historical = await callTool(
    pi,
    "subagent_list",
    { id, task_id: firstTaskId },
    ctx,
  );
  const historicalText = rendered(
    renderResult(
      historical as never,
      { expanded: false, isPartial: false },
      renderTheme,
      { isError: false } as never,
    ),
  );
  assert.match(historicalText, /historical/);
  assert.match(historicalText, /recorded: completed/);
  assert.match(historicalText, /worker now: working/);
  assert.match(historicalText, new RegExp(firstTaskId));

  const current = await callTool(pi, "subagent_list", { id }, ctx);
  const currentText = rendered(
    renderResult(
      current as never,
      { expanded: false, isPartial: false },
      renderTheme,
      { isError: false } as never,
    ),
  );
  assert.match(currentText, /recorded: working/);
  assert.doesNotMatch(currentText, /historical/);
  await pi.emit(
    "session_shutdown",
    { type: "session_shutdown", reason: "quit" },
    ctx,
  );
});

test("tool acknowledgements carry the operated task id rather than the current task", async () => {
  writeConfig(ENABLED_CONFIG);
  const { pi, ctx } = makeHarness({ idle: () => false });
  await start(pi, ctx);
  const spawned = await callTool(
    pi,
    "subagent_spawn",
    { name: "ids", task: "first" },
    ctx,
  );
  const id = workerIdFrom(spawned);
  const firstTaskId = (spawned.details as { taskId: string }).taskId;
  const spawnAck = (
    spawned.details as {
      communication?: { taskId?: string; action?: string };
    }
  ).communication;
  assert.equal(spawnAck?.action, "ACK");
  assert.equal(spawnAck?.taskId, firstTaskId);
  await flushImmediate();
  fakeSessions.require(id).settle("first");

  const followed = await callTool(
    pi,
    "subagent_followup",
    { id, task: "second" },
    ctx,
  );
  const secondTaskId = (followed.details as { taskId: string }).taskId;
  assert.notEqual(secondTaskId, firstTaskId);
  assert.equal(
    (followed.details as { communication?: { taskId?: string } }).communication
      ?.taskId,
    secondTaskId,
    "a follow-up acknowledgement must reference the new task, not a stale one",
  );
  await flushImmediate();

  const steered = await callTool(
    pi,
    "subagent_steer",
    { id, message: "adjust" },
    ctx,
  );
  assert.equal(
    (steered.details as { communication?: { taskId?: string } }).communication
      ?.taskId,
    secondTaskId,
    "steering references the active task",
  );

  const listed = await callTool(
    pi,
    "subagent_list",
    { id, task_id: firstTaskId },
    ctx,
  );
  const listCommunications =
    (
      listed.details as {
        communications?: Array<{ taskId?: string; action?: string }>;
      }
    ).communications ?? [];
  assert.equal(
    listCommunications[0]?.taskId,
    firstTaskId,
    "historical inspection must keep the inspected task id",
  );
  assert.equal(listCommunications[0]?.action, "SNAPSHOT");
  await pi.emit(
    "session_shutdown",
    { type: "session_shutdown", reason: "quit" },
    ctx,
  );
});

test("result DTO bodies exclude the heading for multiline worker names", async () => {
  writeConfig(ENABLED_CONFIG);
  let idle = false;
  const { pi, ctx } = makeHarness({ idle: () => idle });
  await start(pi, ctx);
  const spawned = await callTool(
    pi,
    "subagent_spawn",
    { name: "multi\nline", task: "t" },
    ctx,
  );
  const id = workerIdFrom(spawned);
  const taskId = (spawned.details as { taskId: string }).taskId;
  await flushImmediate();
  fakeSessions.require(id).settle("MULTILINE_RESULT");
  idle = true;
  await pi.emit("agent_settled", { type: "agent_settled" }, ctx);

  const message = pi.sendMessages.find(
    ({ message }) =>
      (message as { customType?: string }).customType ===
      "subagents-v2-results",
  )!;
  const communication = (
    message.message as {
      details?: { communications?: Array<{ body?: string }> };
    }
  ).details?.communications?.[0];
  assert.ok(communication);
  assert.equal(
    communication.body,
    "MULTILINE_RESULT",
    "the heading must not leak into the result body",
  );
  assert.doesNotMatch(communication.body!, new RegExp(taskId));
  assert.doesNotMatch(communication.body!, /\[completed\]/);
  assert.doesNotMatch(communication.body!, /line"/);
  await pi.emit(
    "session_shutdown",
    { type: "session_shutdown", reason: "quit" },
    ctx,
  );
});

test("a restored worker without a current task renders worker now idle", async () => {
  writeConfig(ENABLED_CONFIG);
  const sessionFile = path.join(agentDir, "fake-sessions", "restored-1.jsonl");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, "{}\n");
  const restoredWorker = {
    id: "restored-1",
    name: "restored",
    cwd: process.cwd(),
    model: "fake/model",
    reasoning: "low",
    createdAt: 0,
    updatedAt: 0,
    takenOver: false,
    sessionFile,
    tasks: [
      {
        id: "restored-1-t1",
        brief: "old",
        status: "completed",
        startedAt: 0,
        result: "OLD_RESULT",
      },
    ],
  } as unknown as WorkerRecord;
  const branch = [
    {
      type: "custom",
      customType: STATE_ENTRY_TYPE,
      data: {
        version: 1,
        ownerSessionId: "owner-session",
        workers: [restoredWorker],
      },
    },
  ];
  const { pi, ctx } = makeHarness({
    branch,
    sessionId: "owner-session",
    idle: () => false,
  });
  await start(pi, ctx);

  const listed = await callTool(
    pi,
    "subagent_list",
    { id: "restored-1", task_id: "restored-1-t1" },
    ctx,
  );
  const communications =
    (
      listed.details as {
        communications?: Array<{ taskId?: string }>;
      }
    ).communications ?? [];
  assert.equal(
    communications[0]?.taskId,
    "restored-1-t1",
    "the inspected historical task id is kept when no current task exists",
  );

  const text = rendered(
    definition(pi, "subagent_list").renderResult!(
      listed as never,
      { expanded: false, isPartial: false },
      renderTheme,
      { isError: false } as never,
    ),
  );
  assert.match(text, /historical/);
  assert.match(text, /worker now: idle/);
  assert.doesNotMatch(text, /unavailable/);
  await pi.emit(
    "session_shutdown",
    { type: "session_shutdown", reason: "quit" },
    ctx,
  );
});

test("retained communication components re-resolve historical status at render time", async () => {
  writeConfig(ENABLED_CONFIG);
  const { pi, ctx } = makeHarness({ idle: () => true });
  await start(pi, ctx);

  const spawned = await callTool(
    pi,
    "subagent_spawn",
    { name: "retained", task: "first" },
    ctx,
  );
  const id = workerIdFrom(spawned);
  await flushImmediate();
  fakeSessions.require(id).settle("FIRST_RESULT");

  const resultMessage = pi.sendMessages.find(
    ({ message }) =>
      (message as { customType?: string }).customType ===
      "subagents-v2-results",
  );
  assert.ok(resultMessage, "task1 result must be delivered while idle");
  const resultRenderer = pi.messageRenderers.get("subagents-v2-results");
  assert.ok(resultRenderer);
  // Pi retains returned components, so build each one exactly once.
  const resultComponent = resultRenderer(
    resultMessage.message as { content?: unknown; details?: unknown },
    { expanded: false },
    renderTheme,
  );
  assert.ok(resultComponent);
  const ackComponent = definition(pi, "subagent_spawn").renderResult!(
    spawned as never,
    { expanded: false, isPartial: false },
    renderTheme,
    { isError: false } as never,
  );

  // While task1 is the current task neither retained component is historical.
  const firstResult = rendered(resultComponent);
  assert.match(firstResult, /recorded: completed/);
  assert.doesNotMatch(firstResult, /historical/);
  const firstAck = rendered(ackComponent);
  assert.doesNotMatch(firstAck, /historical/);

  // Start task2, then re-render the same component objects without invoking
  // either renderer factory again. Live status must be re-resolved.
  await callTool(pi, "subagent_followup", { id, task: "second" }, ctx);
  await flushImmediate();

  const secondResult = rendered(resultComponent);
  assert.match(secondResult, /historical/);
  assert.match(secondResult, /worker now: working/);
  const secondAck = rendered(ackComponent);
  assert.match(secondAck, /historical/);
  assert.match(secondAck, /worker now: working/);
  await pi.emit(
    "session_shutdown",
    { type: "session_shutdown", reason: "quit" },
    ctx,
  );
});

// ---------------------------------------------------------------------------
// Deferred-delivery primitive
// ---------------------------------------------------------------------------

function taskResult(workerId: string, taskId: string): TaskResult {
  const task = {
    id: taskId,
    brief: "brief",
    status: "completed",
    startedAt: 0,
    result: `${workerId} result`,
  } as unknown as WorkerTask;
  const worker = {
    id: workerId,
    name: workerId,
    cwd: "",
    model: "fake/model",
    reasoning: "low",
    createdAt: 0,
    updatedAt: 0,
    takenOver: false,
    currentTaskId: taskId,
    tasks: [task],
  } as unknown as WorkerRecord;
  return { worker, task };
}

test("deferred delivery deduplicates by worker/task key and drops consumed results", () => {
  const delivery = createDeferredDelivery();
  const first = taskResult("w1", "w1-t1");
  delivery.defer(first);
  delivery.defer(taskResult("w1", "w1-t1"));
  delivery.defer(taskResult("w1", "w1-t2"));
  assert.equal(
    delivery.drain().length,
    2,
    "same worker/task must not duplicate",
  );

  delivery.defer(first);
  delivery.consume([first]);
  assert.deepEqual(
    delivery.drain(),
    [],
    "consumed results must not drain again",
  );

  delivery.defer(first);
  delivery.clear();
  assert.deepEqual(delivery.drain(), [], "clear must empty pending results");
});
