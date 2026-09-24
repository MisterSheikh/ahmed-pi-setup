import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTIFICATION_ATTENTION_CHARS,
  NOTIFICATION_BATCH_CHARS,
  NOTIFICATION_ENTRY_CHARS,
  NOTIFICATION_FYI_CHARS,
  formatFyiNotification,
  formatTaskNotification,
  formatTaskNotifications,
  formatTaskResult,
  formatTaskResults,
  formatTranscript,
  notificationPriority,
  sanitizeTerminalText,
  sortTaskNotifications,
} from "./src/format.ts";
import type { WorkerRecord, WorkerTask } from "./src/types.ts";

function worker(id: string): WorkerRecord {
  const task: WorkerTask = {
    id: `${id}-t1`,
    brief: "task",
    status: "completed",
    startedAt: 0,
    result: "answer",
  };
  return {
    id,
    name: id,
    cwd: "/workspace",
    model: "fake/model",
    reasoning: "low",
    createdAt: 0,
    updatedAt: 0,
    sessionFile: `/private/${id}.jsonl`,
    takenOver: false,
    currentTaskId: task.id,
    tasks: [task],
  };
}

test("transcript and result formatting strip terminal controls", () => {
  assert.equal(sanitizeTerminalText("ok\u001b[31mBAD\u001b[0m\u0007"), "okBAD");
  assert.equal(sanitizeTerminalText("tab\treturn\r\u009b"), "tab return");
  assert.equal(
    formatTranscript(
      [{ role: "tool", text: "\u001b]0;title\u0007safe" }],
      Infinity,
    ),
    "## tool\n\nsafe",
  );
  const item = worker("one");
  item.tasks[0]!.report = {
    kind: "question",
    message: "look \u001b[2J here",
    at: 1,
  };
  assert.match(formatTaskResult(item, item.tasks[0]!), /look  here/);
  assert.doesNotMatch(formatTaskResult(item, item.tasks[0]!), /\u001b/);
});

test("result excerpts stay bounded and reference the complete worker transcript", () => {
  const item = worker("large");
  item.tasks[0]!.result = "x".repeat(20_000);
  const excerpt = formatTaskResult(item, item.tasks[0]!, 1_000);
  assert.ok(excerpt.length <= 1_000);
  assert.match(excerpt, /Full transcript: \/private\/large\.jsonl/);

  const batch = [worker("one"), worker("two")].map((entry) => ({
    worker: entry,
    task: entry.tasks[0]!,
  }));
  for (const result of batch) result.task.result = "y".repeat(12_000);
  const combined = formatTaskResults(batch, 2_000);
  assert.ok(combined.length <= 2_000);
  assert.match(combined, /Full worker transcripts/);

  const transcript = formatTranscript(
    [{ role: "assistant", text: "z".repeat(100) }],
    64,
  );
  assert.ok(transcript.length <= 64);
  assert.match(transcript, /Earlier transcript content omitted/);
});

function taskWorker(
  id: string,
  overrides: Partial<WorkerTask> = {},
  workerOverrides: Partial<WorkerRecord> = {},
): { worker: WorkerRecord; task: WorkerTask } {
  const task: WorkerTask = {
    id: `${id}-t1`,
    brief: "brief",
    status: "completed",
    startedAt: 0,
    result: "answer",
    ...overrides,
  };
  const worker: WorkerRecord = {
    id,
    name: id,
    cwd: "/workspace",
    model: "fake/model",
    reasoning: "low",
    createdAt: 0,
    updatedAt: 0,
    sessionFile: `/private/${id}.jsonl`,
    takenOver: false,
    currentTaskId: task.id,
    tasks: [task],
    ...workerOverrides,
  };
  return { worker, task };
}

test("notification entries keep a single-line identity and label the result as an excerpt", () => {
  const { worker, task } = taskWorker(
    "sa-note",
    { result: "done" },
    { name: "  my\u001b[31m worker\u001b[0m\nname  " },
  );
  const entry = formatTaskNotification(worker, task);
  const firstLine = entry.split("\n")[0]!;
  assert.equal(
    firstLine,
    `[sa-note] "my worker name" task sa-note-t1 [completed]`,
  );
  assert.doesNotMatch(entry, /\u001b/);
  assert.match(entry, /Action: None required/);
  assert.match(entry, /Result excerpt: done/);
  assert.match(
    entry,
    /Inspect: subagent_list \{ id: "sa-note", task_id: "sa-note-t1" \}/,
  );
  assert.ok(entry.length <= NOTIFICATION_ENTRY_CHARS);
});

