import assert from "node:assert/strict";
import test from "node:test";
import type {
  SessionTranscriptItem,
  SubagentsConfig,
  WorkerPresentation,
  WorkerRecord,
  WorkerSession,
  WorkerSessionCallbacks,
  WorkerSessionFactory,
} from "./src/types.ts";
import { SubagentManager, type TaskResult } from "./src/manager.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeProviderSession implements WorkerSession {
  readonly sessionFile: string;
  active = false;
  closed = false;
  closeError?: Error;
  starts: string[] = [];
  steers: string[] = [];
  /** When set, an active `steer()` rejects with this error unchanged. */
  steerError?: Error;
  /** When true, `steer()` settles the run and then rejects (settle race). */
  settleOnSteer = false;
  items: SessionTranscriptItem[] = [];
  /** Live snapshot surfaced by `presentation()`; undefined exercises the
   * transcript fallback used by legacy factories. */
  livePresentation?: WorkerPresentation;
  /** When set, `presentation()` throws so callers exercise the diagnostic path. */
  presentationError?: Error;
  /** When set, `transcript()` throws so the fallback path is exercised too. */
  transcriptError?: Error;

  constructor(
    readonly workerId: string,
    private readonly callbacks: WorkerSessionCallbacks,
  ) {
    this.sessionFile = `/tmp/subagents-v2-fake/${workerId}.jsonl`;
  }

  start(brief: string) {
    if (this.closed) throw new Error("closed");
    this.active = true;
    this.starts.push(brief);
    this.items.push({ role: "user", text: brief });
    this.callbacks.onStarted();
  }

  async steer(message: string) {
    if (!this.active) throw new Error("idle");
    if (this.steerError) throw this.steerError;
    if (this.settleOnSteer) {
      this.active = false;
      this.callbacks.onSettled({ result: "settled during steer" });
      throw new Error("idle");
    }
    this.steers.push(message);
  }

  async interrupt() {
    if (!this.active) return;
    this.active = false;
    this.callbacks.onSettled({ result: "", interrupted: true });
  }

  async close() {
    this.closed = true;
    if (this.active) {
      this.active = false;
      this.callbacks.onSettled({ result: "", interrupted: true });
    }
    if (this.closeError) throw this.closeError;
  }

  transcript() {
    if (this.transcriptError) throw this.transcriptError;
    return [...this.items];
  }

  presentation() {
    if (this.presentationError) throw this.presentationError;
    return this.livePresentation;
  }

  /** Simulate a live UI update from the worker session. */
  present() {
    this.callbacks.onPresentation?.();
  }

  report(kind: "fyi" | "question" | "blocked", message: string) {
    this.callbacks.onReport(kind, message);
  }

  complete(result: string) {
    this.active = false;
    this.items.push({ role: "assistant", text: result });
    this.callbacks.onSettled({ result });
  }

  fail(error: string, partial = "") {
    this.active = false;
    this.callbacks.onSettled({ result: partial, error });
  }

  cleanupError(message: string) {
    this.callbacks.onCleanupError?.(message);
  }
}

class FakeProvider implements WorkerSessionFactory {
  sessions = new Map<string, FakeProviderSession>();
  createCount = 0;
  failNext = false;
  closeErrorNext?: Error;
  private gates: Array<() => void> = [];
  holdCreates = false;

  async create(worker: WorkerRecord, callbacks: WorkerSessionCallbacks) {
    this.createCount++;
    if (this.holdCreates)
      await new Promise<void>((resolve) => this.gates.push(resolve));
    if (this.failNext) {
      this.failNext = false;
      throw new Error("fake provider startup failed");
    }
    const session = new FakeProviderSession(worker.id, callbacks);
    session.closeError = this.closeErrorNext;
    this.closeErrorNext = undefined;
    this.sessions.set(worker.id, session);
    return session;
  }

  releaseOne() {
    this.gates.shift()?.();
  }

