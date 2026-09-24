import {
  isActiveStatus,
  type SessionTranscriptItem,
  type WorkerRecord,
  type WorkerTask,
} from "./types.ts";

const DEFAULT_RESULT_CHARS = 12_000;
const BATCH_RESULT_CHARS = 48_000;
const REPORT_EXCERPT_CHARS = 4_096;
const ERROR_EXCERPT_CHARS = 4_096;

export function sanitizeTerminalText(text: string) {
  return text
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-_]/g, "")
    .replace(/\t/g, " ")
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

export function currentTask(worker: WorkerRecord) {
  return worker.tasks.find((task) => task.id === worker.currentTaskId);
}

export function workerStatus(worker: WorkerRecord) {
  if (worker.unavailableReason) return "unavailable";
  const task = currentTask(worker);
  const status = task?.status ?? "idle";
  return worker.takenOver ? `${status}, takeover` : status;
}

export function describeWorker(worker: WorkerRecord) {
  const task = currentTask(worker);
  const active = task && isActiveStatus(task.status) ? "active" : "idle";
  const unavailable = worker.unavailableReason
    ? `\nUnavailable: ${sanitizeTerminalText(worker.unavailableReason).slice(0, 4_096)}`
    : "";
  return `${worker.id} [${workerStatus(worker)}; ${active}] "${sanitizeTerminalText(worker.name)}" — ${sanitizeTerminalText(worker.model)} · ${worker.reasoning} · ${sanitizeTerminalText(worker.cwd)}${unavailable}`;
}

export function formatTaskResult(
  worker: WorkerRecord,
  task: WorkerTask,
  maxChars = DEFAULT_RESULT_CHARS,
  { includeHeading = true }: { includeHeading?: boolean } = {},
) {
  const safeLimit = Math.max(1, Math.floor(maxChars));
  const sessionRef = sanitizeTerminalText(worker.sessionFile ?? "unavailable");
  const heading = includeHeading
    ? `${worker.id} task ${task.id} [${task.status}] "${sanitizeTerminalText(worker.name)}"`
    : "";
  const report = task.report
    ? `\n${task.report.kind}: ${sanitizeTerminalText(task.report.message).slice(0, REPORT_EXCERPT_CHARS)}`
    : "";
  const error = task.error
    ? `\nError: ${sanitizeTerminalText(task.error).slice(0, ERROR_EXCERPT_CHARS)}`
    : "";
  const output = sanitizeTerminalText(
    task.result?.trim() || "(no final output)",
  );
  const outputNotice = task.resultTruncated
    ? `\n\n[Worker output capped. Full transcript: ${sessionRef}]`
    : "";
  const full = `${heading}${report}${error}\n\n${output}${outputNotice}`;
  if (full.length <= safeLimit) return full;

  const marker = `\n\n[Excerpt truncated. Full transcript: ${sessionRef}]`;
  if (safeLimit <= marker.length) return marker.slice(-safeLimit);
  return `${full.slice(0, safeLimit - marker.length)}${marker}`;
}

export function formatTaskResults(
  results: readonly { worker: WorkerRecord; task: WorkerTask }[],
  maxChars = BATCH_RESULT_CHARS,
) {
  const safeLimit = Math.max(1, Math.floor(maxChars));
  const sections = results.map(({ worker, task }) =>
    formatTaskResult(worker, task, DEFAULT_RESULT_CHARS),
  );
  const full = sections.join("\n\n---\n\n");
  if (full.length <= safeLimit) return full;
  const refs = results
    .map(
      ({ worker, task }) =>
        `${worker.id} ${task.id}: ${sanitizeTerminalText(worker.sessionFile ?? "unavailable")}`,
    )
    .join("\n");
  const marker = `\n\n[Combined output truncated. Full worker transcripts:\n${refs}]`;
  if (safeLimit <= marker.length) return marker.slice(-safeLimit);
  return `${full.slice(0, safeLimit - marker.length)}${marker}`;
}

