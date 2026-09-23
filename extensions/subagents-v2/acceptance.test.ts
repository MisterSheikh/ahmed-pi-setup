import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { SubagentManager, type TaskResult } from "./src/manager.ts";
import type {
  ReportKind,
  SessionTranscriptItem,
  SubagentsConfig,
  WorkerRecord,
  WorkerSession,
  WorkerSessionCallbacks,
  WorkerSessionFactory,
} from "./src/types.ts";

const config: SubagentsConfig = {
  version: 2,
  enabled: true,
  allowedModels: ["test/model"],
  modelReasoning: { "test/model": { allowed: ["low"], default: "low" } },
  defaultModel: "test/model",
  maxActive: 4,
};

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeSession implements WorkerSession {
  readonly sessionFile: string;
  readonly workerId: string;
  readonly briefs: string[] = [];
  readonly steers: string[] = [];
  closeCalls = 0;
  interruptCalls = 0;
  closeError?: Error;
  private readonly callbacks: WorkerSessionCallbacks;

  constructor(workerId: string, callbacks: WorkerSessionCallbacks) {
    this.workerId = workerId;
    this.callbacks = callbacks;
    this.sessionFile = `/fake-sessions/${workerId}.jsonl`;
  }

  start(brief: string) {
    this.briefs.push(brief);
    this.callbacks.onStarted();
  }

  async steer(message: string) {
    this.steers.push(message);
  }

  async interrupt() {
    this.interruptCalls++;
    this.callbacks.onSettled({ result: "", interrupted: true });
  }

  async close() {
    this.closeCalls++;
    if (this.closeError) throw this.closeError;
  }

  transcript(): SessionTranscriptItem[] {
    return this.briefs.map((text) => ({ role: "user", text }));
  }

  report(kind: ReportKind, message: string) {
    this.callbacks.onReport(kind, message);
  }

  settle(result: string, error?: string) {
    this.callbacks.onSettled({ result, error });
  }

  fail(error: string, partial = "") {
    this.callbacks.onSettled({ result: partial, error });
  }
}

class FakeFactory implements WorkerSessionFactory {
  readonly sessions = new Map<string, FakeSession>();
  createCount = 0;
  holdCreates = false;
  failNext = false;
  private readonly gates: Array<() => void> = [];

  async create(worker: WorkerRecord, callbacks: WorkerSessionCallbacks) {
    this.createCount++;
    if (this.holdCreates) {
      await new Promise<void>((resolve) => this.gates.push(resolve));
    }
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated worker startup failure");
    }
    const session = new FakeSession(worker.id, callbacks);
    this.sessions.set(worker.id, session);
    return session;
  }

  releaseOne() {
    this.gates.shift()?.();
  }

  readTranscript(worker: WorkerRecord): SessionTranscriptItem[] {
    if (!worker.sessionFile) return [];
    // A real Pi session open fails for a corrupt file; keep the fake honest by
    // parsing, which throws for the corrupt fixture below.
    JSON.parse(fs.readFileSync(worker.sessionFile, "utf8"));
    return [];
  }
}

function harness(
  factory = new FakeFactory(),
  overrides: Partial<SubagentsConfig> = {},
) {
  const settled: TaskResult[] = [];
  const fyi: TaskResult[] = [];
  const manager = new SubagentManager({
    factory,
    getConfig: () => ({ ...config, ...overrides }),
    persist: () => {},
    onSettled: (result) => settled.push(result),
    onFyi: (result) => fyi.push(result),
  });
  return { factory, manager, settled, fyi };
}

function spawn(manager: SubagentManager, name: string) {
  return manager.spawn({
    name,
    brief: `${name} task 1`,
    cwd: process.cwd(),
    model: "test/model",
    reasoning: "low",
  });
}

async function sessionFor(factory: FakeFactory, workerId: string) {
  await turn();
  const session = factory.sessions.get(workerId);
  assert.ok(session, `no fake session for ${workerId}`);
  return session;
}