  readTranscript(worker: WorkerRecord) {
    return this.sessions.get(worker.id)?.transcript() ?? [];
  }
}

function config(maxActive = 4): SubagentsConfig {
  return {
    version: 2,
    enabled: true,
    allowedModels: ["fake/model"],
    modelReasoning: { "fake/model": { allowed: ["low"], default: "low" } },
    defaultModel: "fake/model",
    maxActive,
  };
}

function harness(maxActive = 4, restored: WorkerRecord[] = []) {
  const provider = new FakeProvider();
  const settled: TaskResult[] = [];
  const fyi: TaskResult[] = [];
  const persisted: WorkerRecord[][] = [];
  const cleanupErrors: string[] = [];
  const cfg = config(maxActive);
  const manager = new SubagentManager({
    factory: provider,
    restored,
    getConfig: () => cfg,
    persist: (workers) =>
      persisted.push(
        workers.map((worker) => ({
          ...worker,
          tasks: worker.tasks.map((task) => ({ ...task })),
        })),
      ),
    onSettled: (result) => settled.push(result),
    onFyi: (result) => fyi.push(result),
    onCleanupError: (message) => cleanupErrors.push(message),
  });
  const spawn = (name = "worker") =>
    manager.spawn({
      name,
      brief: `task for ${name}`,
      cwd: process.cwd(),
      model: "fake/model",
      reasoning: "low",
    });
  return {
    manager,
    provider,
    settled,
    fyi,
    persisted,
    cleanupErrors,
    cfg,
    spawn,
  };
}

test("capacity is reserved before concurrent provider startup and released after failure", async () => {
  const { manager, provider, spawn } = harness(2);
  provider.holdCreates = true;
  const first = spawn("one");
  const second = spawn("two");
  assert.equal(manager.activeCount(), 2);
  assert.throws(() => spawn("three"), /limit reached/);

  provider.failNext = true;
  provider.releaseOne();
  await tick();
  assert.equal(manager.get(first.id)?.tasks[0]?.status, "failed");
  assert.equal(manager.activeCount(), 1);

  provider.holdCreates = false;
  provider.releaseOne();
  await tick();
  assert.equal(manager.get(second.id)?.tasks[0]?.status, "working");
  const third = spawn("three");
  await tick();
  assert.equal(manager.get(third.id)?.tasks[0]?.status, "working");
  await manager.dispose();
});

test("optional selection validation runs before spawn and every follow-up", async () => {
  const provider = new FakeProvider();
  const manager = new SubagentManager({
    factory: provider,
    getConfig: () => config(),
    persist: () => {},
    onSettled: () => {},
    onFyi: () => {},
    validateSelection: (worker) => {
      if (worker.model !== "fake/model")
        throw new Error(`selection is unavailable: ${worker.model}`);
    },
  });

  assert.throws(
    () =>
      manager.spawn({
        name: "rejected",
        brief: "must not start",
        cwd: process.cwd(),
        model: "missing/model",
        reasoning: "low",
      }),
    /selection is unavailable/,
  );
  assert.equal(manager.activeCount(), 0);
  assert.equal(manager.list().length, 0);

  const worker = manager.spawn({
    name: "validated",
    brief: "first task",
    cwd: process.cwd(),
    model: "fake/model",
    reasoning: "low",
  });
  await tick();
  const session = provider.sessions.get(worker.id);
  assert.ok(session);
  session.complete("done");
  manager.require(worker.id).model = "missing/model";
  assert.throws(
    () => manager.followup(worker.id, "rejected parent follow-up"),
    /selection is unavailable/,
  );
  manager.beginTakeover(worker.id);
  assert.throws(
    () => manager.humanSend(worker.id, "rejected human follow-up"),
    /selection is unavailable/,
  );
  assert.equal(manager.activeCount(), 0);
  assert.equal(manager.require(worker.id).tasks.length, 1);
  await manager.dispose();
});

