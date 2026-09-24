/**
 * Independent real-SDK notification scheduling tests for Subagents V2.
 *
 * Unlike the fake-`ExtensionAPI` boundary tests, these tests drive an actual
 * Pi SDK `AgentSession` whose parent extension is the real Subagents V2
 * `index.ts`. A deterministic fake provider supplies every model response, so
 * nothing touches the network, inference, credentials, or the user's Pi state.
 *
 * Isolation:
 * - `PI_CODING_AGENT_DIR` points at a throwaway temp directory before
 *   `index.ts` is imported, so its module-level `CONFIG_PATH` resolves there.
 * - `PiWorkerSessionFactory.prototype.create` is replaced with a tiny
 *   controlled worker session for the duration of each test and restored in
 *   cleanup. No provider, session, or model-call code runs for workers.
 * - Every provider request is scripted; `allowModelNetwork` is false.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { PiWorkerSessionFactory } from "./src/pi-session.ts";
import type {
  SessionTranscriptItem,
  SubagentsConfig,
  WorkerRecord,
  WorkerSession,
  WorkerSessionCallbacks,
} from "./src/types.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const agentDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "subagents-v2-notification-sdk-"),
);
process.env.PI_CODING_AGENT_DIR = agentDir;

const { default: subagentsV2 } = await import("./index.ts");

const CONFIG_FILE = path.join(agentDir, "subagents-v2", "config.json");
const MODEL_ID = "model";
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const ZERO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: NO_COST,
};

function writeConfig(modelKey: string): void {
  const config: SubagentsConfig = {
    version: 2,
    enabled: true,
    allowedModels: [modelKey],
    modelReasoning: {
      [modelKey]: { allowed: ["low", "medium"], default: "low" },
    },
    defaultModel: modelKey,
    maxActive: 4,
  };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  fs.rmSync(agentDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Deterministic fake provider
// ---------------------------------------------------------------------------

interface FakeRequest {
  model: Model<Api>;
  context: TranscriptContext;
  count: number;
}

type FakeResponse = Omit<AssistantMessage, "stopReason"> & {
  stopReason: "stop" | "toolUse" | "error" | "aborted";
};

type Responder = (request: FakeRequest) => FakeResponse | Promise<FakeResponse>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function within<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 10_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function assistantMessage(
  model: Model<Api>,
  content: AssistantMessage["content"],
  stopReason: "stop" | "toolUse" | "error",
  errorMessage?: string,
): FakeResponse {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

function textReply(model: Model<Api>, text: string) {
  return assistantMessage(model, [{ type: "text", text }], "stop");
}

function failedReply(model: Model<Api>, message: string) {
  return assistantMessage(model, [], "error", message);
}

function toolCall(
  id: string,
  name: string,
  arguments_: Record<string, string>,
) {
  return { type: "toolCall" as const, id, name, arguments: arguments_ };
}

function emitResponse(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  message: FakeResponse,
) {
  const partial: AssistantMessage = {
    ...assistantMessage(model, [], "error"),
    stopReason: "pending",
    errorMessage: undefined,
  };
  stream.push({ type: "start", partial });

  for (const [contentIndex, block] of message.content.entries()) {
    if (block.type === "text") {
      const partialBlock = { type: "text" as const, text: "" };
      partial.content.push(partialBlock);
      stream.push({ type: "text_start", contentIndex, partial });
      partialBlock.text = block.text;
      stream.push({
        type: "text_delta",
        contentIndex,
        delta: block.text,
        partial,
      });
      stream.push({
        type: "text_end",
        contentIndex,
        content: block.text,
        partial,
      });
    } else if (block.type === "toolCall") {
      const partialBlock = {
        type: "toolCall" as const,
        id: block.id,
        name: block.name,
        arguments: {},
      };
      partial.content.push(partialBlock);
      stream.push({ type: "toolcall_start", contentIndex, partial });
      partialBlock.arguments = block.arguments;
      stream.push({
        type: "toolcall_end",
        contentIndex,
        toolCall: block,
        partial,
      });
    }
  }

  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    stream.push({ type: "done", reason: message.stopReason, message });
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason ?? new Error("Request aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

class ScriptedProvider {
  readonly requests: TranscriptContext[] = [];
  responder: Responder = () => {
    throw new Error("Scripted provider responder was not configured.");
  };
  private responses = 0;
  private readonly requestWaiters: Array<{
    count: number;
    resolve: () => void;
  }> = [];
  private readonly responseWaiters: Array<{
    count: number;
    resolve: () => void;
  }> = [];

  waitForRequests(count: number) {
    if (this.requests.length >= count) return Promise.resolve();
    return new Promise<void>((resolve) =>
      this.requestWaiters.push({ count, resolve }),
    );
  }

  streamSimple = (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const count = this.requests.push(context);
    for (const waiter of this.requestWaiters.splice(0)) {
      if (count >= waiter.count) waiter.resolve();
      else this.requestWaiters.push(waiter);
    }

    const partial: AssistantMessage = {
      ...assistantMessage(model, [], "error"),
      stopReason: "pending",
      errorMessage: undefined,
    };
    stream.push({ type: "start", partial });

    void abortable(
      Promise.resolve().then(() => this.responder({ model, context, count })),
      options?.signal,
    )
      .catch((error: unknown) =>
        options?.signal?.aborted
          ? assistantMessage(model, [], "error", "Fake request aborted.")
          : failedReply(
              model,
              error instanceof Error ? error.message : String(error),
            ),
      )
      .then((message) => {
        emitResponse(stream, model, message);
        this.responses++;
        for (const waiter of this.responseWaiters.splice(0)) {
          if (this.responses >= waiter.count) waiter.resolve();
          else this.responseWaiters.push(waiter);
        }
      });
    return stream;
  };
}

// ---------------------------------------------------------------------------
// Controlled worker session
// ---------------------------------------------------------------------------

class ControlledWorkerSession implements WorkerSession {
  readonly sessionFile = undefined;
  active = false;
  readonly briefs: string[] = [];

  constructor(
    readonly record: WorkerRecord,
    private readonly callbacks: WorkerSessionCallbacks,
  ) {}

  start(brief: string) {
    this.active = true;
    this.briefs.push(brief);
    this.callbacks.onStarted();
  }

  async steer(): Promise<void> {}

  async interrupt(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.callbacks.onSettled({ result: "", interrupted: true });
  }

  async close(): Promise<void> {
    this.active = false;
  }

  transcript(): SessionTranscriptItem[] {
    return [];
  }

  report(kind: "fyi" | "question" | "blocked", message: string) {
    this.callbacks.onReport(kind, message);
  }

  complete(result: string) {
    this.active = false;
    this.callbacks.onSettled({ result });
  }
}

function stubWorkerFactory() {
  const original = PiWorkerSessionFactory.prototype.create;
  const sessions: ControlledWorkerSession[] = [];
  PiWorkerSessionFactory.prototype.create = async function (
    worker: WorkerRecord,
    callbacks: WorkerSessionCallbacks,
  ): Promise<WorkerSession> {
    const session = new ControlledWorkerSession(worker, callbacks);
    sessions.push(session);
    return session;
  };
  return {
    sessions,
    restore() {
      PiWorkerSessionFactory.prototype.create = original;
    },
  };
}

async function waitForWorker(
  stub: ReturnType<typeof stubWorkerFactory>,
): Promise<ControlledWorkerSession> {
  await within(
    (async () => {
      while (stub.sessions.length === 0) await delay(5);
    })(),
    "the parent did not start a controlled worker",
  );
  const session = stub.sessions[0];
  assert.ok(session);
  return session;
}

// ---------------------------------------------------------------------------
// Real parent AgentSession harness
// ---------------------------------------------------------------------------

interface ParentHarness {
  root: string;
  workspace: string;
  provider: ScriptedProvider;
  session: AgentSession;
  errors: string[];
  cleanup(): Promise<void>;
}

let harnessSequence = 0;

async function createParentHarness(
  makeResponder: (info: {
    modelKey: string;
    provider: ScriptedProvider;
  }) => Responder,
): Promise<ParentHarness> {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "subagents-v2-notification-sdk-run-"),
  );
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });

  const providerId = `notification-sdk-${process.pid}-${++harnessSequence}`;
  const api = `${providerId}-api`;
  const provider = new ScriptedProvider();

  const runtime = await ModelRuntime.create({
    authPath: path.join(root, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  runtime.registerProvider(providerId, {
    name: "Notification SDK test provider",
    api,
    apiKey: "test-only-no-network",
    streamSimple: provider.streamSimple,
    models: [
      {
        id: MODEL_ID,
        name: "Notification SDK test model",
        api,
        baseUrl: "http://127.0.0.1:1/no-network",
        reasoning: true,
        input: ["text"],
        cost: NO_COST,
        contextWindow: 16_000,
        maxTokens: 2_000,
      },
    ],
  });
  await runtime.getAvailable(providerId);
  const registry = new ModelRegistry(runtime);
  const model = registry.getAvailable()[0];
  assert.ok(model, "fake provider model must be available");
  const modelKey = `${model.provider}/${model.id}`;
  writeConfig(modelKey);
  provider.responder = makeResponder({ modelKey, provider });

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    extensionFactories: [{ name: "subagents-v2", factory: subagentsV2 }],
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
  });
  await loader.reload();

  const errors: string[] = [];
  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(workspace),
    settingsManager,
  });
  const harness: ParentHarness = {
    root,
    workspace,
    provider,
    session,
    errors,
    async cleanup() {
      try {
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      } finally {
        session.dispose();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  };
  try {
    await session.bindExtensions({
      mode: "print",
      onError: (error) => errors.push(error.error),
    });
  } catch (error) {
    await harness.cleanup();
    throw error;
  }
  return harness;
}

function spawnArgs(modelKey: string): Record<string, string> {
  return {
    name: "worker-one",
    task: "Produce the worker answer.",
    model: modelKey,
    reasoning: "low",
  };
}

function messageText(message: unknown): string {
  if (message === null || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part !== null &&
      typeof part === "object" &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("\n");
}

function contextText(context: TranscriptContext): string {
  return context.messages.map(messageText).join("\n");
}

interface SessionCustomMessage {
  role: "custom";
  customType: string;
  content: string | readonly unknown[];
  details?: unknown;
}

function findCustomMessage(
  session: AgentSession,
  customType: string,
): SessionCustomMessage | undefined {
  for (const entry of session.messages as readonly unknown[]) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      (entry as { role?: unknown }).role === "custom" &&
      (entry as { customType?: unknown }).customType === customType
    )
      return entry as SessionCustomMessage;
  }
  return undefined;
}

function customMessageText(message: SessionCustomMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map(messageText).join("\n");
}

interface ResultNotificationDetails {
  communications?: Array<{
    action?: string;
    status?: string;
    body?: string;
    workerId?: string;
    taskId?: string;
  }>;
  results?: Array<{ workerId?: string; taskId?: string; status?: string }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("real Pi scheduling: stale FYIs stay out of context and the settled result triggers exactly one follow-up", async () => {
  const gate = deferred<void>();
  const harness = await createParentHarness(
    ({ modelKey }) =>
      async ({ model, count }) => {
        if (count === 1)
          return assistantMessage(
            model,
            [toolCall("spawn-1", "subagent_spawn", spawnArgs(modelKey))],
            "toolUse",
          );
        if (count === 2) {
          await gate.promise;
          return textReply(model, "parent interim reply");
        }
        return textReply(model, "parent acknowledged the result");
      },
  );
  const stub = stubWorkerFactory();
  try {
    const prompt = harness.session.prompt("delegate the work");
    await within(
      harness.provider.waitForRequests(2),
      "the spawn did not reach the second provider turn",
    );
    const worker = await waitForWorker(stub);
    const taskId = worker.record.tasks[0]?.id;
    assert.ok(taskId, "the spawned worker must have a task");

    worker.report("fyi", "progress-1");
    worker.report("fyi", "progress-2");
    worker.complete("final worker answer");
    gate.resolve();

    await within(prompt, "the parent prompt did not resolve");
    await within(
      harness.session.waitForIdle(),
      "the automatic follow-up run did not settle",
    );

    assert.equal(
      harness.provider.requests.length,
      3,
      "worker completion must trigger exactly one automatic follow-up turn",
    );
    const followUpContext = contextText(harness.provider.requests[2]!);
    assert.match(followUpContext, /final worker answer/);
    assert.match(followUpContext, /Action:/);
    assert.match(followUpContext, new RegExp(worker.record.id));
    assert.match(followUpContext, /subagent_list/);
    assert.doesNotMatch(
      followUpContext,
      /progress-1/,
      "a stale FYI superseded by completion must not enter parent context",
    );
    assert.doesNotMatch(followUpContext, /progress-2/);
    assert.equal(
      findCustomMessage(harness.session, "subagents-v2-fyi"),
      undefined,
      "superseded FYIs must not be delivered",
    );

    const custom = findCustomMessage(harness.session, "subagents-v2-results");
    assert.ok(custom, "the settled result must be a custom result message");
    const customContent = customMessageText(custom);
    assert.match(customContent, /Action:/);
    assert.match(customContent, new RegExp(worker.record.id));
    assert.match(customContent, /subagent_list/);
    const details = custom.details as ResultNotificationDetails | undefined;
    assert.ok(details, "the result message must carry its DTO");
    assert.equal(details.results?.length, 1);
    assert.equal(details.results?.[0]?.workerId, worker.record.id);
    assert.equal(details.results?.[0]?.taskId, taskId);
    assert.equal(details.results?.[0]?.status, "completed");
    assert.equal(details.communications?.[0]?.action, "RESULT");
    assert.equal(details.communications?.[0]?.status, "completed");
    assert.match(
      String(details.communications?.[0]?.body),
      /final worker answer/,
      "the DTO keeps the full worker body",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    gate.resolve();
    stub.restore();
    await harness.cleanup();
  }
});

test("real Pi scheduling: an explicit task inspection before settle prevents the automatic result turn", async () => {
  const gate = deferred<void>();
  const workerId = { value: "" };
  const harness = await createParentHarness(
    ({ modelKey }) =>
      async ({ model, count }) => {
        if (count === 1)
          return assistantMessage(
            model,
            [toolCall("spawn-1", "subagent_spawn", spawnArgs(modelKey))],
            "toolUse",
          );
        if (count === 2) {
          await gate.promise;
          return assistantMessage(
            model,
            [
              toolCall("inspect-1", "subagent_list", {
                id: workerId.value,
              }),
            ],
            "toolUse",
          );
        }
        return textReply(model, "parent acknowledged the inspection");
      },
  );
  const stub = stubWorkerFactory();
  try {
    const prompt = harness.session.prompt("delegate the work");
    await within(
      harness.provider.waitForRequests(2),
      "the spawn did not reach the second provider turn",
    );
    const worker = await waitForWorker(stub);
    workerId.value = worker.record.id;
    worker.complete("inspect me now");
    gate.resolve();

    await within(prompt, "the parent prompt did not resolve");
    await within(
      harness.session.waitForIdle(),
      "the parent run did not settle after inspection",
    );

    assert.equal(
      harness.provider.requests.length,
      3,
      "an inspected result must not trigger an extra automatic turn",
    );
    const toolResultContext = contextText(harness.provider.requests[2]!);
    assert.match(
      toolResultContext,
      /inspect me now/,
      "the real subagent_list tool result must reach the parent model",
    );
    assert.equal(
      findCustomMessage(harness.session, "subagents-v2-results"),
      undefined,
      "an acknowledged result must not be auto-delivered again",
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    gate.resolve();
    stub.restore();
    await harness.cleanup();
  }
});

test("real Pi scheduling: useful FYI reaches the next natural model turn without a new run", async () => {
  const gate = deferred<void>();
  const harness = await createParentHarness(
    ({ modelKey }) =>
      async ({ model, count }) => {
        if (count === 1)
          return assistantMessage(
            model,
            [toolCall("spawn-1", "subagent_spawn", spawnArgs(modelKey))],
            "toolUse",
          );
        if (count === 2) {
          await gate.promise;
          return assistantMessage(
            model,
            [toolCall("roster-1", "subagent_list", {})],
            "toolUse",
          );
        }
        return textReply(model, "parent finishes normally");
      },
  );
  const stub = stubWorkerFactory();
  try {
    const prompt = harness.session.prompt("delegate then continue useful work");
    await within(
      harness.provider.waitForRequests(2),
      "parent did not start second request",
    );
    const worker = await waitForWorker(stub);
    worker.report("fyi", "outdated progress");
    worker.report("fyi", "CURRENT_PROGRESS_CONTRACT");
    assert.equal(
      findCustomMessage(harness.session, "subagents-v2-fyi"),
      undefined,
    );
    gate.resolve();
    await within(prompt, "parent did not finish");
    await within(harness.session.waitForIdle(), "parent did not settle");
    assert.equal(harness.provider.requests.length, 3);
    const nextTurn = contextText(harness.provider.requests[2]!);
    assert.match(nextTurn, /CURRENT_PROGRESS_CONTRACT/);
    assert.doesNotMatch(nextTurn, /outdated progress/);
    assert.equal(
      findCustomMessage(harness.session, "subagents-v2-results"),
      undefined,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    gate.resolve();
    stub.restore();
    await harness.cleanup();
  }
});

test("real Pi scheduling: an FYI-only flush starts no parent run and keeps only the latest progress", async () => {
  const gate = deferred<void>();
  const harness = await createParentHarness(
    ({ modelKey }) =>
      async ({ model, count }) => {
        if (count === 1)
          return assistantMessage(
            model,
            [toolCall("spawn-1", "subagent_spawn", spawnArgs(modelKey))],
            "toolUse",
          );
        if (count === 2) {
          await gate.promise;
          return textReply(model, "parent interim reply");
        }
        return textReply(model, "unexpected extra parent run");
      },
  );
  const stub = stubWorkerFactory();
  try {
    const prompt = harness.session.prompt("delegate the work");
    await within(
      harness.provider.waitForRequests(2),
      "the spawn did not reach the second provider turn",
    );
    const worker = await waitForWorker(stub);

    worker.report("fyi", "progress-1");
    worker.report("fyi", "progress-2");
    gate.resolve();

    await within(prompt, "the parent prompt did not resolve");
    await within(
      harness.session.waitForIdle(),
      "the FYI-only flush did not settle",
    );

    assert.equal(
      harness.provider.requests.length,
      2,
      "an FYI-only flush must not start a new parent model run",
    );
    const fyi = findCustomMessage(harness.session, "subagents-v2-fyi");
    assert.ok(fyi, "the latest FYI must be delivered as a custom message");
    const content = customMessageText(fyi);
    assert.match(content, /progress-2/);
    assert.doesNotMatch(
      content,
      /progress-1/,
      "only the latest FYI per task may survive",
    );
    assert.equal(
      findCustomMessage(harness.session, "subagents-v2-results"),
      undefined,
    );
    assert.deepEqual(harness.errors, []);
  } finally {
    gate.resolve();
    stub.restore();
    await harness.cleanup();
  }
});
