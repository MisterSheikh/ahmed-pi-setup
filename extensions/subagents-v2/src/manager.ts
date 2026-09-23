import * as fs from "node:fs";
import {
  cloneWorker,
  isActiveStatus,
  isStoppedStatus,
  type SessionTranscriptItem,
  type SubagentsConfig,
  type WorkerRecord,
  type WorkerPresentation,
  type WorkerSession,
  type WorkerSessionFactory,
  type WorkerTask,
} from "./types.ts";

const STOP_TIMEOUT_MS = 5_000;
const RESULT_MAX_CHARS = 64 * 1024;
const REPORT_MAX_CHARS = 4_096;
const ERROR_MAX_CHARS = 4_096;

export interface TaskResult {
  worker: WorkerRecord;
  task: WorkerTask;
}

export interface SubagentManagerOptions {
  factory: WorkerSessionFactory;
  restored?: WorkerRecord[];
  getConfig(): SubagentsConfig;
  persist(workers: readonly WorkerRecord[]): void;
  onSettled(result: TaskResult): void;
  onFyi(result: TaskResult): void;
  onPersistenceError?(message: string): void;
  onCleanupError?(message: string): void;
  validateSelection?(worker: WorkerRecord): void;
}

export type WaitMode = "any" | "all";

function boundedText(text: string, maxChars = RESULT_MAX_CHARS) {
  return text.slice(0, maxChars);
}

function errorText(error: unknown) {
  return boundedText(
    error instanceof Error ? error.message : String(error),
    ERROR_MAX_CHARS,
  );
}

function taskOf(worker: WorkerRecord, taskId = worker.currentTaskId) {
  return worker.tasks.find((task) => task.id === taskId);
}

function copyResult(worker: WorkerRecord, task: WorkerTask): TaskResult {
  const copiedWorker = cloneWorker(worker);
  const copiedTask = copiedWorker.tasks.find(
    (candidate) => candidate.id === task.id,
  );
  if (!copiedTask) throw new Error(`Task "${task.id}" disappeared.`);
  return { worker: copiedWorker, task: copiedTask };
}

function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
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

export class SubagentManager {
  private readonly workers = new Map<string, WorkerRecord>();
  private readonly sessions = new Map<string, WorkerSession>();
  private readonly launches = new Map<string, Promise<void>>();
  private readonly reservations = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly waitListeners = new Set<() => void>();
  private disposed = false;
  private counter = 0;

  private readonly options: SubagentManagerOptions;

  constructor(options: SubagentManagerOptions) {
    this.options = options;
    for (const restored of options.restored ?? []) {
      const worker = cloneWorker(restored);
      worker.takenOver = false;
      if (worker.sessionFile) {
        try {
          fs.accessSync(worker.sessionFile, fs.constants.R_OK);
          options.factory.readTranscript(worker);
        } catch (error) {
          worker.unavailableReason = `Worker session is missing or unreadable: ${worker.sessionFile} (${errorText(error)})`;
        }
      } else {
        worker.unavailableReason = "Worker has no saved Pi session reference.";
      }
      this.workers.set(worker.id, worker);
    }
  }

  private notify(presentationOnly = false) {
    const observers = presentationOnly
      ? [...this.listeners]
      : [...this.listeners, ...this.waitListeners];
    for (const listener of observers) {
      try {
        listener();
      } catch {
        // Observers cannot corrupt orchestration state.
      }
    }
  }

  private reportCleanupFailure(message: string) {
    try {
      this.options.onCleanupError?.(message);
    } catch {
      // Cleanup diagnostics cannot break worker lifecycle transitions.
    }
  }

  private changed() {
    try {
      this.options.persist(this.list());
    } catch (error) {
      try {
        this.options.onPersistenceError?.(errorText(error));
      } catch {
        // Persistence diagnostics cannot break worker lifecycle transitions.
      }
    }
    this.notify();
  }

  private nextWorkerId() {
    let id: string;
    do id = `sa-${Date.now().toString(36)}-${++this.counter}`;
    while (this.workers.has(id));
    return id;
  }

  private newTask(worker: WorkerRecord, brief: string) {
    const task: WorkerTask = {
      id: `${worker.id}-t${worker.tasks.length + 1}`,
      brief,
      status: "starting",
      startedAt: Date.now(),
    };
    worker.tasks.push(task);
    worker.currentTaskId = task.id;
    worker.updatedAt = Date.now();
    worker.unavailableReason = undefined;
    return task;
  }