test("a completed worker accepts a related follow-up in the same conversation", async () => {
  const { manager, provider, spawn } = harness();
  const worker = spawn();
  await tick();
  const session = provider.sessions.get(worker.id)!;
  session.complete("first answer");
  assert.equal(manager.get(worker.id)?.tasks[0]?.result, "first answer");

  manager.followup(worker.id, "related second task");
  assert.equal(provider.createCount, 1);
  assert.deepEqual(session.starts, ["task for worker", "related second task"]);
  session.fail("second task failed");
  const restored = manager.get(worker.id)!;
  assert.equal(restored.tasks[0]?.result, "first answer");
  assert.equal(restored.tasks[1]?.status, "failed");
  assert.equal(restored.tasks[1]?.result, "");
  await manager.dispose();
});

test("starting and stopping steering errors do not mislabel a busy worker as idle", async () => {
  const h = harness();
  h.provider.holdCreates = true;
  const worker = h.spawn();
  await assert.rejects(
    h.manager.steer(worker.id, "correction"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /status "starting"/);
      assert.match(error.message, /Wait until/);
      assert.doesNotMatch(error.message, /cannot reach an idle worker/);
      return true;
    },
  );
  h.provider.releaseOne();
  await tick();
  h.provider.sessions.get(worker.id)!.cleanupError("still stopping");
  await assert.rejects(
    h.manager.steer(worker.id, "correction"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /status "stopping"/);
      assert.match(
        error.message,
        /until it stops before using subagent_followup/,
      );
      return true;
    },
  );
  await h.manager.dispose();
});

test("steering and interruption affect only the selected active worker", async () => {
  const { manager, provider, spawn } = harness();
  const one = spawn("one");
  const two = spawn("two");
  await tick();
  await manager.steer(two.id, "correct course");
  assert.deepEqual(provider.sessions.get(one.id)?.steers, []);
  assert.deepEqual(provider.sessions.get(two.id)?.steers, ["correct course"]);
  const interrupted = await manager.interrupt(one.id);
  assert.equal(interrupted.task.status, "interrupted");
  assert.equal(manager.get(two.id)?.tasks[0]?.status, "working");
  await manager.dispose();
});

test("steering an idle worker names its task and points to follow-up", async () => {
  const { manager, provider, persisted, spawn } = harness();
  const worker = spawn("idle-target");
  await tick();
  const session = provider.sessions.get(worker.id)!;
  session.complete("finished before steering");
  const taskId = manager.require(worker.id).currentTaskId!;
  const persistedBefore = persisted.length;
  const startsBefore = session.starts.length;

  await assert.rejects(manager.steer(worker.id, "too late"), (error: Error) => {
    assert.match(error.message, /not actively working/);
    assert.match(error.message, new RegExp(worker.id));
    assert.match(error.message, new RegExp(taskId));
    assert.match(error.message, /completed/);
    assert.match(error.message, /subagent_followup/);
    assert.match(error.message, new RegExp(`id "${worker.id}"`));
    return true;
  });
  assert.deepEqual(session.steers, []);
  assert.equal(manager.require(worker.id).tasks.length, 1);
  assert.equal(session.starts.length, startsBefore);
  assert.equal(manager.activeCount(), 0);
  assert.equal(
    persisted.length,
    persistedBefore,
    "a rejected steer never persists or starts work",
  );
  await manager.dispose();
});

test("steering a worker with no current task reports the idle state", async () => {
  const restored: WorkerRecord = {
    id: "sa-restored-idle",
    name: "idle-restored",
    cwd: process.cwd(),
    model: "fake/model",
    reasoning: "low",
    createdAt: 0,
    updatedAt: 0,
    takenOver: false,
    tasks: [],
  };
  const { manager, persisted } = harness(4, [restored]);
  const persistedBefore = persisted.length;

  await assert.rejects(manager.steer(restored.id, "nudge"), (error: Error) => {
    assert.match(error.message, /not actively working/);
    assert.match(error.message, /no current task/);
    assert.match(error.message, /subagent_followup/);
    return true;
  });
  assert.equal(persisted.length, persistedBefore);
  assert.equal(manager.require(restored.id).tasks.length, 0);
  await manager.dispose();
});

