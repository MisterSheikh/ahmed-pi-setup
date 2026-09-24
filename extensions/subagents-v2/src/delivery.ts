import { createHash } from "node:crypto";
import type { TaskResult } from "./manager.ts";

const key = ({ worker, task }: TaskResult) =>
  JSON.stringify([worker.id, task.id]);
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const revision = ({ task }: TaskResult) =>
  digest([
    task.status,
    task.startedAt,
    task.settledAt,
    task.result,
    task.resultTruncated,
    task.error,
    // Progress has its own acknowledgement; a newer FYI must not make an
    // otherwise unchanged lifecycle result look unseen after inspection.
    task.report?.kind === "fyi" ? undefined : task.report,
  ]);
const reportRevision = ({ task }: TaskResult) => digest(task.report ?? null);

/** Session-local delivery state; acknowledgements name exact task/report revisions. */
export function createDeferredDelivery() {
  const pending = new Map<string, TaskResult>();
  const pendingFyi = new Map<string, TaskResult>();
  const seen = new Set<string>();
  const seenReports = new Set<string>();
  const resultKey = (result: TaskResult) =>
    `${key(result)}:${revision(result)}`;
  const reportKey = (result: TaskResult) =>
    `${key(result)}:${reportRevision(result)}`;

  const consumeFyi = (results: readonly TaskResult[]) => {
    for (const result of results) {
      if (result.task.report?.kind !== "fyi") continue;
      seenReports.add(reportKey(result));
      const queued = pendingFyi.get(key(result));
      if (queued && reportRevision(queued) === reportRevision(result))
        pendingFyi.delete(key(result));
    }
  };

  return {
    defer(result: TaskResult) {
      // A lifecycle result supersedes any still-undelivered progress for this task.
      pendingFyi.delete(key(result));
      if (!seen.has(resultKey(result))) pending.set(key(result), result);
    },
    deferFyi(result: TaskResult) {
      if (result.task.report?.kind !== "fyi" || pending.has(key(result)))
        return;
      if (!seenReports.has(reportKey(result)))
        pendingFyi.set(key(result), result);
    },
    consume(results: readonly TaskResult[]) {
      for (const result of results) {
        seen.add(resultKey(result));
        const queued = pending.get(key(result));
        // Inspecting an older snapshot must not erase a newer failure/result.
        if (queued && revision(queued) === revision(result))
          pending.delete(key(result));
      }
      consumeFyi(results);
    },
    consumeFyi,
    drain() {
      const values = [...pending.values()];
      pending.clear();
      return values;
    },
    drainFyi() {
      const values = [...pendingFyi.values()];
      pendingFyi.clear();
      return values;
    },
    clear() {
      pending.clear();
      pendingFyi.clear();
      seen.clear();
      seenReports.clear();
    },
  };
}
