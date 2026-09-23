import assert from "node:assert/strict";
import test from "node:test";
import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import { restoreState, STATE_ENTRY_TYPE } from "./src/state.ts";
import type { WorkerRecord } from "./src/types.ts";

const OWNER_ID = "parent-session";

function entry(data: unknown): CustomEntry<unknown> {
  return {
    type: "custom",
    id: "state-entry",
    parentId: null,
    timestamp: new Date().toISOString(),
    customType: STATE_ENTRY_TYPE,
    data,
  };
}

function worker(
  id: string,
  status: WorkerRecord["tasks"][number]["status"],
): WorkerRecord {
  return {
    id,
    name: id,
    cwd: process.cwd(),
    model: "fake/model",
    reasoning: "low",
    createdAt: 1,
    updatedAt: 2,
    takenOver: true,
    currentTaskId: `${id}-task`,
    tasks: [
      {
        id: `${id}-task`,
        brief: "task brief",
        status,
        startedAt: 1,
      },
    ],
  };
}

test("restoration skips malformed worker records without hiding valid siblings", () => {
  const active = worker("valid", "working");
  const malformed = { ...worker("malformed", "completed"), tasks: [null] };
  const session = {
    getBranch: () => [
      entry({
        version: 1,
        ownerSessionId: OWNER_ID,
        workers: [malformed, active],
      }),
    ],
    getSessionId: () => OWNER_ID,
  };

  const restored = restoreState(session);
  assert.equal(restored.workers.length, 1);
  assert.equal(restored.workers[0]?.id, "valid");
  assert.equal(restored.workers[0]?.takenOver, false);
  assert.equal(restored.workers[0]?.tasks[0]?.status, "interrupted");
});

test("a state entry from a different parent session is not restored", () => {
  const restored = restoreState({
    getBranch: () => [
      entry({
        version: 1,
        ownerSessionId: "original-parent",
        workers: [worker("worker", "completed")],
      }),
    ],
    getSessionId: () => OWNER_ID,
  });

  assert.deepEqual(restored, {
    workers: [],
    ownerMismatch: "original-parent",
  });
});