test("a settle during steering replaces the provider error with idle guidance", async () => {
  const { manager, provider, spawn } = harness();
  const worker = spawn("race-target");
  await tick();
  const session = provider.sessions.get(worker.id)!;
  const taskId = manager.require(worker.id).currentTaskId!;
  const startsBefore = session.starts.length;
  session.settleOnSteer = true;

  await assert.rejects(
    manager.steer(worker.id, "lands after settle"),
    (error: Error) => {
      assert.notEqual(error.message, "idle");
      assert.match(error.message, /not actively working/);
      assert.match(error.message, new RegExp(taskId));
      assert.match(error.message, /completed/);
      assert.match(error.message, /subagent_followup/);
      return true;
    },
  );
  assert.deepEqual(session.steers, []);
  assert.equal(manager.require(worker.id).tasks.length, 1);
  assert.equal(session.starts.length, startsBefore);
  assert.equal(manager.activeCount(), 0);
  await manager.dispose();
});

test("a real active steering failure is preserved and leaves the task working", async () => {
  const { manager, provider, spawn } = harness();
  const worker = spawn("active-failure");
  await tick();
  const session = provider.sessions.get(worker.id)!;
  session.steerError = new Error("provider rejected steering");

  await assert.rejects(
    manager.steer(worker.id, "will fail"),
    /provider rejected steering/,
  );
  assert.equal(manager.get(worker.id)?.tasks[0]?.status, "working");
  assert.equal(manager.activeCount(), 1);
  assert.equal(manager.require(worker.id).tasks.length, 1);
  assert.equal(session.starts.length, 1);
  assert.deepEqual(session.steers, []);
  await manager.dispose();
});

test("takeover rejection precedes idle steering guidance", async () => {
  const { manager, provider, spawn } = harness();
  const worker = spawn("taken-over-idle");
  await tick();
  const session = provider.sessions.get(worker.id)!;
  session.complete("finished");
  manager.beginTakeover(worker.id);

  await assert.rejects(
    manager.steer(worker.id, "parent nudge"),
    (error: Error) => {
      assert.match(error.message, /exclusive human takeover/);
      assert.doesNotMatch(error.message, /subagent_followup/);
      return true;
    },
  );
  assert.deepEqual(session.steers, []);
  assert.equal(manager.require(worker.id).tasks.length, 1);
  await manager.dispose();
});

test("FYI reports do not settle; questions stop with their report", async () => {
  const { manager, provider, fyi, settled, spawn } = harness();
  const worker = spawn();
  await tick();
  const session = provider.sessions.get(worker.id)!;
  session.report("fyi", "halfway");
  assert.equal(fyi.length, 1);
  assert.equal(settled.length, 0);
  assert.equal(manager.get(worker.id)?.tasks[0]?.status, "working");
  session.report("question", "which format?");
  session.report("fyi", "later sibling FYI must not replace the question");
  session.report(
    "blocked",
    "later sibling blocker must not replace the question",
  );
  session.complete("ignored completion prose");
  assert.equal(manager.get(worker.id)?.tasks[0]?.status, "question");
  assert.equal(
    manager.get(worker.id)?.tasks[0]?.result,
    "",
    "question prose is not a completion result",
  );
  assert.equal(settled[0]?.task.report?.kind, "question");
  assert.equal(settled[0]?.task.report?.message, "which format?");
  await manager.dispose();
});