function restoredWorker(id: string, sessionFile: string): WorkerRecord {
  const now = Date.now();
  return {
    id,
    name: id,
    cwd: process.cwd(),
    model: "test/model",
    reasoning: "low",
    createdAt: now,
    updatedAt: now,
    sessionFile,
    takenOver: false,
    currentTaskId: `${id}-t1`,
    tasks: [
      {
        id: `${id}-t1`,
        brief: "previous task",
        status: "completed",
        startedAt: now,
        settledAt: now,
        result: "previous result",
      },
    ],
  };
}

test("a reused worker follows the new task without changing the old result", async () => {
  const { factory, manager, settled } = harness();
  const worker = spawn(manager, "reuse");
  const session = await sessionFor(factory, worker.id);

  session.settle("first result");
  const followup = manager.followup(worker.id, "reuse task 2");
  await turn();
  session.settle("second result");

  assert.equal(factory.createCount, 1, "reuse must not create a new session");
  assert.deepEqual(
    session.briefs,
    [`${worker.name} task 1`, "reuse task 2"],
    "both tasks must run in the reused conversation",
  );
  const after = manager.require(worker.id);
  assert.deepEqual(
    after.tasks.map(({ id, status, result }) => ({ id, status, result })),
    [
      { id: `${worker.id}-t1`, status: "completed", result: "first result" },
      { id: followup.task.id, status: "completed", result: "second result" },
    ],
  );
  assert.deepEqual(
    settled.map(({ task }) => task.id),
    [`${worker.id}-t1`, followup.task.id],
  );
  assert.equal(manager.activeCount(), 0);
  await manager.dispose();
});

test("capacity is reserved for concurrent startups and released when startup fails", async () => {
  const factory = new FakeFactory();
  factory.holdCreates = true;
  const { manager } = harness(factory, { maxActive: 2 });
  const first = spawn(manager, "first");
  const second = spawn(manager, "second");

  assert.equal(manager.activeCount(), 2);
  assert.throws(() => spawn(manager, "third"), /limit reached/i);

  factory.failNext = true;
  factory.releaseOne();
  await turn();
  assert.equal(manager.require(first.id).tasks[0]?.status, "failed");
  assert.match(
    manager.require(first.id).tasks[0]?.error ?? "",
    /startup failure/i,
  );
  assert.equal(manager.activeCount(), 1);

  factory.holdCreates = false;
  factory.releaseOne();
  await turn();
  assert.equal(manager.require(second.id).tasks[0]?.status, "working");

  const third = spawn(manager, "third");
  await turn();
  assert.equal(manager.require(third.id).tasks[0]?.status, "working");
  assert.equal(manager.activeCount(), 2);
  await manager.dispose();
});

test("interrupting a worker during startup closes the late session and releases capacity", async () => {
  const factory = new FakeFactory();
  factory.holdCreates = true;
  const { manager } = harness(factory, { maxActive: 1 });
  const worker = spawn(manager, "startup");
  await turn();

  const interrupted = manager.interrupt(worker.id);
  assert.equal(manager.require(worker.id).tasks[0]?.status, "stopping");
  factory.holdCreates = false;
  factory.releaseOne();

  const result = await interrupted;
  const session = factory.sessions.get(worker.id);
  assert.equal(result.task.status, "interrupted");
  assert.equal(session?.closeCalls, 1);
  assert.equal(manager.activeCount(), 0);

  const replacement = spawn(manager, "replacement");
  await sessionFor(factory, replacement.id);
  assert.equal(manager.activeCount(), 1);
  await manager.dispose();
});

test("wait any returns the first selected task that stops", async () => {
  const { factory, manager } = harness();
  const first = spawn(manager, "first");
  const second = spawn(manager, "second");
  const firstSession = await sessionFor(factory, first.id);
  const secondSession = await sessionFor(factory, second.id);

  const waiting = manager.wait([first.id, second.id], "any");
  secondSession.settle("second done");

  const results = await waiting;
  assert.deepEqual(
    results.map(({ worker }) => worker.id),
    [second.id],
  );
  assert.equal(results[0]?.task.result, "second done");
  assert.equal(manager.require(first.id).tasks[0]?.status, "working");
  firstSession.settle("first done");
  await manager.dispose();
});