test("normal completion entries stay near the 600-char cap", () => {
  const { worker, task } = taskWorker("sa-long", {
    result: "x".repeat(5_000),
  });
  const entry = formatTaskNotification(worker, task);
  assert.ok(
    entry.length <= NOTIFICATION_ENTRY_CHARS,
    `entry too long: ${entry.length}`,
  );
  assert.ok(
    entry.length > 500,
    `entry should use most of the routine budget: ${entry.length}`,
  );
  assert.match(entry, /Result excerpt: x+…/);
  assert.match(entry, /Inspect:/);
});

test("attention entries place the question/blocked report or error before the result excerpt", () => {
  const question = taskWorker("sa-q", {
    status: "question",
    result: "SHOULD_NOT_LEAD",
    report: {
      kind: "question",
      message: "Which environment should I use?",
      at: 1,
    },
  });
  const questionEntry = formatTaskNotification(question.worker, question.task);
  assert.ok(questionEntry.length <= NOTIFICATION_ATTENTION_CHARS);
  assert.match(questionEntry, /Question: Which environment should I use\?/);
  assert.ok(
    questionEntry.indexOf("Question:") <
      questionEntry.indexOf("Result excerpt:"),
    "the question must precede the result excerpt",
  );
  assert.match(questionEntry, /Action: Review the question/);

  const failed = taskWorker("sa-f", {
    status: "failed",
    result: "partial output",
    error: "boom\u001b[0m\nfailed",
  });
  const failedEntry = formatTaskNotification(failed.worker, failed.task);
  assert.ok(failedEntry.length <= NOTIFICATION_ATTENTION_CHARS);
  assert.match(failedEntry, /Error: boom failed/);
  assert.ok(
    failedEntry.indexOf("Error:") < failedEntry.indexOf("Result excerpt:"),
    "the error must precede the result excerpt",
  );
  assert.match(failedEntry, /Action: Review the error/);

  const bigQuestion = taskWorker("sa-bigq", {
    status: "question",
    report: { kind: "question", message: "Q".repeat(900), at: 1 },
  });
  const bigEntry = formatTaskNotification(bigQuestion.worker, bigQuestion.task);
  assert.ok(bigEntry.length <= NOTIFICATION_ATTENTION_CHARS);
  assert.ok(
    bigEntry.length > NOTIFICATION_ENTRY_CHARS,
    "attention entries may exceed the routine cap to preserve the question",
  );
  assert.match(bigEntry, /Question: Q{500,}/);
});

test("a stored FYI report is neither repeated nor treated as a blocker", () => {
  const { worker, task } = taskWorker("sa-fyi", {
    status: "completed",
    result: "FINAL_ANSWER",
    report: { kind: "fyi", message: "STALE_FYI_MARKER halfway", at: 1 },
  });
  const entry = formatTaskNotification(worker, task);
  assert.doesNotMatch(entry, /STALE_FYI_MARKER/);
  assert.doesNotMatch(entry, /Blocked:/);
  assert.match(entry, /Result excerpt: FINAL_ANSWER/);
  assert.match(entry, /Action: None required/);
  assert.ok(entry.length <= NOTIFICATION_ENTRY_CHARS);
});

test("notification metadata is sanitized to one line", () => {
  const { worker, task } = taskWorker(
    "sa-meta",
    {
      status: "blocked",
      report: {
        kind: "blocked",
        message: "waiting\tfor\r\napproval\u001b[2J",
        at: 1,
      },
    },
    { name: "meta\u001b[0m\nworker" },
  );
  const entry = formatTaskNotification(worker, task);
  assert.match(entry, /Blocked: waiting for approval/);
  assert.doesNotMatch(entry, /\u001b/);
  assert.doesNotMatch(entry, /\r/);
  assert.doesNotMatch(entry, /\t/);
});

test("per-task and batch caps are always respected", () => {
  const tiny = taskWorker("sa-tiny", { result: "z".repeat(100) });
  assert.ok(
    formatTaskNotification(tiny.worker, tiny.task, 40).length <= 40,
    "a caller-supplied per-task cap must be honored",
  );

  const batch = Array.from({ length: 8 }, (_, index) =>
    taskWorker(`sa-small-${index}`, { result: "z".repeat(1_000) }),
  );
  const text = formatTaskNotifications(batch, 700);
  assert.ok(text.length <= 700, `batch too long: ${text.length}`);
});