  private reserve(task: WorkerTask) {
    if (this.reservations.size >= this.options.getConfig().maxActive) {
      const active = [...this.workers.values()].flatMap((worker) => {
        const current = taskOf(worker);
        return current && this.reservations.has(current.id)
          ? [`${worker.id}: ${current.status}`]
          : [];
      });
      throw new Error(
        `Active worker limit reached (${this.reservations.size}/${this.options.getConfig().maxActive}). ${active.join("; ")}. Wait for a worker to stop.`,
      );
    }
    this.reservations.add(task.id);
  }

  private finalize(
    worker: WorkerRecord,
    task: WorkerTask,
    outcome: { result?: string; error?: string; interrupted?: boolean },
  ) {
    if (isStoppedStatus(task.status)) return;
    task.settledAt = Date.now();
    const reportStops =
      task.report?.kind === "question" || task.report?.kind === "blocked";
    const result = reportStops ? "" : (outcome.result ?? "");
    task.result = boundedText(result);
    task.resultTruncated = result.length > RESULT_MAX_CHARS;
    if (task.report?.kind === "question") task.status = "question";
    else if (task.report?.kind === "blocked") task.status = "blocked";
    else if (outcome.interrupted || task.status === "stopping")
      task.status = "interrupted";
    else if (outcome.error) task.status = "failed";
    else task.status = "completed";
    task.error =
      reportStops || !outcome.error ? undefined : errorText(outcome.error);
    worker.updatedAt = Date.now();
    this.reservations.delete(task.id);
    this.changed();
    if (!this.disposed) this.options.onSettled(copyResult(worker, task));
  }

  private callbacks(worker: WorkerRecord) {
    return {
      onPresentation: () => {
        if (!this.disposed) this.notify(true);
      },
      onStarted: () => {
        const task = taskOf(worker);
        if (!task) return;
        if (task.status !== "starting") return;
        task.status = "working";
        worker.updatedAt = Date.now();
        this.changed();
      },
      onReport: (kind: "fyi" | "question" | "blocked", message: string) => {
        const task = taskOf(worker);
        if (!task) return;
        if (!isActiveStatus(task.status)) return;
        if (task.report?.kind === "question" || task.report?.kind === "blocked")
          return;
        task.report = {
          kind,
          message: boundedText(message, REPORT_MAX_CHARS),
          at: Date.now(),
        };
        worker.updatedAt = Date.now();
        this.changed();
        if (kind === "fyi" && !this.disposed)
          this.options.onFyi(copyResult(worker, task));
      },
      onCleanupError: (message: string) => {
        const task = taskOf(worker);
        if (!task || !isActiveStatus(task.status)) return;
        const cleanupError = errorText(message);
        const isNewFailure = task.error !== cleanupError;
        task.error = cleanupError;
        task.status = "stopping";
        worker.updatedAt = Date.now();
        this.changed();
        if (isNewFailure && !this.disposed)
          this.options.onSettled(copyResult(worker, task));
      },
      onSettled: (outcome: {
        result: string;
        error?: string;
        interrupted?: boolean;
      }) => {
        const task = taskOf(worker);
        if (!task) return;
        this.finalize(worker, task, outcome);
      },
    };
  }

  private begin(worker: WorkerRecord, task: WorkerTask) {
    let resolveLaunch!: () => void;
    let rejectLaunch!: (reason?: unknown) => void;
    const launch = new Promise<void>((resolve, reject) => {
      resolveLaunch = resolve;
      rejectLaunch = reject;
    });
    this.launches.set(worker.id, launch);
    const operation = (async () => {
      try {
        let session = this.sessions.get(worker.id);
        if (!session) {
          session = await this.options.factory.create(
            worker,
            this.callbacks(worker),
          );
          if (this.disposed || task.status === "stopping") {
            await session.close();
            this.finalize(worker, task, { interrupted: true });
            return;
          }
          this.sessions.set(worker.id, session);
          worker.sessionFile = session.sessionFile;
          this.changed();
        }
        if (this.disposed || task.status === "stopping") {
          await session.close();
          this.sessions.delete(worker.id);
          this.finalize(worker, task, { interrupted: true });
          return;
        }
        session.start(task.brief);
      } catch (error) {
        const message = errorText(error);
        if (this.disposed || task.status === "stopping") {
          this.finalize(worker, task, { error: message, interrupted: true });
          throw error;
        }
        this.finalize(worker, task, { error: message });
      } finally {
        this.launches.delete(worker.id);
      }
    })();
    void operation.then(resolveLaunch, rejectLaunch);
    // A timed-out interrupt/dispose may stop waiting before a late startup
    // rejection arrives. Keep that rejection observed and surface teardown
    // failures through the manager callback as well.
    void launch.catch((error: unknown) => {
      if (this.disposed || task.status === "stopping") {
        this.reportCleanupFailure(
          `${worker.id} startup cleanup failed: ${errorText(error)}`,
        );
      }
    });
  }