test("wait all takes a task snapshot and waits for every selected task", async () => {
  const { factory, manager } = harness();
  const first = spawn(manager, "first");
  const second = spawn(manager, "second");
  const firstSession = await sessionFor(factory, first.id);
  const secondSession = await sessionFor(factory, second.id);

  let resolved = false;
  const waiting = manager.wait([first.id, second.id], "all").then((results) => {
    resolved = true;
    return results;
  });
  firstSession.settle("first done");
  await turn();
  assert.equal(resolved, false);

  secondSession.settle("second done");
  const results = await waiting;
  assert.deepEqual(
    results.map(({ worker, task }) => [worker.id, task.result]),
    [
      [first.id, "first done"],
      [second.id, "second done"],
    ],
  );

  const priorTaskId = results[0]?.task.id;
  manager.followup(first.id, "first task 2");
  assert.equal(results[0]?.task.id, priorTaskId);
  assert.equal(results[0]?.task.status, "completed");
  await manager.dispose();
});

test("wait all returns early for an urgent question while other selected work keeps running", async () => {
  const { factory, manager } = harness();
  const questioner = spawn(manager, "questioner");
  const worker = spawn(manager, "worker");
  const questionSession = await sessionFor(factory, questioner.id);
  await sessionFor(factory, worker.id);

  const waiting = manager.wait([questioner.id, worker.id], "all");
  questionSession.report("question", "Need an input");
  questionSession.settle("");

  const results = await waiting;
  assert.equal(results.length, 1);
  assert.equal(results[0]?.worker.id, questioner.id);
  assert.equal(results[0]?.task.status, "question");
  assert.equal(results[0]?.task.report?.message, "Need an input");
  assert.equal(manager.require(worker.id).tasks[0]?.status, "working");
  assert.equal(manager.activeCount(), 1);
  await manager.dispose();
});

test("wait all returns early for a failure while other selected work keeps running", async () => {
  const { factory, manager } = harness();
  const failing = spawn(manager, "failing");
  const other = spawn(manager, "other");
  const failingSession = await sessionFor(factory, failing.id);
  await sessionFor(factory, other.id);

  const waiting = manager.wait([failing.id, other.id], "all");
  failingSession.fail("worker crashed", "partial output");

  const results = await waiting;
  assert.equal(results.length, 1);
  assert.equal(results[0]?.worker.id, failing.id);
  assert.equal(results[0]?.task.status, "failed");
  assert.equal(results[0]?.task.error, "worker crashed");
  assert.equal(results[0]?.task.result, "partial output");
  assert.equal(manager.require(other.id).tasks[0]?.status, "working");
  assert.equal(manager.activeCount(), 1);
  await manager.dispose();
});

test("cancelling a wait leaves selected work running and normally deliverable", async () => {
  const { factory, manager, settled } = harness();
  const worker = spawn(manager, "cancel-wait");
  const session = await sessionFor(factory, worker.id);
  const controller = new AbortController();
  const waiting = manager.wait([worker.id], "all", controller.signal);

  controller.abort(new Error("caller stopped waiting"));
  await assert.rejects(waiting, /caller stopped waiting/);
  assert.equal(manager.require(worker.id).tasks[0]?.status, "working");
  assert.equal(manager.activeCount(), 1);
  assert.equal(session.interruptCalls, 0);

  session.settle("finished later");
  const result = await manager.wait([worker.id], "all");
  assert.equal(result[0]?.task.result, "finished later");
  assert.deepEqual(
    settled.map(({ task }) => task.result),
    ["finished later"],
  );
  await manager.dispose();
});

