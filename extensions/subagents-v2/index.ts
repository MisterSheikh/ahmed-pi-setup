import * as fs from "node:fs";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  loadConfig,
  resolveSelection,
  saveConfig,
  validateConfig,
} from "./src/config.ts";
import { createDeferredDelivery } from "./src/delivery.ts";
import {
  currentTask,
  describeWorker,
  formatTaskResult,
  formatTaskResults,
  formatTaskNotification,
  formatTaskNotifications,
  formatFyiNotification,
  sortTaskNotifications,
  formatTranscript,
  sanitizeTerminalText,
} from "./src/format.ts";
import { SubagentManager, type TaskResult } from "./src/manager.ts";
import { PiWorkerSessionFactory } from "./src/pi-session.ts";
import { makeState, restoreState, STATE_ENTRY_TYPE } from "./src/state.ts";
import {
  THINKING_LEVELS,
  isActiveStatus,
  type SubagentsConfig,
  type ThinkingLevel,
} from "./src/types.ts";
import { configureSubagents, openSubagentsMenu } from "./src/ui.ts";
import { selectionGuidance } from "./src/selection-guidance.ts";
import {
  decodeCommunicationDetails,
  decodeResultBatchDetails,
  renderCommunication,
  renderResultBatch,
  type CommunicationRecord,
  type OutgoingAction,
} from "./src/communication-ui.ts";

const TOOL_NAMES = [
  "subagent_spawn",
  "subagent_followup",
  "subagent_steer",
  "subagent_interrupt",
  "subagent_wait",
  "subagent_list",
] as const;

const CONFIG_PATH = path.join(getAgentDir(), "subagents-v2", "config.json");

interface ListDetails {
  workers: Array<{ id: string; status: string }>;
  workerId?: string;
  taskId?: string;
  status?: string;
  communications?: CommunicationRecord[];
}

function nonEmpty(value: string, label: string) {
  const result = value.trim();
  if (!result) throw new Error(`${label} cannot be empty.`);
  return result;
}