test("cleanup failures wake waits and reach the parent without releasing capacity", async () => {
  const { manager, provider, settled, spawn } = harness(1);
  const worker = spawn("cleanup-failure");
  await tick();
  const session = provider.sessions.get(worker.id);
  assert.ok(session);

  const waiting = manager.wait([worker.id], "all");
  session.cleanupError("could not stop background process");
  const [result] = await waiting;

  assert.equal(result?.task.status, "stopping");
  assert.equal(result?.task.error, "could not stop background process");
  assert.equal(settled.length, 1, "parent receives the cleanup failure");
  assert.equal(
    manager.activeCount(),
    1,
    "capacity stays reserved until stop succeeds",
  );
  assert.throws(() => manager.followup(worker.id, "not until stopped"), /busy/);

  const interrupted = await manager.interrupt(worker.id);
  assert.equal(interrupted.task.status, "interrupted");
  assert.equal(manager.activeCount(), 0);
  await manager.dispose();
});

test("worker output is bounded in state and marks the complete transcript reference", async () => {
  const { manager, provider, spawn } = harness();
  const worker = spawn();
  await tick();
  provider.sessions.get(worker.id)?.complete("x".repeat(65 * 1024));
  const task = manager.get(worker.id)?.tasks[0];
  assert.equal(task?.result?.length, 64 * 1024);
  assert.equal(task?.resultTruncated, true);
  await manager.dispose();
});

test("any/all waits snapshot task IDs and cancellation leaves workers running", async () => {
  const { manager, provider, spawn } = harness();
  const one = spawn("one");
  const two = spawn("two");
  await tick();
  const any = manager.wait([one.id, two.id], "any");
  provider.sessions.get(two.id)?.complete("two done");
  const anyResult = await any;
  assert.deepEqual(
    anyResult.map((result) => result.worker.id),
    [two.id],
  );
  assert.equal(manager.get(one.id)?.tasks[0]?.status, "working");

  const controller = new AbortController();
  const cancelled = manager.wait([one.id], "all", controller.signal);
  controller.abort(new Error("cancel wait"));
  await assert.rejects(cancelled, /cancel wait/);
  assert.equal(manager.get(one.id)?.tasks[0]?.status, "working");

  const all = manager.wait([one.id, two.id], "all");
  provider.sessions.get(one.id)?.complete("one done");
  assert.equal((await all).length, 2);
  await manager.dispose();
});

test("blockers return an all-wait early while other workers keep running", async () => {
  const { manager, provider, spawn } = harness();
  const one = spawn("one");
  const two = spawn("two");
  await tick();
  const waiting = manager.wait([one.id, two.id], "all");
  const session = provider.sessions.get(one.id)!;
  session.report("blocked", "missing fixture");
  session.complete("");
  const result = await waiting;
  assert.equal(result.length, 1);
  assert.equal(result[0]?.task.status, "blocked");
  assert.equal(manager.get(two.id)?.tasks[0]?.status, "working");
  await manager.dispose();
});

test("human takeover is exclusive until handback", async () => {
  const { manager, provider, spawn } = harness();
  const worker = spawn();
  await tick();
  manager.beginTakeover(worker.id);
  assert.throws(
    () => manager.followup(worker.id, "parent task"),
    /exclusive human takeover/,
  );
  await assert.rejects(
    manager.steer(worker.id, "parent steer"),
    /exclusive human takeover/,
  );
  await manager.humanSend(worker.id, "human steer");
  assert.deepEqual(provider.sessions.get(worker.id)?.steers, ["human steer"]);
  manager.endTakeover(worker.id);
  await manager.steer(worker.id, "parent steer");
  assert.deepEqual(provider.sessions.get(worker.id)?.steers, [
    "human steer",
    "parent steer",
  ]);
  await manager.dispose();
});

test("persistence failures do not prevent worker startup or cleanup", async () => {
  const provider = new FakeProvider();
  const persistenceErrors: string[] = [];
  const manager = new SubagentManager({
    factory: provider,
    getConfig: () => config(),
    persist: () => {
      throw new Error("session storage unavailable");
    },
    onSettled: () => {},
    onFyi: () => {},
    onPersistenceError: (message) => persistenceErrors.push(message),
  });
  const worker = manager.spawn({
    name: "persistence-error",
    brief: "complete task",
    cwd: process.cwd(),
    model: "fake/model",
    reasoning: "low",
  });
  await tick();
  assert.equal(manager.get(worker.id)?.tasks[0]?.status, "working");
  assert.ok(persistenceErrors.includes("session storage unavailable"));

  const failures = await manager.dispose();
  assert.deepEqual(failures, []);
  assert.equal(manager.activeCount(), 0);
  assert.equal(manager.get(worker.id)?.tasks[0]?.status, "interrupted");
});

