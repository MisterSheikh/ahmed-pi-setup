import type {
  CustomEntry,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  cloneWorker,
  isActiveStatus,
  THINKING_LEVELS,
  type PersistedState,
  type TaskStatus,
  type WorkerRecord,
} from "./types.ts";

export const STATE_ENTRY_TYPE = "subagents-v2-state";

const TASK_STATUSES: readonly TaskStatus[] = [
  "starting",
  "working",
  "stopping",
  "completed",
  "question",
  "blocked",
  "failed",
  "interrupted",
  "unknown",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTask(value: unknown) {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    typeof value.brief !== "string" ||
    !TASK_STATUSES.includes(value.status as TaskStatus) ||
    !isFiniteNumber(value.startedAt)
  ) {
    return false;
  }
  if (value.settledAt !== undefined && !isFiniteNumber(value.settledAt))
    return false;
  if (value.result !== undefined && typeof value.result !== "string")
    return false;
  if (
    value.resultTruncated !== undefined &&
    typeof value.resultTruncated !== "boolean"
  ) {
    return false;
  }
  if (value.error !== undefined && typeof value.error !== "string")
    return false;
  if (value.report !== undefined) {
    if (
      !isRecord(value.report) ||
      !["fyi", "question", "blocked"].includes(String(value.report.kind)) ||
      typeof value.report.message !== "string" ||
      !isFiniteNumber(value.report.at)
    ) {
      return false;
    }
  }
  return true;
}

function isWorker(value: unknown): value is WorkerRecord {
  if (!isRecord(value) || !Array.isArray(value.tasks)) return false;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.cwd !== "string" ||
    typeof value.model !== "string" ||
    !THINKING_LEVELS.includes(value.reasoning as WorkerRecord["reasoning"]) ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt) ||
    typeof value.takenOver !== "boolean" ||
    !value.tasks.every(isTask)
  ) {
    return false;
  }
  if (value.sessionFile !== undefined && typeof value.sessionFile !== "string")
    return false;
  if (
    value.unavailableReason !== undefined &&
    typeof value.unavailableReason !== "string"
  ) {
    return false;
  }
  if (
    value.currentTaskId !== undefined &&
    (typeof value.currentTaskId !== "string" ||
      !value.tasks.some((task) => task.id === value.currentTaskId))
  ) {
    return false;
  }
  return true;
}

function isState(
  value: unknown,
): value is { version: 1; ownerSessionId: string; workers: unknown[] } {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.ownerSessionId === "string" &&
    Array.isArray(value.workers)
  );
}

export function restoreState(
  manager: Pick<
    ExtensionContext["sessionManager"],
    "getBranch" | "getSessionId"
  >,
): { workers: WorkerRecord[]; ownerMismatch?: string } {
  const entries = manager.getBranch();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      entry.type !== "custom" ||
      (entry as CustomEntry).customType !== STATE_ENTRY_TYPE
    )
      continue;
    const data: unknown = (entry as CustomEntry).data;
    if (!isState(data)) continue;
    if (data.ownerSessionId !== manager.getSessionId()) {
      return { workers: [], ownerMismatch: data.ownerSessionId };
    }
    const workers: WorkerRecord[] = [];
    const seenIds = new Set<string>();
    for (const value of data.workers) {
      if (!isWorker(value) || seenIds.has(value.id)) continue;
      seenIds.add(value.id);
      const copy = cloneWorker(value);
      copy.takenOver = false;
      copy.unavailableReason = undefined;
      const current = copy.tasks.find((task) => task.id === copy.currentTaskId);
      if (current && isActiveStatus(current.status)) {
        current.status = "interrupted";
        current.error = "Parent session ended before this task settled.";
        current.settledAt = Date.now();
      }
      workers.push(copy);
    }
    return { workers };
  }
  return { workers: [] };
}

export function makeState(
  ownerSessionId: string,
  workers: readonly WorkerRecord[],
): PersistedState {
  return { version: 1, ownerSessionId, workers: workers.map(cloneWorker) };
}