/**
 * Automatic-notification formatting.
 *
 * Unlike `formatTaskResult*`, these entries are written for concise push
 * notifications rather than explicit inspection: one bounded entry per task,
 * attention states first, with an exact `subagent_list` follow-up hint. The
 * result text is always labelled as an excerpt; nothing here summarizes the
 * worker's output and no model call is involved.
 */
export const NOTIFICATION_ENTRY_CHARS = 600;
export const NOTIFICATION_ATTENTION_CHARS = 1_200;
export const NOTIFICATION_FYI_CHARS = 800;
export const NOTIFICATION_BATCH_CHARS = 12_000;

const NOTIFICATION_NAME_CHARS = 48;
const NOTIFICATION_REPORT_EXCERPT_CHARS = 600;
const NOTIFICATION_ERROR_EXCERPT_CHARS = 600;
const NOTIFICATION_RESULT_EXCERPT_CHARS = 400;
const NOTIFICATION_FYI_EXCERPT_CHARS = 600;

const NOTIFICATION_SEPARATOR = "\n\n";

type NotificationOutcome =
  | "question"
  | "blocked"
  | "failed"
  | "interrupted"
  | "unknown"
  | "active"
  | "completed";

function singleLine(text: string) {
  return sanitizeTerminalText(text).replace(/\s+/g, " ").trim();
}

function boundedLine(text: string, maxChars: number) {
  const line = singleLine(text);
  if (line.length <= maxChars) return line;
  return `${line.slice(0, Math.max(0, maxChars - 1))}…`;
}

function notificationOutcome(task: WorkerTask): NotificationOutcome {
  if (task.report?.kind === "question" || task.status === "question")
    return "question";
  if (task.report?.kind === "blocked" || task.status === "blocked")
    return "blocked";
  if (task.error || task.status === "failed") return "failed";
  if (task.status === "interrupted") return "interrupted";
  if (task.status === "unknown") return "unknown";
  if (
    task.status === "starting" ||
    task.status === "working" ||
    task.status === "stopping"
  )
    return "active";
  return "completed";
}

function notificationPriorityRank(task: WorkerTask) {
  switch (notificationOutcome(task)) {
    case "question":
      return 0;
    case "blocked":
      return 1;
    case "failed":
      return 2;
    case "interrupted":
      return 3;
    case "unknown":
      return 4;
    case "active":
      return 5;
    default:
      return 6;
  }
}

function notificationCap(task: WorkerTask) {
  return notificationOutcome(task) === "completed"
    ? NOTIFICATION_ENTRY_CHARS
    : NOTIFICATION_ATTENTION_CHARS;
}

function notificationIdentity(worker: WorkerRecord, task: WorkerTask) {
  const id = boundedLine(worker.id, NOTIFICATION_NAME_CHARS);
  const name = boundedLine(worker.name, NOTIFICATION_NAME_CHARS);
  const taskId = boundedLine(task.id, NOTIFICATION_NAME_CHARS);
  return `[${id}] "${name}" task ${taskId} [${task.status}]`;
}

function notificationInspect(worker: WorkerRecord, task: WorkerTask) {
  // Exact ids via JSON.stringify: no truncation, and quotes/newlines in a
  // restored or unusual id cannot break the hint syntax.
  return `Inspect: subagent_list { id: ${JSON.stringify(worker.id)}, task_id: ${JSON.stringify(task.id)} }`;
}

function notificationReportBlock(task: WorkerTask) {
  const report = task.report;
  // FYI reports are rendered by formatFyiNotification. Never repeat a stored
  // FYI here, where it could read as attention content.
  if (!report || report.kind === "fyi") return "";
  const label = report.kind === "question" ? "Question" : "Blocked";
  return `${label}: ${boundedLine(report.message, NOTIFICATION_REPORT_EXCERPT_CHARS)}`;
}

function notificationErrorBlock(task: WorkerTask) {
  if (!task.error) return "";
  return `Error: ${boundedLine(task.error, NOTIFICATION_ERROR_EXCERPT_CHARS)}`;
}

