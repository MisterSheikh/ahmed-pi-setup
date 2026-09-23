import type { TaskResult } from "./manager.ts";

export function createDeferredDelivery() {
  const pending = new Map<string, TaskResult>();
  const key = (result: TaskResult) => `${result.worker.id}:${result.task.id}`;
  return {
    defer(result: TaskResult) {
      pending.set(key(result), result);
    },
    consume(results: readonly TaskResult[]) {
      for (const result of results) pending.delete(key(result));
    },
    drain() {
      const values = [...pending.values()];
      pending.clear();
      return values;
    },
    clear() {
      pending.clear();
    },
  };
}