test("batches sort attention ahead of routine completions and stay bounded", () => {
  const routine = taskWorker("sa-routine", { result: "r".repeat(2_000) });
  const failed = taskWorker("sa-failed", {
    status: "failed",
    error: "E".repeat(2_000),
  });
  const question = taskWorker("sa-question", {
    status: "question",
    result: "",
    report: { kind: "question", message: "Q?".repeat(400), at: 1 },
  });
  const text = formatTaskNotifications([routine, failed, question]);
  assert.ok(text.length <= NOTIFICATION_BATCH_CHARS);
  assert.ok(
    text.indexOf("sa-question") < text.indexOf("sa-failed"),
    "questions sort ahead of failures",
  );
  assert.ok(
    text.indexOf("sa-failed") < text.indexOf("sa-routine"),
    "failures sort ahead of routine completions",
  );
  assert.ok(text.indexOf("Question:") < text.indexOf("Error:"));
  assert.ok(text.indexOf("Error:") < text.indexOf("Result excerpt:"));
});

test("a 32-task batch keeps every task identity and inspection hint", () => {
  const batch = Array.from({ length: 32 }, (_, index) =>
    taskWorker(`sa-batch-${index}`, {
      result: `sa-batch-${index}-result ${"z".repeat(3_000)}`,
    }),
  );
  const text = formatTaskNotifications(batch);
  assert.ok(
    text.length <= NOTIFICATION_BATCH_CHARS,
    `batch too long: ${text.length}`,
  );
  for (const { worker, task } of batch) {
    assert.ok(text.includes(`[${worker.id}]`), `${worker.id} missing`);
    assert.ok(text.includes(`task ${task.id}`), `${task.id} label missing`);
    assert.ok(
      text.includes(`task_id: "${task.id}"`),
      `${task.id} inspection hint missing`,
    );
  }
  assert.equal((text.match(/Inspect: subagent_list/g) ?? []).length, 32);
});

test("an empty batch produces no notification text", () => {
  assert.equal(formatTaskNotifications([]), "");
});

test("FYI notifications show progress, request no action, and keep the inspection hint", () => {
  const { worker, task } = taskWorker("sa-progress", {
    status: "working",
    result: "FINAL_RESULT_SHOULD_NOT_APPEAR",
    report: { kind: "fyi", message: "halfway through the audit", at: 1 },
  });
  const entry = formatFyiNotification(worker, task);
  assert.ok(entry.length <= NOTIFICATION_FYI_CHARS);
  assert.match(entry, /FYI\/progress: halfway through the audit/);
  assert.match(entry, /No action requested\./);
  assert.doesNotMatch(entry, /Result excerpt:/);
  assert.doesNotMatch(entry, /FINAL_RESULT_SHOULD_NOT_APPEAR/);
  assert.doesNotMatch(entry, /Action:/);
  assert.match(
    entry,
    /Inspect: subagent_list \{ id: "sa-progress", task_id: "sa-progress-t1" \}/,
  );

  const long = taskWorker("sa-progress-long", {
    status: "working",
    report: { kind: "fyi", message: "p".repeat(5_000), at: 1 },
  });
  const longEntry = formatFyiNotification(long.worker, long.task);
  assert.ok(longEntry.length <= NOTIFICATION_FYI_CHARS);
  assert.match(longEntry, /FYI\/progress: p+…/);
  assert.match(longEntry, /Inspect: subagent_list/);
});

test("formatTaskNotification can omit the identity heading for UI previews", () => {
  const { worker, task } = taskWorker(
    "sa-preview",
    { result: "preview body" },
    { name: "line\nbreak name" },
  );
  const withHeading = formatTaskNotification(worker, task);
  assert.match(withHeading, /^\[sa-preview\]/);
  assert.match(withHeading, /"line break name"/);

  const preview = formatTaskNotification(
    worker,
    task,
    NOTIFICATION_ENTRY_CHARS,
    { includeHeading: false },
  );
  assert.doesNotMatch(preview, /^\[sa-preview\]/);
  assert.doesNotMatch(preview, /line break name/);
  assert.match(preview, /Action: None required/);
  assert.match(preview, /Result excerpt: preview body/);
  assert.match(
    preview,
    /Inspect: subagent_list \{ id: "sa-preview", task_id: "sa-preview-t1" \}/,
  );
  assert.ok(preview.length <= NOTIFICATION_ENTRY_CHARS);
});