  spawn(input: {
    name: string;
    brief: string;
    cwd: string;
    model: string;
    reasoning: WorkerRecord["reasoning"];
  }) {
    if (this.disposed) throw new Error("Subagent manager is shutting down.");
    const now = Date.now();
    const worker: WorkerRecord = {
      id: this.nextWorkerId(),
      name: input.name,
      cwd: input.cwd,
      model: input.model,
      reasoning: input.reasoning,
      createdAt: now,
      updatedAt: now,
      takenOver: false,
      tasks: [],
    };
    this.options.validateSelection?.(worker);
    const task = this.newTask(worker, input.brief);
    this.reserve(task);
    this.workers.set(worker.id, worker);
    this.changed();
    this.begin(worker, task);
    return cloneWorker(worker);
  }

  private assertParentControl(worker: WorkerRecord) {
    if (worker.takenOver)
      throw new Error(
        `Worker "${worker.id}" is under exclusive human takeover.`,
      );
  }

  private followupInternal(
    worker: WorkerRecord,
    brief: string,
    human: boolean,
  ) {
    if (this.disposed) throw new Error("Subagent manager is shutting down.");
    if (!human) this.assertParentControl(worker);
    if (worker.unavailableReason) throw new Error(worker.unavailableReason);
    this.options.validateSelection?.(worker);
    const current = taskOf(worker);
    if (current && isActiveStatus(current.status))
      throw new Error(`Worker "${worker.id}" is busy.`);
    const previousUpdatedAt = worker.updatedAt;
    const task = this.newTask(worker, brief);
    try {
      this.reserve(task);
    } catch (error) {
      worker.tasks.pop();
      worker.currentTaskId = current?.id;
      worker.updatedAt = previousUpdatedAt;
      throw error;
    }
    this.changed();
    this.begin(worker, task);
    return copyResult(worker, task);
  }

  followup(id: string, brief: string) {
    return this.followupInternal(this.require(id), brief, false);
  }

