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