function notificationStatusBlock(task: WorkerTask) {
  if (notificationReportBlock(task) || task.error) return "";
  switch (task.status) {
    case "question":
      return "Question: worker requested input.";
    case "blocked":
      return "Blocked: worker reported a blocker.";
    case "failed":
      return "Error: task failed without an error message.";
    case "interrupted":
      return "Interrupted: task stopped before completing.";
    case "unknown":
      return "Unknown: task state is unknown; inspect before acting.";
    case "stopping":
      return "Stopping: worker is shutting down.";
    case "starting":
    case "working":
      return "Active: worker is still running.";
    default:
      return "";
  }
}

function notificationResultBlock(task: WorkerTask) {
  const text = singleLine(task.result ?? "");
  const outcome = notificationOutcome(task);
  if (!text && (outcome === "question" || outcome === "blocked")) return "";
  const body = text || "(no final output)";
  const capped =
    body.length > NOTIFICATION_RESULT_EXCERPT_CHARS
      ? `${body.slice(0, NOTIFICATION_RESULT_EXCERPT_CHARS - 1)}…`
      : body;
  const note = task.resultTruncated
    ? " [worker output capped; full text via subagent_list]"
    : "";
  return `Result excerpt: ${capped}${note}`;
}

function notificationAction(task: WorkerTask) {
  switch (notificationOutcome(task)) {
    case "question":
      return "Action: Review the question.";
    case "blocked":
      return "Action: Review the blocker.";
    case "failed":
      return "Action: Review the error.";
    case "interrupted":
      return "Action: Review the partial output.";
    case "unknown":
      return "Action: Inspect the unknown state before acting.";
    case "active":
      return "Action: None required — worker is still running.";
    default:
      return "Action: None required — result excerpt available for review.";
  }
}

function notificationFyiBlock(task: WorkerTask) {
  const report = task.report;
  if (!report || report.kind !== "fyi")
    return "FYI/progress: (no message provided)";
  return `FYI/progress: ${boundedLine(report.message, NOTIFICATION_FYI_EXCERPT_CHARS)}`;
}

const NOTIFICATION_MIN_BLOCK_CHARS = 8;

