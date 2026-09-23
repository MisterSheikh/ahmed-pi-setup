/**
 * Subagents V2 — opt-in live validation harness.
 *
 * Intentionally NOT named `*.test.ts`, so `npm test` never runs it. It spends
 * real model tokens; run it only when you mean to.
 *
 * Isolation (no writes to normal Pi state, no live extension activation)
 * - Creates a fresh temp agent dir (mode 0700) and copies the normal auth.json
 *   and models-store.json into it. models.json is also copied; no normal state is linked.
 * - Points PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR at the temp dir and
 *   sets PI_OFFLINE=1, so model auth and catalog reads come from the copies and
 *   every parent/worker session lands under the temp dir.
 * - Links only `background-terminals` into `<tmp>/extensions`, so workers can
 *   run the required-background-process scenario. Neither the V1 `subagents`
 *   extension nor the V2 extension is discovered as a Pi extension.
 * - Drives `SubagentManager` + `PiWorkerSessionFactory` directly. Neither
 *   subagents extension is activated in this process.
 *
 * Cost bounding
 * - Defaults to the cheap configured model opencode-go/deepseek-v4.1-flash at
 *   high, disables retry/compaction via the temp settings.json, and keeps the
 *   active-worker limit at 2 for the scenarios that need concurrency.
 *
 * Commands
 *   # safe plumbing check, no model calls:
 *   SUBAGENTS_V2_LIVE_DRY_RUN=1 node --test --experimental-transform-types extensions/subagents-v2/live-validation.ts
 *
 *   # full live validation:
 *   SUBAGENTS_V2_LIVE=1 node --test --experimental-transform-types extensions/subagents-v2/live-validation.ts
 *
 * This harness is typechecked by the workspace check but excluded from normal tests.
 *
 * Env overrides
 *   SUBAGENTS_V2_LIVE_MODEL       default opencode-go/deepseek-v4.1-flash
 *   SUBAGENTS_V2_LIVE_REASONING   default high
 *   SUBAGENTS_V2_LIVE_KEEP_TEMP   keep the temp dir for inspection
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionManager as SessionManagerType } from "@earendil-works/pi-coding-agent";
import type { SubagentManager, TaskResult } from "./src/manager.ts";
import {
  isActiveStatus,
  THINKING_LEVELS,
  type SubagentsConfig,
  type ThinkingLevel,
  type WorkerRecord,
} from "./src/types.ts";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const LIVE = process.env.SUBAGENTS_V2_LIVE === "1";
const DRY = process.env.SUBAGENTS_V2_LIVE_DRY_RUN === "1";
const ENABLED = LIVE || DRY;
const KEEP_TEMP = process.env.SUBAGENTS_V2_LIVE_KEEP_TEMP === "1";
const MODEL =
  process.env.SUBAGENTS_V2_LIVE_MODEL ?? "opencode-go/deepseek-v4.1-flash";
const REASONING = (process.env.SUBAGENTS_V2_LIVE_REASONING ??
  "high") as ThinkingLevel;

// Captured before setupIsolation() rewrites the env.
const NORMAL_AGENT_DIR =
  process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");

const openManagers = new Set<SubagentManager>();
let tempRoot = "";
let tempSessions = "";
let normalSnapshot: Array<{ file: string; mtimeMs: number; size: number }> = [];

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function snapshot(files: readonly string[]) {
  return files.flatMap((file) => {
    try {
      const stat = fs.statSync(file);
      return [{ file, mtimeMs: stat.mtimeMs, size: stat.size }];
    } catch {
      return [];
    }
  });
}

function setupIsolation() {
  if (!THINKING_LEVELS.includes(REASONING)) {
    throw new Error(
      `Invalid reasoning level "${REASONING}". Use one of: ${THINKING_LEVELS.join(", ")}.`,
    );
  }
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-v2-live-"));
  fs.chmodSync(tempRoot, 0o700);
  tempSessions = path.join(tempRoot, "sessions");
  fs.mkdirSync(tempSessions, { recursive: true, mode: 0o700 });

  const normalAuth = path.join(NORMAL_AGENT_DIR, "auth.json");
  const normalStore = path.join(NORMAL_AGENT_DIR, "models-store.json");
  const normalModels = path.join(NORMAL_AGENT_DIR, "models.json");
  const normalSettings = path.join(NORMAL_AGENT_DIR, "settings.json");
  if (!fs.existsSync(normalAuth))
    throw new Error(`Normal auth.json not found at ${normalAuth}.`);
  fs.copyFileSync(normalAuth, path.join(tempRoot, "auth.json"));
  fs.chmodSync(path.join(tempRoot, "auth.json"), 0o600);
  if (fs.existsSync(normalStore)) {
    fs.copyFileSync(normalStore, path.join(tempRoot, "models-store.json"));
    fs.chmodSync(path.join(tempRoot, "models-store.json"), 0o600);
  }
  if (fs.existsSync(normalModels)) {
    fs.copyFileSync(normalModels, path.join(tempRoot, "models.json"));
    fs.chmodSync(path.join(tempRoot, "models.json"), 0o600);
  }
  fs.writeFileSync(
    path.join(tempRoot, "settings.json"),
    `${JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const extensionDir = path.join(tempRoot, "extensions");
  fs.mkdirSync(extensionDir, { recursive: true, mode: 0o700 });
  fs.symlinkSync(
    path.join(REPO_ROOT, "extensions", "background-terminals"),
    path.join(extensionDir, "background-terminals"),
  );
  const agentsFile = path.join(REPO_ROOT, "config", "AGENTS.md");
  if (fs.existsSync(agentsFile))
    fs.symlinkSync(agentsFile, path.join(tempRoot, "AGENTS.md"));

  process.env.PI_CODING_AGENT_DIR = tempRoot;
  process.env.PI_CODING_AGENT_SESSION_DIR = tempSessions;
  process.env.PI_OFFLINE = "1";
  normalSnapshot = snapshot([
    normalAuth,
    normalStore,
    normalModels,
    normalSettings,
  ]);
}

interface Harness {
  manager: SubagentManager;
  registry: import("@earendil-works/pi-coding-agent").ModelRegistry;
  runtime: import("@earendil-works/pi-coding-agent").ModelRuntime;
  sessionManager: SessionManagerType;
  settled: TaskResult[];
  fyi: TaskResult[];
  config: SubagentsConfig;
  dispose(): Promise<void>;
}

async function createHarness(
  options: {
    maxActive?: number;
    restored?: WorkerRecord[];
    sessionManager?: SessionManagerType;
  } = {},
): Promise<Harness> {
  const { ModelRuntime, ModelRegistry, SessionManager } =
    await import("@earendil-works/pi-coding-agent");
  const { SubagentManager } = await import("./src/manager.ts");
  const { PiWorkerSessionFactory } = await import("./src/pi-session.ts");
  const { STATE_ENTRY_TYPE, makeState } = await import("./src/state.ts");

  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const sessionManager =
    options.sessionManager ??
    SessionManager.create(process.cwd(), tempSessions);
  if (!options.sessionManager) {
    // Pi intentionally doesn't flush an unused parent session before its first
    // assistant message. Represent the already-active delegating parent without
    // spending a separate live call; none of this history reaches workers.
    sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Isolated validation parent." }],
      api: "openai-completions",
      provider: "validation",
      model: "fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
  }
  const factory = new PiWorkerSessionFactory({
    registry,
    parentCwd: process.cwd(),
    projectTrusted: false,
    sessionRoot: path.join(tempRoot, "subagents-v2", "workers"),
    modelRuntime: runtime,
  });
  const config: SubagentsConfig = {
    version: 2,
    enabled: true,
    allowedModels: [MODEL],
    modelReasoning: { [MODEL]: { allowed: [REASONING], default: REASONING } },
    defaultModel: MODEL,
    maxActive: options.maxActive ?? 2,
  };
  const settled: TaskResult[] = [];
  const fyi: TaskResult[] = [];
  const manager = new SubagentManager({
    factory,
    restored: options.restored,
    getConfig: () => config,
    persist: (workers) => {
      sessionManager.appendCustomEntry(
        STATE_ENTRY_TYPE,
        makeState(sessionManager.getSessionId(), workers),
      );
    },
    onSettled: (result) => {
      settled.push(result);
    },
    onFyi: (result) => {
      fyi.push(result);
    },
  });
  openManagers.add(manager);
  return {
    manager,
    registry,
    runtime,
    sessionManager,
    settled,
    fyi,
    config,
    dispose: async () => {
      await manager.dispose();
      openManagers.delete(manager);
    },
  };
}

function spawn(manager: SubagentManager, name: string, brief: string) {
  return manager.spawn({
    name,
    brief,
    cwd: process.cwd(),
    model: MODEL,
    reasoning: REASONING,
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}.`);
}

function latestTask(manager: SubagentManager, id: string) {
  const worker = manager.get(id);
  assert.ok(worker, `Worker "${id}" is no longer tracked.`);
  const task = worker.tasks.at(-1);
  assert.ok(task, `Worker "${id}" has no task.`);
  return task;
}

if (ENABLED) setupIsolation();

after(async () => {
  if (!tempRoot) return;
  await Promise.all([...openManagers].map((manager) => manager.dispose()));
  openManagers.clear();
  try {
    assert.deepEqual(
      snapshot(normalSnapshot.map((entry) => entry.file)),
      normalSnapshot,
      "normal Pi state must not change during live tests",
    );
  } finally {
    if (!KEEP_TEMP) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test(
  "isolation + model availability (no inference)",
  {
    skip: !ENABLED && "set SUBAGENTS_V2_LIVE=1 or SUBAGENTS_V2_LIVE_DRY_RUN=1",
  },
  async () => {
    const { getAgentDir, ModelRuntime, ModelRegistry } =
      await import("@earendil-works/pi-coding-agent");
    assert.equal(
      getAgentDir(),
      tempRoot,
      "agent dir must resolve to the temp dir",
    );
    assert.ok(
      tempSessions.startsWith(tempRoot),
      "session dir must live under the temp dir",
    );
    const runtime = await ModelRuntime.create({ allowModelNetwork: false });
    const registry = new ModelRegistry(runtime);
    const model = registry.find(
      MODEL.split("/")[0],
      MODEL.split("/").slice(1).join("/"),
    );
    assert.ok(model, `Configured model ${MODEL} was not found.`);
    assert.ok(
      registry
        .getAvailable()
        .some((candidate) => `${candidate.provider}/${candidate.id}` === MODEL),
      `Configured model ${MODEL} has no usable authentication.`,
    );
    assert.deepEqual(
      snapshot(normalSnapshot.map((entry) => entry.file)),
      normalSnapshot,
      "normal auth/models/settings must not change",
    );
  },
);

const liveTest = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
  test(
    name,
    { skip: !LIVE && "set SUBAGENTS_V2_LIVE=1", timeout },
    async (ctx) => {
      const stop = () => {
        void Promise.all(
          [...openManagers].map((manager) => manager.dispose()),
        ).catch(() => {});
      };
      ctx.signal.addEventListener("abort", stop, { once: true });
      try {
        await fn();
      } finally {
        ctx.signal.removeEventListener("abort", stop);
      }
    },
  );

liveTest("delegate and reuse a worker", async () => {
  const h = await createHarness();
  try {
    const worker = spawn(h.manager, "reuse", "Reply with exactly: FIRST");
    const [first] = await h.manager.wait([worker.id], "all");
    assert.equal(first.task.status, "completed");
    assert.match(first.task.result ?? "", /FIRST/i);
    const sessionFile = h.manager.get(worker.id)?.sessionFile;
    assert.ok(sessionFile, "worker must have a saved Pi session");

    const followup = h.manager.followup(
      worker.id,
      "Reply with SECOND followed by the exact word you answered in the previous task.",
    );
    assert.equal(followup.worker.id, worker.id, "reuse keeps the same worker");
    assert.equal(followup.worker.tasks.length, 2);
    const [second] = await h.manager.wait([worker.id], "all");
    assert.equal(second.task.status, "completed");
    assert.match(second.task.result ?? "", /SECOND\s+FIRST/i);
    assert.equal(
      h.manager.get(worker.id)?.sessionFile,
      sessionFile,
      "reuse keeps the same session file",
    );
    assert.ok(
      h.manager.transcript(worker.id).some((item) => /FIRST/i.test(item.text)),
      "reused worker keeps its earlier conversation",
    );
  } finally {
    await h.dispose();
  }
});

liveTest("fyi report does not stop the task", async () => {
  const h = await createHarness();
  try {
    const worker = spawn(
      h.manager,
      "fyi",
      "Call subagent_report with kind fyi and message 'progress update'. Then reply with exactly: FYI_DONE",
    );
    const [result] = await h.manager.wait([worker.id], "all");
    assert.equal(result.task.status, "completed");
    assert.match(result.task.result ?? "", /FYI_DONE/);
    assert.ok(
      h.fyi.some((entry) => entry.task.id === result.task.id),
      "onFyi must fire for an fyi report",
    );
  } finally {
    await h.dispose();
  }
});

liveTest("question stops the worker and answer resumes it", async () => {
  const h = await createHarness();
  try {
    const worker = spawn(
      h.manager,
      "question",
      "You must call subagent_report with kind question and message 'What is the secret word?'. Do not guess. Then stop.",
    );
    const [question] = await h.manager.wait([worker.id], "all");
    assert.equal(question.task.status, "question");
    assert.equal(question.task.report?.kind, "question");
    assert.ok(
      (question.task.report?.message ?? "").length > 0,
      "the question text must be captured",
    );
    assert.equal(
      h.manager.activeCount(),
      0,
      "a question releases the active slot",
    );

    h.manager.followup(
      worker.id,
      "The secret word is BANANA. Reply with exactly: ACK BANANA",
    );
    const [answer] = await h.manager.wait([worker.id], "all");
    assert.equal(answer.task.status, "completed");
    assert.match(answer.task.result ?? "", /BANANA/i);
    assert.equal(answer.worker.tasks.length, 2);
  } finally {
    await h.dispose();
  }
});

liveTest("steer reaches an active run", async () => {
  const h = await createHarness();
  try {
    const worker = spawn(
      h.manager,
      "steer",
      "Count from 1 to 300, one number per line. Do not stop early.",
    );
    await waitFor(
      () => latestTask(h.manager, worker.id).status === "working",
      30_000,
      "worker to start working",
    );
    await h.manager.steer(
      worker.id,
      "Stop counting now and reply with exactly: STEERED_OK",
    );
    const [result] = await h.manager.wait([worker.id], "all");
    assert.equal(result.task.status, "completed");
    assert.match(result.task.result ?? "", /STEERED_OK/);
  } finally {
    await h.dispose();
  }
});

liveTest("interrupt stops the worker and preserves it for reuse", async () => {
  const h = await createHarness();
  try {
    const worker = spawn(
      h.manager,
      "interrupt",
      "Write a very long, detailed essay of at least 4000 words about the history of computing. Do not stop early.",
    );
    await waitFor(
      () => latestTask(h.manager, worker.id).status === "working",
      30_000,
      "worker to start working",
    );
    const interrupted = await h.manager.interrupt(worker.id);
    assert.equal(interrupted.task.status, "interrupted");
    assert.equal(
      h.manager.activeCount(),
      0,
      "interrupt releases the active slot",
    );
    assert.ok(
      h.manager.get(worker.id)?.sessionFile,
      "interrupt preserves the worker session",
    );

    h.manager.followup(worker.id, "Reply with exactly: AFTER_INTERRUPT");
    const [reused] = await h.manager.wait([worker.id], "all");
    assert.equal(reused.task.status, "completed");
    assert.match(reused.task.result ?? "", /AFTER_INTERRUPT/);
  } finally {
    await h.dispose();
  }
});

liveTest(
  "wait any and all return the expected tasks without duplicate settlement",
  async () => {
    const h = await createHarness({ maxActive: 2 });
    try {
      const fast = spawn(h.manager, "fast", "Reply with exactly: A");
      const slow = spawn(
        h.manager,
        "slow",
        "Use the bash tool to run `sleep 8`, then reply with exactly: B",
      );
      const ids = [fast.id, slow.id];

      const any = await h.manager.wait(ids, "any");
      assert.ok(any.length >= 1, "any must return at least one stopped task");
      const all = await h.manager.wait(ids, "all");
      assert.equal(all.length, 2, "all must return both tasks");
      assert.ok(all.every((entry) => entry.task.status === "completed"));
      assert.equal(
        h.settled.filter((entry) => ids.includes(entry.worker.id)).length,
        2,
        "each task settles exactly once",
      );

      const again = await h.manager.wait(ids, "all");
      assert.equal(
        again.length,
        2,
        "waiting on already-stopped tasks returns immediately",
      );
    } finally {
      await h.dispose();
    }
  },
);

liveTest(
  "worker waits for a required background terminal before completing",
  async () => {
    const h = await createHarness({ maxActive: 2 });
    try {
      const marker = `BG_MARKER_${Date.now().toString(36)}`;
      const worker = spawn(
        h.manager,
        "background",
        [
          `Use bg_start with command \`sleep 6; echo ${marker}\` and title \`live-bg\`.`,
          "Then stop your turn and wait for the background terminal to finish.",
          `After it has finished, use bg_status to read its output, then reply with exactly: ${marker}.`,
          "Do not reply with the marker before the process has exited.",
        ].join(" "),
      );

      await waitFor(
        () =>
          h.manager
            .transcript(worker.id)
            .some((item) => item.role === "tool" && /bg_start/.test(item.text)),
        45_000,
        "the worker to start the background terminal",
      );
      await delay(2_500);
      assert.ok(
        isActiveStatus(latestTask(h.manager, worker.id).status),
        "the worker must keep its active slot while the required background process runs",
      );

      const [result] = await h.manager.wait([worker.id], "all");
      assert.equal(result.task.status, "completed");
      assert.match(
        result.task.result ?? "",
        new RegExp(marker),
        "the final result must include the background output",
      );
      assert.equal(
        h.settled.length,
        1,
        "the task settles once, after the background process finishes",
      );
      assert.ok(
        h.manager
          .transcript(worker.id)
          .some(
            (item) =>
              item.role === "tool" &&
              /bg_status/.test(item.text) &&
              item.text.includes(marker),
          ),
        "the worker inspects the finished process output before completing",
      );
    } finally {
      await h.dispose();
    }
  },
);

liveTest("resume restores saved workers without starting tasks", async () => {
  const first = await createHarness();
  let sessionFile: string | undefined;
  let workerId = "";
  try {
    const worker = spawn(
      first.manager,
      "resume",
      "Reply with exactly: PERSISTED",
    );
    workerId = worker.id;
    await first.manager.wait([worker.id], "all");
    sessionFile = first.sessionManager.getSessionFile();
    assert.ok(
      sessionFile && fs.existsSync(sessionFile),
      "the parent session file must exist",
    );
  } finally {
    await first.dispose();
  }

  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { restoreState } = await import("./src/state.ts");
  const reopened = SessionManager.open(
    sessionFile,
    tempSessions,
    process.cwd(),
  );
  const restored = restoreState(reopened);
  assert.equal(restored.ownerMismatch, undefined);
  assert.equal(restored.workers.length, 1, "the saved worker must be restored");
  assert.equal(restored.workers[0].id, workerId);
  assert.equal(restored.workers[0].tasks[0].status, "completed");

  const second = await createHarness({
    restored: restored.workers,
    sessionManager: reopened,
  });
  try {
    assert.equal(
      second.manager.activeCount(),
      0,
      "restore must not start model work",
    );
    assert.equal(second.settled.length, 0, "restore must not settle anything");
    assert.ok(
      second.manager.get(workerId)?.sessionFile,
      "the saved session reference survives restore",
    );

    second.manager.followup(
      workerId,
      "Reply with RESUMED followed by the exact word you answered before this session was resumed.",
    );
    const [result] = await second.manager.wait([workerId], "all");
    assert.equal(result.task.status, "completed");
    assert.match(result.task.result ?? "", /RESUMED\s+PERSISTED/);
  } finally {
    await second.dispose();
  }
});

if (!ENABLED) {
  test("subagents-v2 live validation is opt-in", () => {
    console.log(
      "Skipped. Run with SUBAGENTS_V2_LIVE_DRY_RUN=1 (no model calls) or SUBAGENTS_V2_LIVE=1 (live).",
    );
  });
}
