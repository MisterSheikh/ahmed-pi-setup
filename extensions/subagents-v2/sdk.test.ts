import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Type } from "typebox";
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
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { SubagentManager, type TaskResult } from "./src/manager.ts";
import { PiWorkerSessionFactory } from "./src/pi-session.ts";
import type {
  SubagentsConfig,
  WorkerPresentation,
  WorkerRecord,
  WorkerSession,
} from "./src/types.ts";

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
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const BG_EXTENSION = path.join(REPO_ROOT, "extensions/background-terminals");

interface FakeRequest {
  model: Model<Api>;
  context: TranscriptContext;
  count: number;
  signal?: AbortSignal;
}

type FakeResponse = Omit<AssistantMessage, "stopReason"> & {
  stopReason: "stop" | "toolUse" | "error" | "aborted";
};

type Responder = (request: FakeRequest) => FakeResponse | Promise<FakeResponse>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function within<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 8_000,
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
    } else if (block.type === "thinking") {
      const partialBlock = { type: "thinking" as const, thinking: "" };
      partial.content.push(partialBlock);
      stream.push({ type: "thinking_start", contentIndex, partial });
      partialBlock.thinking = block.thinking;
      stream.push({
        type: "thinking_delta",
        contentIndex,
        delta: block.thinking,
        partial,
      });
      stream.push({
        type: "thinking_end",
        contentIndex,
        content: block.thinking,
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

class FakeProvider {
  readonly requests: TranscriptContext[] = [];
  private readonly requestWaiters: Array<{
    count: number;
    resolve: () => void;
  }> = [];
  private readonly responseWaiters: Array<{
    count: number;
    resolve: () => void;
  }> = [];
  private responses = 0;
  private responder: Responder;

  constructor(responder: Responder) {
    this.responder = responder;
  }

  waitForRequests(count: number) {
    if (this.requests.length >= count) return Promise.resolve();
    return new Promise<void>((resolve) =>
      this.requestWaiters.push({ count, resolve }),
    );
  }

  waitForResponses(count: number) {
    if (this.responses >= count) return Promise.resolve();
    return new Promise<void>((resolve) =>
      this.responseWaiters.push({ count, resolve }),
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
      Promise.resolve().then(() =>
        this.responder({
          model,
          context,
          count,
          signal: options?.signal,
        }),
      ),
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

interface HarnessOptions {
  loadBackgroundTerminals?: boolean;
  loadRestrictedExtensions?: boolean;
  extraExtensionFactories?: InlineExtension[];
  responder: Responder;
}

interface SdkHarness {
  root: string;
  agentDir: string;
  workspace: string;
  sessionRoot: string;
  provider: FakeProvider;
  registry: ModelRegistry;
  factory: PiWorkerSessionFactory;
  cleanup(): void;
}

let harnessSequence = 0;

async function createHarness(options: HarnessOptions): Promise<SdkHarness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-v2-sdk-"));
  const agentDir = path.join(root, "agent");
  const workspace = path.join(root, "workspace");
  const sessionRoot = path.join(root, "worker-sessions");
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(workspace, "AGENTS.md"),
    "# Test workspace instructions\nFollow AGENTS_TEST_DIRECTIVE_47 exactly.\n",
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
      compaction: { enabled: false },
    }),
    { mode: 0o600 },
  );

  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });

  try {
    if (options.loadBackgroundTerminals) {
      const extensionDir = path.join(agentDir, "extensions");
      fs.mkdirSync(extensionDir, { recursive: true, mode: 0o700 });
      fs.symlinkSync(
        BG_EXTENSION,
        path.join(extensionDir, "background-terminals"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    if (options.loadRestrictedExtensions) {
      const extensionDir = path.join(agentDir, "extensions");
      fs.mkdirSync(extensionDir, { recursive: true, mode: 0o700 });
      for (const name of ["subagents", "ask-user"]) {
        fs.symlinkSync(
          path.join(REPO_ROOT, "extensions", name),
          path.join(extensionDir, name),
          process.platform === "win32" ? "junction" : "dir",
        );
      }
    }

    const providerId = `subagents-v2-sdk-${process.pid}-${++harnessSequence}`;
    const api = `${providerId}-api`;
    const provider = new FakeProvider(options.responder);
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    runtime.registerProvider(providerId, {
      name: "Subagents SDK test provider",
      api,
      apiKey: "test-only-no-network",
      streamSimple: provider.streamSimple,
      models: [
        {
          id: MODEL_ID,
          name: "Subagents SDK test model",
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
    const factory = new PiWorkerSessionFactory({
      registry,
      agentDir,
      parentCwd: workspace,
      projectTrusted: true,
      sessionRoot,
      modelRuntime: runtime,
      extraExtensionFactories: options.extraExtensionFactories,
    });
    return {
      root,
      agentDir,
      workspace,
      sessionRoot,
      provider,
      registry,
      factory,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function testConfig(): SubagentsConfig {
  return {
    version: 2,
    enabled: true,
    allowedModels: [],
    modelReasoning: {},
    maxActive: 4,
  };
}

function managerFor(harness: SdkHarness) {
  const settled: TaskResult[] = [];
  const cleanupErrors: string[] = [];
  const manager = new SubagentManager({
    factory: harness.factory,
    getConfig: testConfig,
    persist: () => {},
    onSettled: (result) => settled.push(result),
    onFyi: () => {},
    onCleanupError: (message) => cleanupErrors.push(message),
  });
  return { manager, settled, cleanupErrors };
}

function taskFor(harness: SdkHarness, name: string, brief: string) {
  const model = harness.registry.getAvailable()[0];
  assert.ok(model, "fake provider model must be available");
  return {
    name,
    brief,
    cwd: harness.workspace,
    model: `${model.provider}/${MODEL_ID}`,
    reasoning: "low" as const,
  };
}

function workerRecord(harness: SdkHarness, name: string): WorkerRecord {
  const now = Date.now();
  const model = harness.registry.getAvailable()[0];
  assert.ok(model, "fake provider model must be available");
  return {
    id: `sdk-worker-${name}`,
    name,
    cwd: harness.workspace,
    model: `${model.provider}/${model.id}`,
    reasoning: "low",
    createdAt: now,
    updatedAt: now,
    takenOver: false,
    tasks: [],
  };
}

function toolNames(context: TranscriptContext) {
  return new Set(
    context.messages.flatMap((message) =>
      message.role === "system"
        ? (message.toolsAdded ?? []).map((tool) => tool.name)
        : [],
    ),
  );
}

function systemText(context: TranscriptContext) {
  return context.messages
    .filter((message) => message.role === "system")
    .flatMap((message) => [
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text).join("\n"),
      ...Object.values(message.sections ?? {}).filter(
        (section): section is string => typeof section === "string",
      ),
    ])
    .join("\n");
}

function waitForTask(
  manager: SubagentManager,
  workerId: string,
): Promise<TaskResult[]> {
  return within(
    manager.wait([workerId], "all"),
    `worker ${workerId} did not settle`,
  );
}

async function waitForFile(file: string) {
  await within(
    (async () => {
      while (!fs.existsSync(file))
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
    })(),
    `timed out waiting for ${file}`,
  );
}

async function waitUntil(predicate: () => boolean, message: string) {
  await within(
    (async () => {
      while (!predicate())
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
    })(),
    message,
  );
}

function processIsRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stubbornBackgroundCommand(harness: SdkHarness, label: string) {
  const scriptFile = path.join(harness.root, `${label}.cjs`);
  const pidFile = path.join(harness.root, `${label}.pid`);
  const readyFile = path.join(harness.root, `${label}.ready`);
  const termFile = path.join(harness.root, `${label}.term`);
  fs.writeFileSync(
    scriptFile,
    [
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      `process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(termFile)}, "term"));`,
      `fs.writeFileSync(${JSON.stringify(readyFile)}, "ready");`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    { mode: 0o600 },
  );
  return {
    pidFile,
    readyFile,
    termFile,
    command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptFile)}`,
  };
}

for (const reportKind of ["question", "blocked"] as const) {
  test(`Pi SDK report ${reportKind} stops a batched turn with a sibling tool`, async () => {
    const harness = await createHarness({
      loadBackgroundTerminals: true,
      responder: ({ model, count }) =>
        count === 1
          ? assistantMessage(
              model,
              [
                toolCall("report-call", "subagent_report", {
                  kind: reportKind,
                  message: `Need parent input: ${reportKind}`,
                }),
                toolCall("sibling-call", "bg_list", {}),
              ],
              "toolUse",
            )
          : textReply(
              model,
              "This continuation must not be used as completion.",
            ),
    });
    const { manager, settled } = managerFor(harness);

    try {
      const worker = manager.spawn(
        taskFor(
          harness,
          `${reportKind}-report`,
          "Report if parent input is needed.",
        ),
      );
      const [result] = await waitForTask(manager, worker.id);

      assert.equal(result?.task.status, reportKind);
      assert.equal(result?.task.report?.kind, reportKind);
      assert.equal(
        result?.task.report?.message,
        `Need parent input: ${reportKind}`,
      );
      assert.ok(
        manager
          .transcript(worker.id)
          .some(
            (item) => item.role === "tool" && item.text.startsWith("bg_list:"),
          ),
        "the batched background tool should complete and enter the worker transcript",
      );
      const firstRequest = harness.provider.requests[0];
      assert.ok(firstRequest);
      assert.ok(
        toolNames(firstRequest).has("bg_list"),
        "the unchanged background-terminals extension supplies the sibling tool",
      );
      assert.equal(
        harness.provider.requests.length,
        1,
        "a question or blocker must prevent another provider turn",
      );
      assert.equal(settled.length, 1);
    } finally {
      await manager.dispose();
      harness.cleanup();
    }
  });
}

test("Pi SDK waits through a retrying tool continuation and never reuses prior output", async () => {
  const finalRequest = deferred<FakeResponse>();
  const harness = await createHarness({
    loadBackgroundTerminals: true,
    responder: ({ model, count }) => {
      if (count === 1) return textReply(model, "PRIOR_TASK_ONLY_RESULT");
      if (count === 2) {
        return assistantMessage(
          model,
          [toolCall("continuation-call", "bg_list", {})],
          "toolUse",
        );
      }
      if (count === 3)
        return failedReply(model, "HTTP 503 temporary rate limit");
      if (count === 4) return finalRequest.promise;
      return failedReply(model, "synthetic fake-provider failure");
    },
  });
  const { manager, settled } = managerFor(harness);

  try {
    const worker = manager.spawn(
      taskFor(harness, "retry-and-follow-up", "Complete the first task."),
    );
    const [first] = await waitForTask(manager, worker.id);
    assert.ok(first);
    assert.equal(first.task.result, "PRIOR_TASK_ONLY_RESULT");
    assert.equal(first.task.status, "completed");

    const followup = manager.followup(worker.id, "Run the follow-up task.");
    await within(
      harness.provider.waitForRequests(4),
      "Pi did not retry the transient failure after the tool continuation",
    );
    await harness.provider.waitForResponses(3);

    assert.ok(
      manager
        .transcript(worker.id)
        .some(
          (item) => item.role === "tool" && item.text.startsWith("bg_list:"),
        ),
      "the continuation tool should complete before the retry response",
    );
    assert.equal(manager.activeCount(), 1);
    assert.equal(manager.get(worker.id)?.tasks[1]?.status, "working");
    assert.deepEqual(
      settled.map(({ task }) => task.id),
      [first.task.id],
      "tool-call and retry output is not a settled task result",
    );

    finalRequest.resolve(
      failedReply(
        harness.registry.getAvailable()[0]!,
        "synthetic final follow-up failure",
      ),
    );
    const [failed] = await waitForTask(manager, worker.id);

    assert.equal(failed?.task.id, followup.task.id);
    assert.equal(failed?.task.status, "failed");
    assert.equal(failed?.task.error, "synthetic final follow-up failure");
    assert.equal(failed?.task.result, "");
    assert.equal(
      manager.get(worker.id)?.tasks[0]?.result,
      "PRIOR_TASK_ONLY_RESULT",
    );
    assert.equal(manager.activeCount(), 0);
    assert.equal(
      settled.length,
      2,
      "the failed follow-up settles exactly once",
    );
  } finally {
    const model = harness.registry.getAvailable()[0];
    if (model) finalRequest.resolve(failedReply(model, "test cleanup"));
    await manager.dispose();
    harness.cleanup();
  }
});

test("Pi SDK queued continuations stay in the current task until final settlement", async () => {
  const final = deferred<FakeResponse>();
  const harness = await createHarness({
    extraExtensionFactories: [
      {
        name: "queued-continuation",
        factory: (pi) => {
          let queued = false;
          pi.on("agent_end", () => {
            if (queued) return;
            queued = true;
            pi.sendMessage(
              {
                customType: "continuation-test",
                content: "Continue this task.",
                display: false,
              },
              { deliverAs: "followUp", triggerTurn: true },
            );
          });
        },
      },
    ],
    responder: ({ model, count }) =>
      count === 1 ? textReply(model, "INTERIM") : final.promise,
  });
  const { manager, settled } = managerFor(harness);
  try {
    const worker = manager.spawn(
      taskFor(harness, "queued", "Complete the task."),
    );
    await within(
      harness.provider.waitForRequests(2),
      "queued continuation was not started",
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      manager.activeCount(),
      1,
      "queued continuation must retain its slot",
    );
    assert.equal(settled.length, 0, "an interim run is not a task result");
    final.resolve(textReply(harness.registry.getAvailable()[0]!, "FINAL"));
    const [result] = await waitForTask(manager, worker.id);
    assert.equal(result?.task.status, "completed");
    assert.equal(result?.task.result, "FINAL");
  } finally {
    final.resolve(textReply(harness.registry.getAvailable()[0]!, "cleanup"));
    await manager.dispose();
    harness.cleanup();
  }
});

test("Pi SDK workers receive workspace instructions without parent history and stay outside normal resume discovery", async () => {
  const safeWorkspaceExtensions: InlineExtension[] = [
    {
      name: "file-search",
      factory: (pi) => {
        for (const name of ["fd", "rg"]) {
          pi.registerTool({
            name,
            label: name,
            description: "Safe file-search resource.",
            parameters: Type.Object({}),
            async execute() {
              return {
                content: [{ type: "text", text: "safe search" }],
                details: {},
              };
            },
          });
        }
      },
    },
    {
      name: "web-search",
      factory: (pi) => {
        pi.registerTool({
          name: "web",
          label: "Web",
          description: "Safe web-search resource.",
          parameters: Type.Object({}),
          async execute() {
            return {
              content: [{ type: "text", text: "safe web" }],
              details: {},
            };
          },
        });
      },
    },
  ];
  const blockedWorkerExtensions: InlineExtension[] = [
    {
      name: "subagents",
      factory: (pi) => {
        for (const name of ["subagent_spawn", "worker_private_tool"]) {
          pi.registerTool({
            name,
            label: name,
            description: "Must not reach a worker.",
            parameters: Type.Object({}),
            async execute() {
              return {
                content: [{ type: "text", text: "blocked" }],
                details: {},
              };
            },
          });
        }
      },
    },
    {
      name: "peer-tools",
      factory: (pi) => {
        pi.registerTool({
          name: "message_peer",
          label: "Peer",
          description: "Must not reach a worker.",
          parameters: Type.Object({}),
          async execute() {
            return {
              content: [{ type: "text", text: "blocked" }],
              details: {},
            };
          },
        });
      },
    },
  ];
  const harness = await createHarness({
    loadRestrictedExtensions: true,
    extraExtensionFactories: [
      ...safeWorkspaceExtensions,
      ...blockedWorkerExtensions,
    ],
    responder: ({ model }) => textReply(model, "isolated worker result"),
  });
  const parentHistoryMarker = "PARENT_PRIVATE_HISTORY_MARKER_9921";
  const parentSessionDir = path.join(
    harness.agentDir,
    "sessions",
    `--${path
      .resolve(harness.workspace)
      .replace(/^[/\\]/, "")
      .replace(/[/\\:]/g, "-")}--`,
  );
  const parentSession = SessionManager.create(
    harness.workspace,
    parentSessionDir,
  );
  parentSession.appendMessage({
    role: "user",
    content: parentHistoryMarker,
    timestamp: Date.now(),
  });
  const parentModel = harness.registry.getAvailable()[0];
  assert.ok(parentModel);
  parentSession.appendMessage(
    assistantMessage(
      parentModel,
      [{ type: "text", text: "parent-only reply" }],
      "stop",
    ),
  );
  const parentSessionFile = parentSession.getSessionFile();
  assert.ok(parentSessionFile);

  let workerSession: WorkerSession | undefined;
  try {
    const outcome = deferred<{
      result: string;
      error?: string;
      interrupted?: boolean;
    }>();
    workerSession = await harness.factory.create(
      workerRecord(harness, "isolation"),
      {
        onStarted: () => {},
        onReport: () => {},
        onSettled: (result) => outcome.resolve(result),
      },
    );
    workerSession.start("WORKER_TASK_BRIEF_ONLY");
    const result = await within(
      outcome.promise,
      "isolated SDK worker did not finish",
    );
    assert.equal(result.result, "isolated worker result");

    const [request] = harness.provider.requests;
    assert.ok(request, "worker should have made a provider request");
    const promptAndHistory = JSON.stringify(request.messages);
    assert.ok(systemText(request).includes("AGENTS_TEST_DIRECTIVE_47"));
    assert.ok(promptAndHistory.includes("WORKER_TASK_BRIEF_ONLY"));
    assert.equal(promptAndHistory.includes(parentHistoryMarker), false);

    const names = toolNames(request);
    assert.ok(names.has("read"), "normal workspace tools remain available");
    assert.ok(names.has("bash"), "normal workspace tools remain available");
    assert.ok(
      names.has("fd"),
      `safe file-search tools remain available; loaded: ${[...names].join(", ")}`,
    );
    assert.ok(names.has("rg"), "safe file-search tools remain available");
    assert.ok(names.has("web"), "safe web-search tools remain available");
    assert.ok(
      names.has("subagent_report"),
      "workers can report to their parent",
    );
    for (const name of [
      "subagent_spawn",
      "subagent_followup",
      "subagent_steer",
      "ask_user",
      "request_user_input",
      "message_peer",
      "worker_private_tool",
    ]) {
      assert.equal(
        names.has(name),
        false,
        `${name} must be excluded from worker tools`,
      );
    }

    const sessionFile = workerSession.sessionFile;
    assert.ok(sessionFile);
    assert.equal(fs.existsSync(sessionFile), true);
    assert.equal(
      path.relative(harness.sessionRoot, sessionFile).startsWith(".."),
      false,
      "worker transcript belongs under its private session root",
    );
    const normallyDiscoverable = await SessionManager.list(
      harness.workspace,
      parentSessionDir,
    );
    assert.ok(
      normallyDiscoverable.some(
        (session) => session.path === parentSessionFile,
      ),
    );
    assert.equal(
      normallyDiscoverable.some((session) => session.path === sessionFile),
      false,
      "normal project resume discovery must not list worker sessions",
    );
  } finally {
    await workerSession?.close();
    harness.cleanup();
  }
});

test("Pi SDK treats task briefs as ordinary text instead of running slash commands", async () => {
  let commandRuns = 0;
  const commandExtension: InlineExtension = {
    name: "task-command-test",
    factory: (pi) => {
      pi.registerCommand("run-task-command", {
        description: "test command",
        handler: async () => {
          commandRuns++;
        },
      });
    },
  };
  const harness = await createHarness({
    extraExtensionFactories: [commandExtension],
    responder: ({ model, context }) => {
      const prompt = JSON.stringify(context.messages);
      assert.ok(prompt.includes("/run-task-command"));
      return textReply(model, "The slash command stayed ordinary task text.");
    },
  });
  const { manager } = managerFor(harness);

  try {
    const worker = manager.spawn(
      taskFor(harness, "slash-brief", "/run-task-command do not execute this"),
    );
    const [result] = await waitForTask(manager, worker.id);
    assert.equal(result?.task.status, "completed");
    assert.equal(commandRuns, 0);
    assert.equal(harness.provider.requests.length, 1);
  } finally {
    await manager.dispose();
    harness.cleanup();
  }
});

test("Pi SDK settles a handled-input brief without waiting for a model run", async () => {
  const handledBrief = "HANDLED_EXTENSION_INPUT_NO_MODEL";
  const inputExtension: InlineExtension = {
    name: "handled-input-test",
    factory: (pi) => {
      pi.on("input", (event) =>
        event.text === handledBrief
          ? { action: "handled" }
          : { action: "continue" },
      );
    },
  };
  const harness = await createHarness({
    extraExtensionFactories: [inputExtension],
    responder: ({ model }) => textReply(model, "unexpected model run"),
  });
  const { manager } = managerFor(harness);

  try {
    const worker = manager.spawn(
      taskFor(harness, "handled-input", handledBrief),
    );
    const [result] = await waitForTask(manager, worker.id);
    assert.equal(result?.task.status, "completed");
    assert.equal(result?.task.result, "");
    assert.equal(harness.provider.requests.length, 0);
    assert.equal(manager.activeCount(), 0);
  } finally {
    await manager.dispose();
    harness.cleanup();
  }
});

test("restored Pi transcripts reject empty and malformed files without modifying them", async () => {
  const harness = await createHarness({
    responder: ({ model }) => textReply(model, "unused"),
  });
  fs.mkdirSync(harness.sessionRoot, { recursive: true });
  const emptyPath = path.join(harness.sessionRoot, "empty.jsonl");
  const malformedPath = path.join(harness.sessionRoot, "malformed.jsonl");
  fs.writeFileSync(emptyPath, "", { mode: 0o600 });
  const malformedBytes =
    '{"type":"session","version":3,"id":"broken","timestamp":"now","cwd":"/tmp"}\nnot-json\n';
  fs.writeFileSync(malformedPath, malformedBytes, { mode: 0o600 });
  const validSession = SessionManager.create(
    harness.workspace,
    harness.sessionRoot,
  );
  validSession.appendMessage({
    role: "user",
    content: "valid restored transcript",
    timestamp: Date.now(),
  });
  const model = harness.registry.getAvailable()[0];
  assert.ok(model);
  validSession.appendMessage(
    assistantMessage(model, [{ type: "text", text: "saved" }], "stop"),
  );
  const validPath = validSession.getSessionFile();
  assert.ok(validPath);
  const validBytes = fs.readFileSync(validPath, "utf8");
  const manager = new SubagentManager({
    factory: harness.factory,
    restored: [
      { ...workerRecord(harness, "empty"), sessionFile: emptyPath },
      { ...workerRecord(harness, "malformed"), sessionFile: malformedPath },
      { ...workerRecord(harness, "valid"), sessionFile: validPath },
    ],
    getConfig: testConfig,
    persist: () => {},
    onSettled: () => {},
    onFyi: () => {},
  });

  try {
    assert.match(
      manager.get("sdk-worker-empty")?.unavailableReason ?? "",
      /empty/i,
    );
    assert.match(
      manager.get("sdk-worker-malformed")?.unavailableReason ?? "",
      /invalid|session/i,
    );
    assert.equal(manager.get("sdk-worker-valid")?.unavailableReason, undefined);
    assert.equal(fs.readFileSync(emptyPath, "utf8"), "");
    assert.equal(fs.readFileSync(malformedPath, "utf8"), malformedBytes);
    assert.equal(fs.readFileSync(validPath, "utf8"), validBytes);
  } finally {
    await manager.dispose();
    harness.cleanup();
  }
});

test("Pi SDK interruption stops owned background processes before releasing the slot", async () => {
  let harness!: SdkHarness;
  let processFiles: ReturnType<typeof stubbornBackgroundCommand> | undefined;
  harness = await createHarness({
    loadBackgroundTerminals: true,
    responder: ({ model, count }) => {
      if (count === 1) {
        processFiles = stubbornBackgroundCommand(harness, "interrupt-owned");
        return assistantMessage(
          model,
          [
            toolCall("interrupt-background", "bg_start", {
              command: processFiles.command,
              title: "interrupt cleanup test",
              working_dir: harness.workspace,
            }),
          ],
          "toolUse",
        );
      }
      return textReply(model, "Waiting for the background process.");
    },
  });
  const { manager } = managerFor(harness);

  try {
    const worker = manager.spawn(
      taskFor(harness, "interrupt-owned", "Start a process and wait."),
    );
    await within(
      harness.provider.waitForResponses(2),
      "worker did not start and wait on its background process",
    );
    assert.ok(processFiles);
    await waitForFile(processFiles.pidFile);
    const pid = Number(fs.readFileSync(processFiles.pidFile, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.equal(manager.activeCount(), 1);

    const interrupt = manager.interrupt(worker.id);
    assert.equal(manager.get(worker.id)?.tasks[0]?.status, "stopping");
    await waitForFile(processFiles.termFile);
    assert.equal(processIsRunning(pid), true);
    assert.equal(
      manager.activeCount(),
      1,
      "slot stays reserved while kill settles",
    );

    const result = await within(interrupt, "worker interrupt did not finish");
    assert.equal(result.task.status, "interrupted");
    assert.equal(manager.activeCount(), 0);
    assert.equal(
      processIsRunning(pid),
      false,
      "owned process tree was stopped",
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(
      harness.provider.requests.length,
      2,
      "a killed process notification must not start another model turn",
    );
  } finally {
    await manager.dispose();
    harness.cleanup();
  }
});

test("Pi SDK question cleanup stops a sibling background process before pausing", async () => {
  let harness!: SdkHarness;
  let processFiles: ReturnType<typeof stubbornBackgroundCommand> | undefined;
  harness = await createHarness({
    loadBackgroundTerminals: true,
    responder: ({ model, count }) => {
      if (count === 1) {
        processFiles = stubbornBackgroundCommand(harness, "question-owned");
        return assistantMessage(
          model,
          [
            toolCall("question-background", "bg_start", {
              command: processFiles.command,
              title: "question cleanup test",
              working_dir: harness.workspace,
            }),
          ],
          "toolUse",
        );
      }
      return (async () => {
        assert.ok(processFiles);
        await waitForFile(processFiles.readyFile);
        return assistantMessage(
          model,
          [
            toolCall("question-report", "subagent_report", {
              kind: "question",
              message: "Need parent input before continuing.",
            }),
          ],
          "toolUse",
        );
      })();
    },
  });
  const { manager, cleanupErrors } = managerFor(harness);

  try {
    const worker = manager.spawn(
      taskFor(harness, "question-owned", "Ask the parent and stop."),
    );
    await within(
      harness.provider.waitForResponses(2),
      "worker did not report its question after starting the process",
    );
    assert.ok(processFiles);
    await waitForFile(processFiles.readyFile);
    await waitForFile(processFiles.pidFile);
    const pid = Number(fs.readFileSync(processFiles.pidFile, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 0);
    const cleanupWindowEnds = Date.now() + 1_000;
    let observedProcessAlive = false;
    while (processIsRunning(pid) && Date.now() < cleanupWindowEnds) {
      observedProcessAlive = true;
      assert.equal(
        manager.activeCount(),
        1,
        "question retains capacity while its process is still running",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }

    const [result] = await waitForTask(manager, worker.id);
    assert.equal(result?.task.status, "question");
    assert.equal(result?.task.report?.kind, "question");
    assert.equal(observedProcessAlive, true);
    assert.equal(manager.activeCount(), 0);
    assert.equal(processIsRunning(pid), false);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(harness.provider.requests.length, 2);
    assert.deepEqual(cleanupErrors, []);
  } finally {
    await manager.dispose();
    harness.cleanup();
  }
});

test("Pi SDK cleans up background work promptly without erasing a run failure", async () => {
  let harness!: SdkHarness;
  let processFiles: ReturnType<typeof stubbornBackgroundCommand> | undefined;
  harness = await createHarness({
    loadBackgroundTerminals: true,
    responder: ({ model, count }) => {
      if (count === 1) {
        processFiles = stubbornBackgroundCommand(harness, "failed-owned");
        return assistantMessage(
          model,
          [
            toolCall("failed-background", "bg_start", {
              command: processFiles.command,
              title: "failed task cleanup test",
              working_dir: harness.workspace,
            }),
          ],
          "toolUse",
        );
      }
      return (async () => {
        assert.ok(processFiles);
        await waitForFile(processFiles.readyFile);
        return failedReply(model, "synthetic failure with process outstanding");
      })();
    },
  });
  const { manager } = managerFor(harness);

  try {
    const worker = manager.spawn(
      taskFor(harness, "failed-owned", "Start a process, then fail."),
    );
    await within(
      harness.provider.waitForResponses(2),
      "worker did not fail while its background process was active",
    );
    assert.ok(processFiles);
    await waitForFile(processFiles.pidFile);
    const pid = Number(fs.readFileSync(processFiles.pidFile, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 0);

    const startedAt = Date.now();
    const [result] = await waitForTask(manager, worker.id);
    assert.equal(result?.task.status, "failed");
    assert.equal(
      result?.task.error,
      "synthetic failure with process outstanding",
    );
    assert.equal(result?.task.result, "");
    assert.equal(processIsRunning(pid), false);
    assert.ok(
      Date.now() - startedAt < 5_000,
      "cleanup should be bounded and prompt",
    );
    assert.equal(manager.activeCount(), 0);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(harness.provider.requests.length, 2);
  } finally {
    await manager.dispose();
    harness.cleanup();
  }
});

test("Pi SDK keeps a worker active through an interim final response until background output is processed", async () => {
  const finalResponse = deferred<FakeResponse>();
  let harness!: SdkHarness;
  harness = await createHarness({
    loadBackgroundTerminals: true,
    responder: ({ model, context, count }) => {
      if (count === 1) {
        const scriptFile = path.join(harness.root, "wait-for-release.cjs");
        const releaseFile = path.join(harness.root, "release-background");
        fs.writeFileSync(
          scriptFile,
          [
            'const fs = require("node:fs");',
            `const release = ${JSON.stringify(releaseFile)};`,
            "const poll = setInterval(() => {",
            "  if (!fs.existsSync(release)) return;",
            "  clearInterval(poll);",
            '  console.log("BACKGROUND_FINAL_MARKER_6812");',
            "}, 20);",
          ].join("\n"),
          { mode: 0o600 },
        );
        const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptFile)}`;
        return assistantMessage(
          model,
          [
            toolCall("background-start", "bg_start", {
              command,
              title: "required test process",
              working_dir: harness.workspace,
            }),
          ],
          "toolUse",
        );
      }
      if (count === 2)
        return textReply(
          model,
          "I started the process and am waiting for its result.",
        );
      if (count === 3) {
        const serialized = JSON.stringify(context.messages);
        assert.ok(
          serialized.includes("BACKGROUND_FINAL_MARKER_6812"),
          "background completion notification must enter the worker context before its final turn",
        );
        return finalResponse.promise;
      }
      return textReply(
        model,
        "Confirmed background output: BACKGROUND_FINAL_MARKER_6812",
      );
    },
  });
  const { manager } = managerFor(harness);

  try {
    const worker = manager.spawn(
      taskFor(
        harness,
        "background-required",
        "Start the background process, wait for its notification, inspect its output, then report the marker.",
      ),
    );
    await within(
      harness.provider.waitForRequests(2),
      "worker did not continue after starting the background process",
    );
    const initialRequest = harness.provider.requests[0];
    assert.ok(initialRequest);
    assert.ok(
      toolNames(initialRequest).has("bg_start"),
      "the real background-terminals extension must provide bg_start",
    );
    await within(
      harness.provider.waitForResponses(2),
      "worker did not produce the interim response",
    );
    for (let index = 0; index < 5; index++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.equal(manager.get(worker.id)?.tasks[0]?.status, "working");
    assert.equal(
      manager.activeCount(),
      1,
      "the worker retains its active slot during the process",
    );
    await manager.steer(
      worker.id,
      "STEERING_WHILE_WAITING_381: include the process marker.",
    );

    fs.writeFileSync(
      path.join(harness.root, "release-background"),
      "release\n",
      {
        mode: 0o600,
      },
    );
    await within(
      harness.provider.waitForRequests(3),
      "background completion did not queue a worker continuation",
    );
    for (let index = 0; index < 5; index++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    assert.equal(manager.get(worker.id)?.tasks[0]?.status, "working");
    assert.equal(
      manager.activeCount(),
      1,
      "notification processing is still part of the active task",
    );

    const model = harness.registry.getAvailable()[0];
    assert.ok(model);
    finalResponse.resolve(
      textReply(
        model,
        "Confirmed background output: BACKGROUND_FINAL_MARKER_6812",
      ),
    );
    await within(
      harness.provider.waitForResponses(3),
      "worker did not finish its final provider response",
    );
    const [result] = await within(
      manager.wait([worker.id], "all"),
      "worker did not settle after processing the background notification",
      2_000,
    );
    assert.equal(result?.task.status, "completed");
    assert.match(result?.task.result ?? "", /BACKGROUND_FINAL_MARKER_6812/);
    assert.ok(
      JSON.stringify(harness.provider.requests.slice(2)).includes(
        "STEERING_WHILE_WAITING_381",
      ),
      "steering a background-waiting worker reaches its continuation",
    );
    assert.equal(manager.activeCount(), 0);
  } finally {
    const cleanupModel = harness.registry.getAvailable()[0];
    if (cleanupModel)
      finalResponse.resolve(textReply(cleanupModel, "test cleanup"));
    await manager.dispose();
    harness.cleanup();
  }
});

test("Pi SDK presentation exposes structured transcript, tool lifecycle, streaming, and context", async () => {
  const harness = await createHarness({
    loadBackgroundTerminals: true,
    responder: ({ model, count }) => {
      if (count === 1) {
        return {
          ...assistantMessage(
            model,
            [
              { type: "thinking", thinking: "PLAN_FOR_TASK" },
              { type: "text", text: "Checking background processes." },
              toolCall("presentation-call", "bg_list", {}),
            ],
            "toolUse",
          ),
          usage: { ...ZERO_USAGE, input: 128, output: 32, totalTokens: 160 },
        };
      }
      return {
        ...textReply(model, "FINAL_PRESENTATION_RESULT"),
        usage: { ...ZERO_USAGE, input: 256, output: 16, totalTokens: 272 },
      };
    },
  });

  const worker = workerRecord(harness, "presentation");
  const snapshots: WorkerPresentation[] = [];
  const settled: Array<{
    result: string;
    error?: string;
    interrupted?: boolean;
  }> = [];
  let session!: WorkerSession;
  session = await harness.factory.create(worker, {
    onStarted: () => {},
    onReport: () => {},
    onPresentation: () => {
      const presentation = session.presentation?.();
      if (presentation) snapshots.push(presentation);
    },
    onSettled: (outcome) => settled.push(outcome),
  });

  try {
    session.start("Probe presentation.");
    await waitUntil(() => settled.length === 1, "worker never settled");
    assert.equal(settled[0]?.result, "FINAL_PRESENTATION_RESULT");

    const final = session.presentation?.();
    assert.ok(final, "presentation() must be available");
    const assistant = final.transcript.find(
      (item) =>
        item.role === "assistant" &&
        item.parts?.some((part) => part.type === "toolCall"),
    );
    assert.ok(assistant, "assistant tool call must survive in the transcript");
    assert.ok(
      assistant.parts?.some(
        (part) => part.type === "thinking" && part.text === "PLAN_FOR_TASK",
      ),
      "thinking must be preserved as a structured part",
    );
    assert.equal(assistant.text, "Checking background processes.");
    assert.ok(
      !assistant.text.includes("PLAN_FOR_TASK"),
      "plain text must not leak thinking",
    );

    const toolItem = final.transcript.find((item) => item.role === "tool");
    assert.ok(toolItem, "tool result must be present");
    assert.equal(toolItem.toolName, "bg_list");
    assert.equal(toolItem.toolCallId, "presentation-call");
    assert.equal(toolItem.isError, false);
    assert.equal(toolItem.status, "completed");

    assert.ok(
      snapshots.some((snapshot) =>
        snapshot.streamingThinking?.includes("PLAN_FOR_TASK"),
      ),
      "streaming thinking must be observable",
    );
    assert.ok(
      snapshots.some((snapshot) =>
        snapshot.streamingText?.includes("Checking background processes."),
      ),
      "streaming text must be observable",
    );
    assert.ok(
      snapshots.some((snapshot) =>
        snapshot.activeTools?.some(
          (tool) => tool.name === "bg_list" && tool.status === "running",
        ),
      ),
      "running tools must be observable",
    );
    assert.ok(
      snapshots.some((snapshot) =>
        snapshot.activeTools?.some(
          (tool) =>
            tool.name === "bg_list" &&
            tool.status === "completed" &&
            typeof tool.result === "string" &&
            tool.result.length > 0,
        ),
      ),
      "completed tools must carry a result",
    );
    assert.ok(snapshots.some((snapshot) => snapshot.activity === "thinking"));
    assert.ok(snapshots.some((snapshot) => snapshot.activity === "responding"));
    assert.equal(final.contextWindow, 16_000);
    assert.ok(
      typeof final.contextTokens === "number" && final.contextTokens > 0,
      "context tokens must be estimated after a run",
    );
    assert.equal(final.streamingText, undefined);
    assert.equal(final.streamingThinking, undefined);

    const restored = harness.factory.readTranscript({
      ...worker,
      sessionFile: session.sessionFile,
    });
    const restoredAssistant = restored.find(
      (item) =>
        item.role === "assistant" &&
        item.parts?.some(
          (part) => part.type === "thinking" && part.text === "PLAN_FOR_TASK",
        ),
    );
    assert.ok(restoredAssistant, "restored transcript must keep thinking");
    assert.ok(
      restoredAssistant.parts?.some(
        (part) => part.type === "toolCall" && part.name === "bg_list",
      ),
      "restored transcript must keep tool calls",
    );
    const restoredTool = restored.find((item) => item.role === "tool");
    assert.equal(restoredTool?.toolCallId, "presentation-call");
  } finally {
    await session.close();
    harness.cleanup();
  }
});

test("Pi SDK presentation resets per-run state and reports queued steering", async () => {
  const hold = deferred<FakeResponse>();
  const harness = await createHarness({
    loadBackgroundTerminals: true,
    responder: ({ model, count }) => {
      if (count === 1) {
        return assistantMessage(
          model,
          [
            { type: "thinking", thinking: "RESET_THINK" },
            toolCall("reset-call", "bg_list", {}),
          ],
          "toolUse",
        );
      }
      if (count === 2) return hold.promise;
      return textReply(model, `RUN_${count}`);
    },
  });

  const worker = workerRecord(harness, "presentation-reset");
  const snapshots: WorkerPresentation[] = [];
  const settled: Array<{
    result: string;
    error?: string;
    interrupted?: boolean;
  }> = [];
  let session!: WorkerSession;
  session = await harness.factory.create(worker, {
    onStarted: () => {},
    onReport: () => {},
    onPresentation: () => {
      const presentation = session.presentation?.();
      if (presentation) snapshots.push(presentation);
    },
    onSettled: (outcome) => settled.push(outcome),
  });

  let holdResolved = false;
  try {
    session.start("First run.");
    await within(
      harness.provider.waitForRequests(2),
      "the tool continuation request was missing",
    );
    await session.steer("QUEUED_CORRECTION_42");
    await waitUntil(
      () =>
        snapshots.some((snapshot) =>
          snapshot.queuedMessages?.some(
            (message) =>
              message.kind === "steer" &&
              message.text === "QUEUED_CORRECTION_42",
          ),
        ),
      "queued steering never appeared in the presentation",
    );

    hold.resolve(
      textReply(harness.registry.getAvailable()[0]!, "FIRST_RUN_DONE"),
    );
    holdResolved = true;
    await waitUntil(() => settled.length === 1, "first run never settled");
    const afterFirst = session.presentation?.();
    assert.ok(afterFirst);
    assert.ok(
      afterFirst.activeTools?.some(
        (tool) => tool.name === "bg_list" && tool.status === "completed",
      ),
      "completed tools remain visible until the next run",
    );
    assert.equal(afterFirst.streamingThinking, undefined);

    session.start("Second run.");
    const afterStart = session.presentation?.();
    assert.ok(afterStart);
    assert.equal(afterStart.activeTools, undefined);
    assert.equal(afterStart.streamingText, undefined);
    assert.equal(afterStart.streamingThinking, undefined);
    assert.equal(afterStart.queuedMessages, undefined);
    assert.equal(afterStart.activity, "starting");

    await waitUntil(() => settled.length === 2, "second run never settled");
    assert.equal(settled[1]?.result, "RUN_4");
  } finally {
    if (!holdResolved) {
      const model = harness.registry.getAvailable()[0];
      if (model) hold.resolve(textReply(model, "test cleanup"));
    }
    await session.close();
    harness.cleanup();
  }
});

test("Pi SDK presentation tolerates undefined tool progress without corrupting the run", async () => {
  const undefinedProgressTool: InlineExtension = {
    name: "undefined-progress-tool",
    factory: (pi) => {
      pi.registerTool({
        name: "undefined_progress",
        label: "Undefined Progress",
        description:
          "Emits an undefined progress payload and returns normally.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, _signal, onUpdate) {
          // Untyped JS tools can emit a missing progress payload. The runtime
          // callback forwards whatever it receives, so widen it for this probe.
          const emitProgress = onUpdate as
            ((result: unknown) => void) | undefined;
          emitProgress?.(undefined);
          return {
            content: [{ type: "text", text: "progress payload omitted" }],
            details: {},
          };
        },
      });
    },
  };
  const harness = await createHarness({
    extraExtensionFactories: [undefinedProgressTool],
    responder: ({ model, count }) => {
      if (count === 1)
        return assistantMessage(
          model,
          [toolCall("undefined-progress-call", "undefined_progress", {})],
          "toolUse",
        );
      return textReply(model, "LIFECYCLE_SURVIVED_UNDEFINED_PROGRESS");
    },
  });

  const worker = workerRecord(harness, "undefined-progress");
  const settled: Array<{
    result: string;
    error?: string;
    interrupted?: boolean;
  }> = [];
  let session!: WorkerSession;
  session = await harness.factory.create(worker, {
    onStarted: () => {},
    onReport: () => {},
    onSettled: (outcome) => settled.push(outcome),
  });

  try {
    session.start("Emit an undefined progress payload.");
    await waitUntil(() => settled.length === 1, "worker never settled");
    assert.equal(settled[0]?.result, "LIFECYCLE_SURVIVED_UNDEFINED_PROGRESS");
    assert.equal(settled[0]?.error, undefined);
    assert.equal(settled[0]?.interrupted, false);

    const presentation = session.presentation?.();
    assert.ok(presentation);
    const toolItem = presentation.transcript.find(
      (item) => item.role === "tool",
    );
    assert.ok(toolItem, "the tool result must remain in the transcript");
    assert.equal(toolItem.toolName, "undefined_progress");
    assert.equal(toolItem.isError, false);
    assert.equal(toolItem.status, "completed");

    const liveTool = presentation.activeTools?.find(
      (tool) => tool.id === "undefined-progress-call",
    );
    assert.equal(liveTool?.status, "completed");
    assert.equal(liveTool?.result, "progress payload omitted");
  } finally {
    await session.close();
    harness.cleanup();
  }
});