test("takeover gives the human exclusive control until handback", async () => {
  const { factory, manager } = harness();
  const worker = spawn(manager, "takeover");
  const session = await sessionFor(factory, worker.id);
  manager.beginTakeover(worker.id);

  await assert.rejects(
    manager.steer(worker.id, "parent correction"),
    /exclusive human takeover/,
  );
  await assert.rejects(
    manager.interrupt(worker.id),
    /exclusive human takeover/,
  );
  assert.throws(
    () => manager.followup(worker.id, "parent assignment"),
    /exclusive human takeover/,
  );
  assert.equal(session.steers.length, 0);
  assert.equal(session.interruptCalls, 0);

  await manager.humanSend(worker.id, "human correction");
  assert.deepEqual(session.steers, ["human correction"]);

  session.settle("human-controlled result");
  assert.equal(manager.require(worker.id).tasks[0]?.status, "completed");

  manager.endTakeover(worker.id);
  const followup = manager.followup(worker.id, "post-handback task");
  await turn();
  assert.equal(
    manager.require(worker.id).tasks[0]?.result,
    "human-controlled result",
  );
  assert.equal(manager.require(worker.id).tasks[1]?.id, followup.task.id);
  await manager.steer(worker.id, "parent correction after handback");
  assert.deepEqual(session.steers, [
    "human correction",
    "parent correction after handback",
  ]);
  await manager.dispose();
});

test("cleanup reports every close failure and still releases all capacity", async () => {
  const { factory, manager } = harness();
  const first = spawn(manager, "first");
  const second = spawn(manager, "second");
  const firstSession = await sessionFor(factory, first.id);
  const secondSession = await sessionFor(factory, second.id);
  firstSession.closeError = new Error("simulated close failure");

  const failures = await manager.dispose();

  assert.equal(failures.length, 1);
  assert.match(
    failures[0] ?? "",
    new RegExp(`${first.id}.*simulated close failure`),
  );
  assert.equal(firstSession.closeCalls, 1);
  assert.equal(secondSession.closeCalls, 1);
  assert.equal(manager.activeCount(), 0);
  assert.equal(manager.require(first.id).tasks[0]?.status, "interrupted");
  assert.equal(manager.require(second.id).tasks[0]?.status, "interrupted");
});

test("restored sessions that are corrupt or missing are unavailable without hiding each other", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "subagents-v2-acceptance-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const missing = path.join(directory, "missing.jsonl");
  const corrupt = path.join(directory, "corrupt.jsonl");
  const valid = path.join(directory, "valid.jsonl");
  fs.writeFileSync(corrupt, "this is not a Pi session\n", { mode: 0o600 });
  fs.writeFileSync(valid, "[]\n", { mode: 0o600 });

  const factory = new FakeFactory();
  const manager = new SubagentManager({
    factory,
    // Corrupt first: a validation error must not stop later workers from
    // being classified, and a valid sibling must stay usable.
    restored: [
      restoredWorker("corrupt", corrupt),
      restoredWorker("missing", missing),
      restoredWorker("valid", valid),
    ],
    getConfig: () => config,
    persist: () => {},
    onSettled: () => {},
    onFyi: () => {},
  });

  assert.match(
    manager.require("corrupt").unavailableReason ?? "",
    /unreadable|corrupt|invalid/i,
  );
  assert.match(
    manager.require("missing").unavailableReason ?? "",
    /missing|unreadable/i,
  );
  assert.equal(manager.require("valid").unavailableReason, undefined);

  assert.throws(
    () => manager.followup("corrupt", "new work"),
    /unreadable|corrupt|invalid/i,
  );
  assert.throws(
    () => manager.followup("missing", "new work"),
    /missing|unreadable/i,
  );

  const validFollowup = manager.followup("valid", "new work");
  await sessionFor(factory, "valid");
  assert.equal(manager.require("valid").tasks[1]?.id, validFollowup.task.id);
  assert.equal(manager.require("valid").tasks[1]?.status, "working");
  assert.equal(manager.activeCount(), 1);
  await manager.dispose();
});