test("cleanup reports close failures from a session that finishes starting late", async () => {
  const { manager, provider, cleanupErrors, spawn } = harness();
  provider.holdCreates = true;
  const worker = spawn("late-close");
  const cleanup = manager.dispose();
  provider.closeErrorNext = new Error("late startup close failed");
  provider.releaseOne();

  const failures = await cleanup;
  assert.equal(failures.length, 1);
  assert.match(
    failures[0] ?? "",
    new RegExp(`${worker.id}.*late startup close failed`),
  );
  assert.ok(
    cleanupErrors.some((message) =>
      message.includes("late startup close failed"),
    ),
    "late launch rejection is observed and reported even if disposal stops waiting",
  );
  assert.equal(manager.activeCount(), 0);
  assert.equal(manager.get(worker.id)?.tasks[0]?.status, "interrupted");
});

test("cleanup interrupts active sessions, clears reservations, and preserves metadata", async () => {
  const { manager, provider, persisted, spawn } = harness();
  const one = spawn("one");
  const two = spawn("two");
  await tick();
  const failures = await manager.dispose();
  assert.deepEqual(failures, []);
  assert.equal(provider.sessions.get(one.id)?.closed, true);
  assert.equal(provider.sessions.get(two.id)?.closed, true);
  assert.equal(manager.activeCount(), 0);
  const last = persisted.at(-1)!;
  assert.equal(
    last.find((worker) => worker.id === one.id)?.tasks[0]?.status,
    "interrupted",
  );
});

test("presentation falls back to the transcript for legacy factories", async () => {
  const { manager, provider, spawn } = harness();
  const worker = spawn("legacy");
  await tick();
  const session = provider.sessions.get(worker.id)!;
  session.items.push({ role: "assistant", text: "legacy transcript" });
  // A factory written before the presentation API has no session method at
  // all; the optional call must fall back to the transcript reader.
  Object.defineProperty(session, "presentation", { value: undefined });

  const presentation = manager.presentation(worker.id);
  assert.deepEqual(presentation.transcript, [
    { role: "user", text: "task for legacy" },
    { role: "assistant", text: "legacy transcript" },
  ]);
  assert.equal(presentation.streamingText, undefined);
  assert.deepEqual(presentation, { transcript: manager.transcript(worker.id) });
  await manager.dispose();
});

test("read-only presentation never persists or mutates worker lifecycle", async () => {
  const { manager, provider, persisted, settled, fyi, spawn } = harness();
  const worker = spawn("view-only");
  await tick();
  const session = provider.sessions.get(worker.id)!;
  session.livePresentation = {
    transcript: [{ role: "assistant", text: "partial" }],
    streamingText: "partial",
    activity: "responding",
  };
  const persistedBefore = persisted.length;
  const updatedBefore = manager.get(worker.id)?.updatedAt;

  const presentation = manager.presentation(worker.id);
  assert.equal(presentation.streamingText, "partial");
  assert.equal(presentation.activity, "responding");
  assert.deepEqual(presentation.transcript, [
    { role: "assistant", text: "partial" },
  ]);
  assert.equal(manager.get(worker.id)?.tasks[0]?.status, "working");
  assert.equal(manager.get(worker.id)?.updatedAt, updatedBefore);
  assert.equal(manager.activeCount(), 1);
  assert.equal(persisted.length, persistedBefore);
  assert.equal(settled.length, 0);
  assert.equal(fyi.length, 0);
  await manager.dispose();
});