function truncateBlock(block: string, maxChars: number) {
  if (block.length <= maxChars) return block;
  return `${block.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Distribute `budget` characters across optional blocks in priority order,
 * keeping the earliest blocks when the budget cannot cover all of them. Each
 * included block costs one separator plus its text.
 */
function allocateOptionalBlocks(blocks: readonly string[], budget: number) {
  if (blocks.length === 0) return [] as string[];
  if (budget <= 0) return blocks.map(() => "");
  let count = blocks.length;
  if (Math.floor(budget / count) - 1 < NOTIFICATION_MIN_BLOCK_CHARS) {
    count = Math.max(
      0,
      Math.floor(budget / (NOTIFICATION_MIN_BLOCK_CHARS + 1)),
    );
    if (count === 0) return blocks.map(() => "");
  }
  const included = blocks.slice(0, count);
  const caps = included.map(() => 0);
  const contentBudget = budget - count;
  // Water-fill: grow caps of blocks that still have unsupplied content until the
  // budget is exhausted, so `sum(min(length, cap)) <= contentBudget` always holds.
  for (let pass = 0; pass < 64; pass++) {
    let used = 0;
    const unsaturated: number[] = [];
    for (let index = 0; index < included.length; index++) {
      const length = included[index]!.length;
      const cap = caps[index]!;
      used += Math.min(length, cap);
      if (length > cap) unsaturated.push(index);
    }
    if (unsaturated.length === 0) break;
    const remaining = contentBudget - used;
    if (remaining <= 0) break;
    const add = Math.floor(remaining / unsaturated.length);
    if (add === 0) break;
    for (const index of unsaturated) caps[index] = caps[index]! + add;
  }
  const fitted = included.map((block, index) => {
    const cap = caps[index]!;
    if (cap < NOTIFICATION_MIN_BLOCK_CHARS) return "";
    return truncateBlock(block, cap);
  });
  return [...fitted, ...blocks.slice(count).map(() => "")];
}

function notificationRequired(
  worker: WorkerRecord,
  task: WorkerTask,
  mandatory: readonly string[],
) {
  return [
    notificationIdentity(worker, task),
    ...mandatory,
    notificationInspect(worker, task),
  ].join("\n");
}

/**
 * Assemble an entry with `mandatory` blocks (the action flag / FYI no-action
 * note and the inspection hint) reserved before any report/error/result excerpt
 * is allocated, so a long excerpt can never drop the action flag.
 */
function assembleNotification(
  worker: WorkerRecord,
  task: WorkerTask,
  {
    mandatory,
    beforeAction,
    afterAction,
  }: {
    mandatory: readonly string[];
    beforeAction: readonly string[];
    afterAction: readonly string[];
  },
  cap: number,
  includeHeading: boolean,
) {
  const identity = notificationIdentity(worker, task);
  const inspect = notificationInspect(worker, task);
  const reserved = [
    ...(includeHeading ? [identity] : []),
    ...mandatory,
    inspect,
  ];
  const required = reserved.join("\n");
  if (required.length >= cap) return required.slice(0, cap);

  const before = beforeAction.filter((block) => block.length > 0);
  const after = afterAction.filter((block) => block.length > 0);
  const allocated = allocateOptionalBlocks(
    [...before, ...after],
    cap - required.length,
  );
  const parts = [
    ...(includeHeading ? [identity] : []),
    ...allocated.slice(0, before.length),
    ...mandatory,
    ...allocated.slice(before.length),
    inspect,
  ].filter((part) => part.length > 0);
  const text = parts.join("\n");
  return text.length <= cap ? text : text.slice(0, cap);
}

/**
 * Shared priority used to order notification content and matching DTOs. Lower
 * values are more urgent: question, blocked, failed/error, interrupted, active,
 * then routine completion.
 */
export function notificationPriority(task: WorkerTask) {
  return notificationPriorityRank(task);
}

/**
 * Stable attention-first ordering shared by notification content and DTOs.
 * Callers can split the sorted array across batches without losing identities.
 */
export function sortTaskNotifications<T extends { task: WorkerTask }>(
  results: readonly T[],
): T[] {
  return results
    .map((result, index) => ({ result, index }))
    .sort(
      (a, b) =>
        notificationPriorityRank(a.result.task) -
          notificationPriorityRank(b.result.task) || a.index - b.index,
    )
    .map((entry) => entry.result);
}

/**
 * One bounded, single-entry notification for a settled task.
 *
 * The entry always carries a sanitized single-line worker/name/task identity and
 * an exact `subagent_list` inspection hint. Question/blocked reports and errors
 * are placed before the result excerpt so attention cases survive truncation.
 * Pass `{ includeHeading: false }` for a UI preview body that omits the
 * identity line without parsing it back out.
 */
export function formatTaskNotification(
  worker: WorkerRecord,
  task: WorkerTask,
  maxChars: number = notificationCap(task),
  { includeHeading = true }: { includeHeading?: boolean } = {},
) {
  const cap = Number.isFinite(maxChars)
    ? Math.max(1, Math.floor(maxChars))
    : notificationCap(task);
  return assembleNotification(
    worker,
    task,
    {
      mandatory: [notificationAction(task)],
      beforeAction: [
        notificationReportBlock(task),
        notificationErrorBlock(task),
        notificationStatusBlock(task),
      ],
      afterAction: [notificationResultBlock(task)],
    },
    cap,
    includeHeading,
  );
}

/**
 * Bounded FYI/progress notification. It never reuses the final result excerpt
 * as progress, never requests an action, and keeps the exact inspection hint;
 * the full report body remains available in the DTO/history.
 */
export function formatFyiNotification(
  worker: WorkerRecord,
  task: WorkerTask,
  maxChars: number = NOTIFICATION_FYI_CHARS,
) {
  const cap = Number.isFinite(maxChars)
    ? Math.max(1, Math.floor(maxChars))
    : NOTIFICATION_FYI_CHARS;
  return assembleNotification(
    worker,
    task,
    {
      mandatory: ["No action requested."],
      beforeAction: [notificationFyiBlock(task)],
      afterAction: [],
    },
    cap,
    true,
  );
}

/**
 * Bounded batch of automatic notifications. Attention states (question,
 * blocked, error/failed, interrupted, active) sort ahead of routine
 * completions with a stable relative order. Every task keeps its identity and
 * inspection hint even when excerpts must shrink to respect the cap.
 */
export function formatTaskNotifications(
  results: readonly { worker: WorkerRecord; task: WorkerTask }[],
  maxChars = NOTIFICATION_BATCH_CHARS,
) {
  const safeLimit = Number.isFinite(maxChars)
    ? Math.max(1, Math.floor(maxChars))
    : Number.POSITIVE_INFINITY;
  const ordered = sortTaskNotifications(results);
  if (ordered.length === 0) return "";

  const separator = NOTIFICATION_SEPARATOR;
  const separatorChars = separator.length * (ordered.length - 1);
  const minimal = ordered.map(
    ({ worker, task }) =>
      notificationRequired(worker, task, [notificationAction(task)]).length,
  );
  let caps: number[] = ordered.map(({ task }) => notificationCap(task));
  let entries = ordered.map(({ worker, task }, index) =>
    formatTaskNotification(worker, task, caps[index]!),
  );

  for (let attempt = 0; attempt < 32; attempt++) {
    const total = entries.join(separator).length;
    if (total <= safeLimit) break;
    const available = safeLimit - separatorChars;
    if (available <= 0) break;
    let changed = false;
    caps = caps.map((cap, index) => {
      const floor = minimal[index]!;
      if (cap <= floor) return cap;
      const scaled = Math.max(
        floor,
        Math.floor((cap * available) / Math.max(1, total - separatorChars)),
      );
      if (scaled < cap) changed = true;
      return scaled;
    });
    if (!changed) break;
    entries = ordered.map(({ worker, task }, index) =>
      formatTaskNotification(worker, task, caps[index]!),
    );
  }

  let joined = entries.join(separator);
  if (joined.length <= safeLimit) return joined;

  entries = ordered.map(({ worker, task }, index) =>
    formatTaskNotification(worker, task, minimal[index]!),
  );
  joined = entries.join(separator);
  if (joined.length <= safeLimit) return joined;

  // Pathological cap: keep as many identity+hint entries as fit and state how
  // many were omitted rather than silently dropping them.
  const kept: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const cost = (kept.length > 0 ? separator.length : 0) + entry.length;
    if (used + cost > safeLimit) break;
    kept.push(entry);
    used += cost;
  }
  const omitted = entries.length - kept.length;
  const marker = `[... ${omitted} more task notification(s) omitted; inspect with subagent_list.]`;
  const body =
    kept.length > 0 ? `${kept.join(separator)}${separator}${marker}` : marker;
  return body.length <= safeLimit ? body : body.slice(0, safeLimit);
}

export function formatTranscript(
  items: readonly SessionTranscriptItem[],
  maxChars = 64_000,
) {
  const text = items
    .map((item) => `## ${item.role}\n\n${sanitizeTerminalText(item.text)}`)
    .join("\n\n---\n\n");
  const limit = Number.isFinite(maxChars)
    ? Math.max(1, Math.floor(maxChars))
    : Number.POSITIVE_INFINITY;
  if (text.length <= limit) return text || "(empty transcript)";
  const marker = "\n\n[Earlier transcript content omitted.]";
  if (limit <= marker.length) return marker.slice(-limit);
  return `${text.slice(-(limit - marker.length))}${marker}`;
}
