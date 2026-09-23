import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTaskResult,
  formatTaskResults,
  formatTranscript,
  sanitizeTerminalText,
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