test("presentation of an unknown worker is rejected without side effects", async () => {
  const { manager, persisted } = harness();
  const persistedBefore = persisted.length;
  assert.throws(() => manager.presentation("missing"), /Unknown worker/);
  assert.equal(persisted.length, persistedBefore);
  await manager.dispose();
});

test("live presentation notifications update observers without settling or waking waits", async () => {
  const { manager, provider, persisted, settled, fyi, spawn } = harness();
  const worker = spawn("live");
  await tick();
  const session = provider.sessions.get(worker.id)!;
  let notifications = 0;
  const unsubscribe = manager.subscribe(() => notifications++);
  let waitSettled = false;
  const waiting = manager.wait([worker.id], "all").then((result) => {
    waitSettled = true;
    return result;
  });
  const persistedBefore = persisted.length;

  session.livePresentation = {
    transcript: session.transcript(),
    activity: "thinking",
  };
  session.present();
  await tick();

  assert.equal(notifications, 1, "presentation changes notify UI observers");
  assert.equal(waitSettled, false, "presentation is not a completion signal");
  assert.equal(settled.length, 0);
  assert.equal(fyi.length, 0);
  assert.equal(persisted.length, persistedBefore);
  assert.equal(manager.get(worker.id)?.tasks[0]?.status, "working");

  session.complete("finished");
  await waiting;
  unsubscribe();
  await manager.dispose();
});

test("disposal suppresses presentation notifications from late session updates", async () => {
  const { manager, provider, spawn } = harness();
  const worker = spawn("late-live");
  await tick();
  const session = provider.sessions.get(worker.id)!;
  await manager.dispose();

  let notifications = 0;
  manager.subscribe(() => notifications++);
  session.present();
  assert.equal(
    notifications,
    0,
    "presentation events after disposal must not reach observers",
  );
});

test("unavailable restored workers present their reason instead of throwing", async () => {
  const restored: WorkerRecord = {
    id: "sa-restored-missing",
    name: "missing",
    cwd: process.cwd(),
    model: "fake/model",
    reasoning: "low",
    createdAt: 0,
    updatedAt: 0,
    takenOver: false,
    tasks: [],
  };
  const { manager, persisted, settled } = harness(4, [restored]);
  const persistedBefore = persisted.length;

  const presentation = manager.presentation(restored.id);
  assert.deepEqual(presentation.transcript, []);
  assert.match(String(presentation.activity), /no saved Pi session reference/);
  assert.equal(persisted.length, persistedBefore);
  assert.equal(settled.length, 0);
  await manager.dispose();
});

test("a failing live presentation is reported as a diagnostic without lifecycle writes", async () => {
  const { manager, provider, persisted, settled, fyi, spawn } = harness();
  const worker = spawn("broken-live");
  await tick();
  const session = provider.sessions.get(worker.id)!;
  const persistedBefore = persisted.length;

  session.presentationError = new Error("presentation boom");
  const liveFailure = manager.presentation(worker.id);
  assert.deepEqual(liveFailure.transcript, []);
  assert.match(
    String(liveFailure.activity),
    /Transcript unavailable: presentation boom/,
  );
  assert.equal(manager.get(worker.id)?.tasks[0]?.status, "working");
  assert.equal(manager.activeCount(), 1);
  assert.equal(persisted.length, persistedBefore);
  assert.equal(settled.length, 0);
  assert.equal(fyi.length, 0);

  // A legacy factory without `presentation()` takes the transcript fallback,
  // which must surface a transcript failure the same diagnostic way.
  session.presentationError = undefined;
  Object.defineProperty(session, "presentation", { value: undefined });
  session.transcriptError = new Error("transcript boom");
  const fallbackFailure = manager.presentation(worker.id);
  assert.deepEqual(fallbackFailure.transcript, []);
  assert.match(
    String(fallbackFailure.activity),
    /Transcript unavailable: transcript boom/,
  );
  assert.equal(persisted.length, persistedBefore);
  assert.equal(settled.length, 0);
  await manager.dispose();
});