function existingDirectory(base: string, requested?: string) {
  const resolved = path.resolve(base, requested ?? ".");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Working directory does not exist: ${resolved}`);
  }
  if (!stat.isDirectory())
    throw new Error(`Working directory is not a directory: ${resolved}`);
  return resolved;
}

export default function subagentsV2(pi: ExtensionAPI) {
  let loaded = loadConfig(CONFIG_PATH);
  let config = loaded.config;
  let context: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;
  let manager: SubagentManager | undefined;
  let unsubscribeStatus: (() => void) | undefined;
  let ownerMismatch: string | undefined;
  let shuttingDown = false;
  const delivery = createDeferredDelivery();

  const reportError = (message: string) => {
    const bounded = sanitizeTerminalText(message).slice(0, 4_096);
    if (ui) ui.notify(bounded, "error");
    else console.error(`[subagents-v2] ${bounded}`);
  };

  const updateStatus = () => {
    if (!ui) return;
    if (!config.enabled) {
      ui.setStatus("subagents-v2", undefined);
      return;
    }
    const workers = manager?.list() ?? [];
    const active = manager?.activeCount() ?? 0;
    const done = workers.filter(
      (worker) => currentTask(worker)?.status === "completed",
    ).length;
    const failed = workers.filter(
      (worker) => currentTask(worker)?.status === "failed",
    ).length;
    const attention = workers.filter((worker) => {
      const status = currentTask(worker)?.status;
      return (
        status === "question" ||
        status === "blocked" ||
        Boolean(worker.unavailableReason)
      );
    }).length;
    const colour = (
      role: "warning" | "success" | "error" | "muted",
      text: string,
    ) => ui?.theme?.fg(role, text) ?? text;
    ui.setStatus(
      "subagents-v2",
      [
        `subagents ${colour("warning", `■ ${active}/${config.maxActive} active`)}`,
        ...(done ? [colour("success", `${done} done`)] : []),
        ...(failed ? [colour("error", `${failed} failed`)] : []),
        ...(attention
          ? [colour("warning", `${attention} need attention`)]
          : []),
        colour("muted", "/subagents to view"),
      ].join(" · "),
    );
  };

  const persist = (
    workers: readonly ReturnType<SubagentManager["list"]>[number][],
  ) => {
    if (!context || ownerMismatch) return;
    pi.appendEntry(
      STATE_ENTRY_TYPE,
      makeState(context.sessionManager.getSessionId(), workers),
    );
  };

  const resultRecord = (
    { worker, task }: TaskResult,
    maxChars = 12_000,
  ): CommunicationRecord => ({
    direction: "incoming",
    action:
      task.status === "question"
        ? "QUESTION"
        : task.status === "blocked"
          ? "BLOCKED"
          : task.error || task.status === "failed"
            ? "FAILED"
            : "RESULT",
    workerId: worker.id,
    name: worker.name,
    taskId: task.id,
    status: task.status,
    body: formatTaskResult(worker, task, maxChars, {
      includeHeading: false,
    }).trim(),
  });

  const withCurrentStatus = (
    record: CommunicationRecord,
  ): CommunicationRecord => {
    const worker = record.workerId ? manager?.get(record.workerId) : undefined;
    if (!worker || !record.taskId) return record;
    return {
      ...record,
      historical: worker.currentTaskId !== record.taskId,
      currentStatus: worker.unavailableReason
        ? "unavailable"
        : (currentTask(worker)?.status ?? "idle"),
    };
  };

  const acknowledgement = (
    id: string,
    body: string,
    taskId?: string,
  ): CommunicationRecord => {
    const worker = manager?.get(id);
    const task = taskId
      ? worker?.tasks.find((item) => item.id === taskId)
      : worker
        ? currentTask(worker)
        : undefined;
    return {
      direction: "system",
      action: "ACK",
      workerId: id,
      name: worker?.name,
      taskId: task?.id,
      status: task?.status,
      body,
    };
  };

  const renderParentCall = (
    action: OutgoingAction,
    ids: readonly string[],
    body: string,
    theme: Theme,
    name?: string,
  ) => {
    const records: CommunicationRecord[] = ids.length
      ? ids.map((id) => ({
          direction: "outgoing",
          action,
          workerId: id,
          name: manager?.get(id)?.name,
          body,
        }))
      : [{ direction: "outgoing", action, name, body }];
    return renderResultBatch(records, { expanded: false }, theme);
  };

  // Pi retains returned components between paints. Resolve live status during
  // render, not only when the renderer callback first constructs the component.
  const renderLiveCommunications = (
    records: CommunicationRecord[],
    options: { expanded?: boolean },
    theme: Theme,
    single = false,
  ): Component => {
    let component: Component | undefined;
    let previousStatus = "";
    return {
      render(width) {
        const current = records.map(withCurrentStatus);
        const status = JSON.stringify(
          current.map((record) => [record.historical, record.currentStatus]),
        );
        if (!component || status !== previousStatus) {
          component =
            single && current[0]
              ? renderCommunication(current[0], options, theme)
              : renderResultBatch(current, options, theme);
          previousStatus = status;
        }
        return component.render(width);
      },
      invalidate() {
        component = undefined;
      },
    };
  };

  const renderToolOutput = (
    result: {
      content: readonly { type: string; text?: string }[];
      details?: unknown;
    },
    options: { expanded: boolean; isPartial: boolean },
    theme: Theme,
    renderContext: { isError: boolean },
  ) => {
    const body = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text ?? "")
      .join("\n");
    const records = decodeResultBatchDetails(result.details);
    const single = decodeCommunicationDetails(result.details);
    if (records.length && records.some((record) => record.body))
      return renderLiveCommunications(records, options, theme);
    if (single?.body)
      return renderLiveCommunications([single], options, theme, true);
    return renderCommunication(
      {
        direction: "system",
        action: "STATUS",
        status: renderContext.isError
          ? "failed"
          : options.isPartial
            ? "waiting"
            : undefined,
        body,
      },
      options,
      theme,
    );
  };

  const flushFyi = () => {
    if (!context || shuttingDown) return;
    for (const result of delivery.drainFyi()) {
      const { worker, task } = result;
      const current = manager?.get(worker.id);
      const latest = current && currentTask(current);
      // Keep progress local until a safe delivery boundary. Once handed to Pi,
      // a queued custom message cannot be retracted by this extension.
      if (
        !latest ||
        latest.id !== task.id ||
        !isActiveStatus(latest.status) ||
        latest.report?.kind !== "fyi" ||
        latest.report.at !== task.report?.at ||
        latest.report.message !== task.report?.message
      )
        continue;
      const content = formatFyiNotification(worker, task);
      try {
        pi.sendMessage(
          {
            customType: "subagents-v2-fyi",
            content,
            display: true,
            details: {
              workerId: worker.id,
              taskId: task.id,
              communication: {
                direction: "incoming",
                action: "FYI",
                workerId: worker.id,
                name: worker.name,
                taskId: task.id,
                status: latest.status,
                body: sanitizeTerminalText(latest.report.message),
                summary: content,
              } satisfies CommunicationRecord,
            },
          },
          { triggerTurn: false },
        );
      } catch (error) {
        delivery.deferFyi(result);
        reportError(
          `Could not add worker update to the parent session: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  const flush = () => {
    if (!context || shuttingDown) return;
    // Passive updates are appended before the single result-triggered turn.
    flushFyi();
    const pending = sortTaskNotifications(delivery.drain());
    const results = pending.slice(0, 32);
    // Keep overflow pending rather than truncating away task identities. The
    // triggered parent turn supplies the next settled delivery boundary.
    for (const result of pending.slice(32)) delivery.defer(result);
    if (results.length === 0) return;
    const content = formatTaskNotifications(results);
    try {
      pi.sendMessage(
        {
          customType: "subagents-v2-results",
          content,
          display: true,
          details: {
            communications: results.map((result) => ({
              ...resultRecord(
                result,
                Math.max(1, Math.floor(48_000 / results.length)),
              ),
              summary: formatTaskNotification(
                result.worker,
                result.task,
                undefined,
                { includeHeading: false },
              ),
            })),
            results: results.map(({ worker, task }) => ({
              workerId: worker.id,
              taskId: task.id,
              status: task.status,
            })),
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      // sendMessage is fire-and-forget: handoff is not proof of inspection.
      // Only explicit inspection/wait records an acknowledged result revision.
    } catch (error) {
      for (const result of results) delivery.defer(result);
      reportError(
        `Could not deliver worker results: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const onSettled = (result: TaskResult) => {
    if (shuttingDown || !context) return;
    delivery.defer(result);
    if (context.isIdle()) flush();
  };

  const onFyi = (result: TaskResult) => {
    if (shuttingDown || !context) return;
    delivery.deferFyi(result);
    if (context.isIdle()) flushFyi();
  };

  const createManager = (
    ctx: ExtensionContext,
    restored = restoreState(ctx.sessionManager).workers,
  ) => {
    const parentId = ctx.sessionManager.getSessionId();
    const sessionRoot = path.join(
      getAgentDir(),
      "subagents-v2",
      "sessions",
      parentId,
    );
    const next = new SubagentManager({
      factory: new PiWorkerSessionFactory({
        registry: ctx.modelRegistry,
        agentDir: getAgentDir(),
        parentCwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
        sessionRoot,
      }),
      restored,
      getConfig: () => config,
      validateSelection: (worker) => {
        resolveSelection(
          config,
          ctx.modelRegistry,
          worker.model,
          worker.reasoning,
        );
      },
      persist,
      onPersistenceError: (message) =>
        reportError(`Could not persist worker state: ${message}`),
      onCleanupError: (message) =>
        reportError(`Worker cleanup failed: ${message}`),
      onSettled,
      onFyi,
    });
    unsubscribeStatus?.();
    unsubscribeStatus = next.subscribe(updateStatus);
    manager = next;
    updateStatus();
    return next;
  };

  const requireManager = () => {
    if (!context)
      throw new Error("Subagents V2 is not attached to a parent session.");
    if (ownerMismatch) {
      throw new Error(
        `This session branch contains workers owned by parent session ${ownerMismatch}. Cross-session worker control is unsupported.`,
      );
    }
    if (!config.enabled)
      throw new Error(
        "Subagent delegation is disabled. Use /subagent-config to enable it.",
      );
    return manager ?? createManager(context);
  };

  const syncActiveTools = () => {
    const active = pi
      .getActiveTools()
      .filter(
        (name) => !TOOL_NAMES.includes(name as (typeof TOOL_NAMES)[number]),
      );
    pi.setActiveTools(config.enabled ? [...active, ...TOOL_NAMES] : active);
  };

  const reportCleanupFailures = (failures: string[]) => {
    if (failures.length > 0)
      reportError(`Worker cleanup failures:\n${failures.join("\n")}`);
  };

  const applyConfig = async (next: SubagentsConfig) => {
    const wasEnabled = config.enabled;
    validateConfig(next, context?.modelRegistry);
    saveConfig(CONFIG_PATH, next);
    config = next;
    if (wasEnabled && !next.enabled && manager) {
      shuttingDown = true;
      let failures: string[];
      try {
        failures = await manager.dispose();
      } finally {
        shuttingDown = false;
      }
      // Keep the stopped roster inspectable while disabled, including the
      // branch guard. Enabling replaces this disposed manager without starting tasks.
      unsubscribeStatus?.();
      unsubscribeStatus = undefined;
      delivery.clear();
      reportCleanupFailures(failures);
    } else if (!wasEnabled && next.enabled && context && !ownerMismatch) {
      createManager(context, manager?.list());
    }
    syncActiveTools();
    updateStatus();
  };

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    ui = ctx.hasUI ? ctx.ui : undefined;
    shuttingDown = false;
    loaded = loadConfig(CONFIG_PATH, ctx.modelRegistry);
    config = loaded.config;
    try {
      validateConfig(config, ctx.modelRegistry);
    } catch (error) {
      config = { ...config, enabled: false };
      reportError(
        `Delegation remains disabled: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const restored = restoreState(ctx.sessionManager);
    ownerMismatch = restored.ownerMismatch;
    createManager(ctx, restored.workers);
    syncActiveTools();
    if (loaded.error)
      reportError(`${loaded.error}\nDelegation remains disabled.`);
    if (ownerMismatch) {
      ui?.notify(
        `Subagents V2 workers belong to parent session ${ownerMismatch}; this fork cannot control them.`,
        "warning",
      );
    }
  });

  pi.on("before_agent_start", (event, ctx) => {
    event.systemPromptOptions.sections.subagent_configuration =
      selectionGuidance(config, ctx.modelRegistry);
  });

  // Preserve useful mid-run progress without handing stale FYIs to Pi's queue:
  // Pi flushes passive messages after turn_end handlers, without continuation.
  pi.on("turn_end", flushFyi);
  pi.on("agent_settled", flush);

  const branchControlBlocked = (operation: "tree navigation" | "fork") => {
    if (!ownerMismatch && (manager?.list().length ?? 0) === 0) return false;
    ui?.notify(
      `Cannot ${operation} while Subagents V2 workers are attached to this parent session. Stop using this parent session before branching.`,
      "warning",
    );
    return true;
  };

  pi.on("session_before_tree", () =>
    branchControlBlocked("tree navigation") ? { cancel: true } : undefined,
  );

  pi.on("session_before_fork", () =>
    branchControlBlocked("fork") ? { cancel: true } : undefined,
  );

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    delivery.clear();
    const failures = await manager?.dispose();
    if (failures) reportCleanupFailures(failures);
    unsubscribeStatus?.();
    unsubscribeStatus = undefined;
    ui?.setStatus("subagents-v2", undefined);
    manager = undefined;
    context = undefined;
    ui = undefined;
    ownerMismatch = undefined;
  });

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Worker",
    description:
      "Start a Pi worker with a separate conversation in the shared workspace. Supply an ordinary text task brief with boundaries, relevant facts or file references, and expected output; parent conversation history is not copied. Returns immediately with a worker ID.",
    promptSnippet:
      "Delegate independent scoped work to an explicitly configured Pi worker.",
    promptGuidelines: [
      "Use only when delegation materially helps. The active-worker limit is a ceiling, not a target.",
      "Give each worker a self-contained brief; workers do not receive this conversation.",
      "Workers share the filesystem and normal host permissions. Use trusted directories and partition edits to avoid collisions.",
      "Never invent a model or reasoning level: omit them only when configured defaults exist.",
    ],
    parameters: Type.Object({
      name: Type.String({
        maxLength: 160,
        description: "Short worker name.",
      }),
      task: Type.String({
        maxLength: 32_000,
        description:
          "Complete task brief, boundaries, context, and expected output.",
      }),
      model: Type.Optional(
        Type.String({ description: "Allowed provider/model identifier." }),
      ),
      reasoning: Type.Optional(
        StringEnum(THINKING_LEVELS, {
          description:
            "Reasoning level allowed for the selected model. Omit only if that model has a configured default.",
        }),
      ),
      working_dir: Type.Optional(
        Type.String({
          description:
            "Worker directory, relative to the parent cwd or absolute.",
        }),
      ),
    }),
    renderCall: (params, theme) =>
      renderParentCall("TASK", [], params.task ?? "", theme, params.name),
    renderResult: renderToolOutput,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const selection = resolveSelection(
        config,
        ctx.modelRegistry,
        params.model,
        params.reasoning as ThinkingLevel | undefined,
      );
      const cwd = existingDirectory(ctx.cwd, params.working_dir);
      const worker = requireManager().spawn({
        name: nonEmpty(params.name, "Worker name").slice(0, 160),
        brief: nonEmpty(params.task, "Task brief"),
        cwd,
        model: selection.modelKey,
        reasoning: selection.reasoning,
      });
      const task = currentTask(worker)!;
      return {
        content: [
          {
            type: "text",
            text: `Started ${worker.id} "${sanitizeTerminalText(worker.name)}" as task ${task.id} with ${sanitizeTerminalText(worker.model)} (${worker.reasoning}) in ${sanitizeTerminalText(worker.cwd)}.`,
          },
        ],
        details: {
          workerId: worker.id,
          taskId: task.id,
          communication: acknowledgement(
            worker.id,
            `Started with ${worker.model} (${worker.reasoning}) in ${worker.cwd}.`,
            task.id,
          ),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_followup",
    label: "Follow Up Worker",
    description:
      "Send a new related task or an answer to an idle worker while preserving its conversation. Rejects busy workers.",
    parameters: Type.Object({
      id: Type.String({ description: "Worker ID." }),
      task: Type.String({
        maxLength: 32_000,
        description: "New related assignment, update, or answer.",
      }),
    }),
    renderCall: (params, theme) =>
      renderParentCall(
        "FOLLOW-UP",
        params.id ? [params.id] : [],
        params.task ?? "",
        theme,
      ),
    renderResult: renderToolOutput,
    async execute(_toolCallId, params) {
      const result = requireManager().followup(
        params.id,
        nonEmpty(params.task, "Follow-up"),
      );
      return {
        content: [
          {
            type: "text",
            text: `Started ${result.task.id} on ${result.worker.id}.`,
          },
        ],
        details: {
          workerId: result.worker.id,
          taskId: result.task.id,
          communication: acknowledgement(
            result.worker.id,
            "Follow-up task started.",
            result.task.id,
          ),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_steer",
    label: "Steer Worker",
    description:
      "Queue a correction into one actively working worker through Pi steering. Rejects idle workers.",
    parameters: Type.Object({
      id: Type.String({ description: "Worker ID." }),
      message: Type.String({
        maxLength: 16_000,
        description: "Correction or additional direction.",
      }),
    }),
    renderCall: (params, theme) =>
      renderParentCall(
        "STEER",
        params.id ? [params.id] : [],
        params.message ?? "",
        theme,
      ),
    renderResult: renderToolOutput,
    async execute(_toolCallId, params) {
      const taskId = manager?.get(params.id)?.currentTaskId;
      await requireManager().steer(
        params.id,
        nonEmpty(params.message, "Steering message"),
      );
      return {
        content: [{ type: "text", text: `Steering queued for ${params.id}.` }],
        details: {
          workerId: params.id,
          communication: acknowledgement(params.id, "Steering queued.", taskId),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_interrupt",
    label: "Interrupt Workers",
    description:
      "Stop selected active workers, clear queued work, and preserve their conversations.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 32,
        description: "Worker IDs to stop.",
      }),
    }),
    renderCall: (params, theme) =>
      renderParentCall(
        "INTERRUPT",
        params.ids ?? [],
        "Stop the selected worker's current task.",
        theme,
      ),
    renderResult: renderToolOutput,
    async execute(_toolCallId, params) {
      const current = requireManager();
      const results = await Promise.all(
        [...new Set(params.ids)].map(async (id) => {
          try {
            const result = await current.interrupt(id);
            delivery.consume([result]);
            return {
              workerId: id,
              taskId: result.task.id,
              status: result.task.status,
            };
          } catch (error) {
            return {
              workerId: id,
              error: sanitizeTerminalText(
                error instanceof Error ? error.message : String(error),
              ).slice(0, 4_096),
            };
          }
        }),
      );
      return {
        content: [
          {
            type: "text",
            text: results
              .map((result) =>
                "error" in result
                  ? `${result.workerId}: FAILED TO STOP — ${result.error}`
                  : `${result.workerId}: ${result.status}`,
              )
              .join("\n"),
          },
        ],
        details: {
          results,
          communications: results.map((item): CommunicationRecord => ({
            ...acknowledgement(
              item.workerId,
              "error" in item
                ? `Failed to stop: ${item.error}`
                : "Interrupt request complete.",
              "taskId" in item ? item.taskId : undefined,
            ),
            status: "error" in item ? "failed" : item.status,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Workers",
    description:
      "Suspend until any or all selected current tasks stop without repeated model calls. Questions, blockers, failures, and interruptions return early. Cancelling the tool leaves workers running.",
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 32,
        description: "Worker IDs whose current tasks are selected.",
      }),
      mode: Type.Optional(
        StringEnum(["any", "all"] as const, {
          description: "Wait for any or all; default all.",
        }),
      ),
    }),
    renderCall: (params, theme) =>
      renderParentCall(
        "WAIT",
        params.ids ?? [],
        `Wait for ${params.mode ?? "all"} selected current tasks.`,
        theme,
      ),
    renderResult: renderToolOutput,
    async execute(_toolCallId, params, signal, onUpdate) {
      const current = requireManager();
      const ids = [...new Set(params.ids)];
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Waiting (${params.mode ?? "all"}) for ${ids.join(", ")}...`,
          },
        ],
        details: { ids },
      });
      const results = await current.wait(ids, params.mode ?? "all", signal);
      delivery.consume(results);
      return {
        content: [{ type: "text", text: formatTaskResults(results) }],
        details: {
          communications: results.map((result) =>
            resultRecord(
              result,
              Math.max(1, Math.floor(48_000 / results.length)),
            ),
          ),
          results: results.map(({ worker, task }) => ({
            workerId: worker.id,
            taskId: task.id,
            status: task.status,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Workers",
    description:
      "List workers and task status, or inspect a worker's current or earlier task result and bounded transcript. Inspecting a task acknowledges that result so it is not announced again; a roster lookup does not.",
    parameters: Type.Object({
      id: Type.Optional(
        Type.String({ description: "Optional worker ID to inspect." }),
      ),
      task_id: Type.Optional(
        Type.String({
          description:
            "Optional earlier task ID to inspect; requires id. Defaults to the current task.",
        }),
      ),
      transcript: Type.Optional(
        Type.Boolean({
          description:
            "Include a bounded transcript when inspecting one worker.",
        }),
      ),
    }),
    renderCall: (params, theme) =>
      renderParentCall(
        "INSPECT",
        params.id ? [params.id] : [],
        params.task_id
          ? `Task ${params.task_id}`
          : params.transcript
            ? "Inspect transcript."
            : "Inspect workers and status.",
        theme,
      ),
    renderResult: renderToolOutput,
    async execute(_toolCallId, params) {
      const current = requireManager();
      if (!params.id) {
        if (params.task_id)
          throw new Error("Provide a worker id when inspecting a task_id.");
        const workers = current.list();
        const details: ListDetails = {
          communications: workers.map((worker) => ({
            ...acknowledgement(worker.id, describeWorker(worker)),
            action: "SNAPSHOT",
          })),
          workers: workers.map((worker) => ({
            id: worker.id,
            status: currentTask(worker)?.status ?? "idle",
          })),
        };
        return {
          content: [
            {
              type: "text",
              text: workers.length
                ? workers.map(describeWorker).join("\n")
                : "No workers.",
            },
          ],
          details,
        };
      }
      const worker = current.get(params.id);
      if (!worker) throw new Error(`Unknown worker "${params.id}".`);
      let text = describeWorker(worker);
      const task = params.task_id
        ? worker.tasks.find((candidate) => candidate.id === params.task_id)
        : currentTask(worker);
      if (params.task_id && !task)
        throw new Error(
          `Unknown task "${params.task_id}" for worker "${worker.id}".`,
        );
      if (task) text += `\n\n${formatTaskResult(worker, task, 8_000)}`;
      if (params.transcript)
        text += `\n\n# Transcript\n\n${formatTranscript(current.transcript(worker.id), 24_000)}`;
      if (worker.sessionFile)
        text += `\n\nFull Pi session: ${worker.sessionFile}`;
      const details: ListDetails = {
        communications: [
          { ...acknowledgement(worker.id, text, task?.id), action: "SNAPSHOT" },
        ],
        workers: [],
        workerId: worker.id,
        taskId: task?.id,
        status: task?.status,
      };
      // Only acknowledge after the requested result/transcript was built
      // successfully. A failed inspection must leave its notification pending.
      if (task) delivery.consume([{ worker, task }]);
      return {
        content: [{ type: "text", text }],
        details,
      };
    },
  });

  pi.registerMessageRenderer(
    "subagents-v2-results",
    (message, options, theme) => {
      const records = decodeResultBatchDetails(message.details);
      if (records.length && records.some((record) => record.body))
        return renderLiveCommunications(records, options, theme);
      return renderCommunication(
        {
          direction: "system",
          action: "SNAPSHOT",
          body: typeof message.content === "string" ? message.content : "",
        },
        options,
        theme,
      );
    },
  );

  pi.registerMessageRenderer("subagents-v2-fyi", (message, options, theme) => {
    const body = typeof message.content === "string" ? message.content : "";
    const record = decodeCommunicationDetails(message.details, body);
    return renderLiveCommunications(
      [record ?? { direction: "incoming", action: "FYI", body }],
      options,
      theme,
      true,
    );
  });

  pi.registerCommand("subagent-config", {
    description: "Configure allowed worker models, reasoning, and delegation",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if (args.trim()) {
        ctx.ui.notify("Usage: /subagent-config", "warning");
        return;
      }
      await configureSubagents(ctx, ctx.modelRegistry, config, applyConfig);
    },
  });

  pi.registerCommand("subagents", {
    description:
      "Open the live worker dashboard, inspect, or take over workers",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      if (args.trim() === "config") {
        await configureSubagents(ctx, ctx.modelRegistry, config, applyConfig);
        return;
      }
      if (args.trim()) {
        ctx.ui.notify(
          "Usage: /subagents (dashboard) or /subagent-config (configuration). /subagents config is an alias.",
          "warning",
        );
        return;
      }
      if (ownerMismatch) {
        ctx.ui.notify(
          `These workers belong to parent session ${ownerMismatch}; open that session to inspect or control them.`,
          "warning",
        );
        return;
      }
      await openSubagentsMenu({
        ctx,
        registry: ctx.modelRegistry,
        config,
        manager,
        applyConfig,
      });
    },
  });
}