test("notificationPriority and sortTaskNotifications share the content ordering", () => {
  const routine = taskWorker("sa-p-routine");
  const failed = taskWorker("sa-p-failed", {
    status: "failed",
    error: "boom",
  });
  const question = taskWorker("sa-p-question", {
    status: "question",
    report: { kind: "question", message: "Q?", at: 1 },
  });
  const fyi = taskWorker("sa-p-fyi", {
    status: "completed",
    report: { kind: "fyi", message: "stale", at: 1 },
  });
  assert.ok(
    notificationPriority(question.task) < notificationPriority(failed.task),
  );
  assert.ok(
    notificationPriority(failed.task) < notificationPriority(routine.task),
  );
  assert.equal(
    notificationPriority(fyi.task),
    notificationPriority(routine.task),
  );

  const ordered = sortTaskNotifications([routine, failed, question, fyi]);
  assert.deepEqual(
    ordered.map(({ worker }) => worker.id),
    ["sa-p-question", "sa-p-failed", "sa-p-routine", "sa-p-fyi"],
  );
  const stable = sortTaskNotifications([routine, fyi]);
  assert.deepEqual(
    stable.map(({ worker }) => worker.id),
    ["sa-p-routine", "sa-p-fyi"],
  );
});

test("explicit inspection formatters keep their established behavior", () => {
  const { worker, task } = taskWorker("sa-legacy", { result: "legacy body" });
  assert.equal(
    formatTaskResult(worker, task),
    `sa-legacy task sa-legacy-t1 [completed] "sa-legacy"\n\nlegacy body`,
  );
  assert.equal(
    formatTaskResult(worker, task, 1_000, { includeHeading: false }),
    `\n\nlegacy body`,
  );
  assert.equal(
    formatTaskResults([
      { worker, task },
      { worker, task },
    ]),
    [formatTaskResult(worker, task), formatTaskResult(worker, task)].join(
      "\n\n---\n\n",
    ),
  );
  assert.equal(
    formatTranscript([{ role: "assistant", text: "hello" }]),
    "## assistant\n\nhello",
  );
});

test("long reports and errors keep the action flag and both excerpts", () => {
  const { worker, task } = taskWorker("sa-attn-long", {
    status: "question",
    result: "tail",
    report: { kind: "question", message: "Q".repeat(5_000), at: 1 },
    error: "E".repeat(5_000),
  });
  const entry = formatTaskNotification(worker, task);
  assert.ok(
    entry.length <= NOTIFICATION_ATTENTION_CHARS,
    `entry too long: ${entry.length}`,
  );
  assert.match(entry, /Question: Q+/);
  assert.match(entry, /Error: E+/);
  assert.match(entry, /Action: Review the question\./);
  assert.match(entry, /Inspect: subagent_list/);
});

test("a long FYI excerpt cannot drop the no-action flag", () => {
  const { worker, task } = taskWorker("sa-fyi-long", {
    status: "working",
    result: "FINAL_RESULT",
    report: { kind: "fyi", message: "P".repeat(5_000), at: 1 },
  });
  const entry = formatFyiNotification(worker, task);
  assert.ok(
    entry.length <= NOTIFICATION_FYI_CHARS,
    `entry too long: ${entry.length}`,
  );
  assert.match(entry, /FYI\/progress: P+/);
  assert.match(entry, /No action requested\./);
  assert.doesNotMatch(entry, /Action:/);
  assert.doesNotMatch(entry, /FINAL_RESULT/);
  assert.match(entry, /Inspect: subagent_list/);
});

test("unknown status is attention and requires inspection", () => {
  const { worker, task } = taskWorker("sa-unknown", {
    status: "unknown",
    result: "partial",
  });
  const entry = formatTaskNotification(worker, task);
  assert.ok(entry.length <= NOTIFICATION_ATTENTION_CHARS);
  assert.match(entry, /Unknown: task state is unknown/);
  assert.match(entry, /Action: Inspect the unknown state before acting\./);
  assert.doesNotMatch(entry, /Action: None required/);
  assert.ok(
    notificationPriority(task) <
      notificationPriority(taskWorker("sa-done").task),
  );
});

test("inspection hints keep exact quoted and long ids", () => {
  const quotedId = `sa-"quoted"`;
  const quoted = taskWorker(quotedId, { result: "ok" });
  const quotedEntry = formatTaskNotification(quoted.worker, quoted.task);
  assert.ok(
    quotedEntry.includes(
      `Inspect: subagent_list { id: ${JSON.stringify(quotedId)}, task_id: ${JSON.stringify(quoted.task.id)} }`,
    ),
    "quoted ids must round-trip through the hint",
  );

  const longId = `sa-${"x".repeat(80)}`;
  const long = taskWorker(longId, { result: "ok" });
  const longEntry = formatTaskNotification(long.worker, long.task);
  assert.ok(
    longEntry.includes(
      `Inspect: subagent_list { id: ${JSON.stringify(longId)}, task_id: ${JSON.stringify(long.task.id)} }`,
    ),
    "long ids must stay exact in the hint",
  );
  assert.ok(
    longEntry.split("\n")[0]!.includes("…"),
    "the display identity may truncate independently of the exact hint",
  );
});