  async steer(id: string, message: string, human = false) {
    const worker = this.require(id);
    if (!human) this.assertParentControl(worker);
    const task = taskOf(worker);
    if (!task || task.status !== "working")
      throw new Error(`Worker "${id}" is not actively working.`);
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Worker "${id}" is still starting.`);
    await session.steer(message);
  }

  async interrupt(id: string, human = false) {
    const worker = this.require(id);
    if (!human) this.assertParentControl(worker);
    const task = taskOf(worker);
    if (!task) throw new Error(`Worker "${id}" has no task.`);
    if (!isActiveStatus(task.status)) return copyResult(worker, task);
    task.status = "stopping";
    worker.updatedAt = Date.now();
    this.changed();
    const session = this.sessions.get(id);
    if (session) {
      await waitWithTimeout(
        session.interrupt(),
        STOP_TIMEOUT_MS,
        `Worker "${id}" cleanup timed out after ${STOP_TIMEOUT_MS}ms.`,
      );
    }
    const launch = this.launches.get(id);
    if (launch) {
      await waitWithTimeout(
        launch,
        STOP_TIMEOUT_MS,
        `Worker "${id}" did not stop within ${STOP_TIMEOUT_MS}ms.`,
      );
    }
    if (isActiveStatus(task.status) && !session) {
      throw new Error(`Worker "${id}" is still stopping.`);
    }
    if (isActiveStatus(task.status))
      this.finalize(worker, task, { interrupted: true });
    return copyResult(worker, task);
  }

  async wait(
    ids: readonly string[],
    mode: WaitMode,
    signal?: AbortSignal,
  ): Promise<TaskResult[]> {
    const refs = [...new Set(ids)].map((id) => {
      const worker = this.require(id);
      const task = taskOf(worker);
      if (!task) throw new Error(`Worker "${id}" has no task.`);
      return { workerId: id, taskId: task.id };
    });
    const read = () =>
      refs.map(({ workerId, taskId }) => {
        const worker = this.require(workerId);
        const task = taskOf(worker, taskId);
        if (!task) throw new Error(`Task "${taskId}" is unavailable.`);
        return copyResult(worker, task);
      });
    const ready = () => {
      const results = read();
      const cleanupFailures = results.filter(
        ({ task }) => task.status === "stopping" && Boolean(task.error),
      );
      if (cleanupFailures.length > 0) return cleanupFailures;
      const stopped = results.filter(({ task }) =>
        isStoppedStatus(task.status),
      );
      const urgent = stopped.filter(({ task }) => task.status !== "completed");
      if (urgent.length > 0) return urgent;
      if (mode === "any" && stopped.length > 0) return stopped;
      if (mode === "all" && stopped.length === results.length) return results;
      return undefined;
    };
    const immediate = ready();
    if (immediate) return immediate;
    return await new Promise<TaskResult[]>((resolve, reject) => {
      const cleanup = () => {
        this.waitListeners.delete(onChange);
        signal?.removeEventListener("abort", onAbort);
      };
      const onChange = () => {
        try {
          const result = ready();
          if (!result) return;
          cleanup();
          resolve(result);
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const onAbort = () => {
        cleanup();
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error("Wait cancelled. Workers keep running."),
        );
      };
      this.waitListeners.add(onChange);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  beginTakeover(id: string) {
    const worker = this.require(id);
    if (worker.takenOver)
      throw new Error(`Worker "${id}" is already under takeover.`);
    worker.takenOver = true;
    worker.updatedAt = Date.now();
    this.changed();
  }

  endTakeover(id: string) {
    const worker = this.workers.get(id);
    if (!worker || !worker.takenOver) return;
    worker.takenOver = false;
    worker.updatedAt = Date.now();
    this.changed();
  }

  humanSend(id: string, message: string) {
    const worker = this.require(id);
    if (!worker.takenOver)
      throw new Error(`Worker "${id}" is not under human takeover.`);
    const task = taskOf(worker);
    if (task && isActiveStatus(task.status))
      return this.steer(id, message, true);
    this.followupInternal(worker, message, true);
    return Promise.resolve();
  }

  transcript(id: string): SessionTranscriptItem[] {
    const worker = this.require(id);
    return (
      this.sessions.get(id)?.transcript() ??
      this.options.factory.readTranscript(worker)
    );
  }

  /** Display-only snapshots are never persisted or used to settle a task. */
  presentation(id: string): WorkerPresentation {
    const worker = this.require(id);
    if (worker.unavailableReason)
      return { transcript: [], activity: worker.unavailableReason };
    try {
      return (
        this.sessions.get(id)?.presentation?.() ?? {
          transcript: this.transcript(id),
        }
      );
    } catch (error) {
      return {
        transcript: [],
        activity: `Transcript unavailable: ${errorText(error)}`,
      };
    }
  }

  get(id: string) {
    const worker = this.workers.get(id);
    return worker ? cloneWorker(worker) : undefined;
  }

  require(id: string) {
    const worker = this.workers.get(id);
    if (!worker) throw new Error(`Unknown worker "${id}".`);
    return worker;
  }

  list() {
    return [...this.workers.values()].map(cloneWorker);
  }

  activeCount() {
    return this.reservations.size;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<string[]> {
    if (this.disposed) return [];
    this.disposed = true;
    const failures: string[] = [];
    for (const worker of this.workers.values()) {
      worker.takenOver = false;
      const task = taskOf(worker);
      if (task && isActiveStatus(task.status)) task.status = "stopping";
    }
    this.changed();
    await Promise.all(
      [...this.sessions.entries()].map(async ([id, session]) => {
        try {
          await waitWithTimeout(
            session.close(),
            STOP_TIMEOUT_MS,
            `Cleanup timed out for ${id}.`,
          );
        } catch (error) {
          failures.push(`${id}: ${errorText(error)}`);
        }
      }),
    );
    this.sessions.clear();
    await Promise.all(
      [...this.launches.entries()].map(async ([id, launch]) => {
        try {
          await waitWithTimeout(
            launch,
            STOP_TIMEOUT_MS,
            `Startup cleanup timed out for ${id}.`,
          );
        } catch (error) {
          failures.push(`${id}: ${errorText(error)}`);
        }
      }),
    );
    for (const worker of this.workers.values()) {
      const task = taskOf(worker);
      if (task && isActiveStatus(task.status))
        this.finalize(worker, task, { interrupted: true });
    }
    this.changed();
    return failures;
  }
}
