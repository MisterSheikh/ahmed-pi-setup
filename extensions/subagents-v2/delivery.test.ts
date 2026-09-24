import assert from "node:assert/strict";
import test from "node:test";
import { createDeferredDelivery } from "./src/delivery.ts";
import type { TaskResult } from "./src/manager.ts";
import type { WorkerTask } from "./src/types.ts";

function result(
  overrides: Partial<WorkerTask> = {},
  workerId = "w1",
): TaskResult {
  const task: WorkerTask = {
    id: `${workerId}-t1`,
    brief: "task",
    status: "completed",
    startedAt: 1,
    settledAt: 2,
    result: "done",
    ...overrides,
  };
  return {
    worker: {
      id: workerId,
      name: workerId,
      cwd: "/tmp",
      model: "fake/model",
      reasoning: "low",
      createdAt: 1,
      updatedAt: 2,
      takenOver: false,
      currentTaskId: task.id,
      tasks: [task],
    },
    task,
  };
}
const progress = (message: string, at = 2) =>
  result({
    status: "working",
    settledAt: undefined,
    result: undefined,
    report: { kind: "fyi", message, at },
  });

test("acknowledgement suppresses the exact revision even if it is deferred again", () => {
  const queue = createDeferredDelivery();
  const item = result();
  queue.defer(item);
  queue.consume([item]);
  queue.defer(result());
  assert.deepEqual(queue.drain(), []);
});

test("an active inspection does not acknowledge the future completed result", () => {
  const queue = createDeferredDelivery();
  queue.consume([
    result({ status: "working", settledAt: undefined, result: undefined }),
  ]);
  const completed = result();
  queue.defer(completed);
  assert.deepEqual(queue.drain(), [completed]);
});

test("acknowledging an older revision cannot erase a newer queued failure", () => {
  const queue = createDeferredDelivery();
  const previous = result({ status: "stopping", error: "first cleanup error" });
  const latest = result({ status: "stopping", error: "second cleanup error" });
  queue.defer(previous);
  queue.defer(latest);
  queue.consume([previous]);
  assert.deepEqual(queue.drain(), [latest]);
});

test("new results, reports and truncation state are distinct acknowledged revisions", () => {
  for (const change of [
    { result: "different result" },
    { resultTruncated: true },
    { error: "new error" },
    { report: { kind: "blocked", message: "new obstacle", at: 3 } },
  ] satisfies Partial<WorkerTask>[]) {
    const queue = createDeferredDelivery();
    queue.consume([result()]);
    const updated = result(change);
    queue.defer(updated);
    assert.deepEqual(queue.drain(), [updated]);
  }
});

test("newer progress does not prevent acknowledgement of an unchanged cleanup failure", () => {
  const queue = createDeferredDelivery();
  const earlier = result({
    status: "stopping",
    error: "cleanup failed",
    report: { kind: "fyi", message: "earlier", at: 2 },
  });
  queue.defer(earlier);
  queue.consume([
    result({
      ...earlier.task,
      report: { kind: "fyi", message: "newer", at: 3 },
    }),
  ]);
  assert.deepEqual(queue.drain(), []);
});

test("acknowledging one task never consumes another task or worker", () => {
  const queue = createDeferredDelivery();
  const first = result();
  const second = result({ id: "w1-t2" });
  const other = result({}, "w2");
  for (const item of [first, second, other]) queue.defer(item);
  queue.consume([first]);
  assert.deepEqual(queue.drain(), [second, other]);
});

test("deferred progress coalesces to the latest FYI for each task", () => {
  const queue = createDeferredDelivery();
  queue.deferFyi(progress("first"));
  const latest = progress("latest", 3);
  queue.deferFyi(latest);
  assert.deepEqual(queue.drainFyi(), [latest]);
});

test("a lifecycle result supersedes pending progress but not other tasks' reports", () => {
  const queue = createDeferredDelivery();
  queue.deferFyi(progress("obsolete"));
  const other = result({
    id: "w1-t2",
    status: "working",
    report: { kind: "fyi", message: "other task", at: 3 },
  });
  queue.deferFyi(other);
  queue.defer(result());
  queue.deferFyi(progress("late progress"));
  assert.deepEqual(queue.drainFyi(), [other]);
  assert.equal(queue.drain().length, 1);
});

test("inspection acknowledges only the FYI actually included in its snapshot", () => {
  const queue = createDeferredDelivery();
  const first = progress("first");
  const latest = progress("latest", 3);
  queue.deferFyi(first);
  queue.deferFyi(latest);
  queue.consume([first]);
  assert.deepEqual(queue.drainFyi(), [latest]);
  queue.consume([latest]);
  queue.deferFyi(latest);
  assert.deepEqual(queue.drainFyi(), []);
});

test("delivered FYIs do not consume later completion and failed sends can retry", () => {
  const queue = createDeferredDelivery();
  const fyi = progress("update");
  queue.deferFyi(fyi);
  const drained = queue.drainFyi();
  // Draining is not acknowledgement; a synchronous send failure can requeue.
  queue.deferFyi(drained[0]);
  assert.deepEqual(queue.drainFyi(), [fyi]);
  queue.consumeFyi([fyi]);
  queue.deferFyi(fyi);
  assert.deepEqual(queue.drainFyi(), []);
  const completed = result({ report: fyi.task.report });
  queue.defer(completed);
  assert.deepEqual(queue.drain(), [completed]);
});

test("clear removes both queues and acknowledgements at session teardown", () => {
  const queue = createDeferredDelivery();
  queue.consume([result()]);
  queue.consumeFyi([progress("seen")]);
  queue.defer(result({ id: "w1-t2" }));
  queue.deferFyi(progress("pending"));
  queue.clear();
  assert.deepEqual(queue.drain(), []);
  assert.deepEqual(queue.drainFyi(), []);
  queue.defer(result());
  queue.deferFyi(progress("seen")); // The pending lifecycle result takes precedence.
  assert.deepEqual(queue.drainFyi(), []);
  assert.deepEqual(queue.drain(), [result()]);
  queue.deferFyi(progress("seen"));
  assert.deepEqual(queue.drainFyi(), [progress("seen")]);
});
