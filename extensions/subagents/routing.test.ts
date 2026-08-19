import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubagentRouting } from "./src/routing.ts";

test("applies the configured defaults for each harness", () => {
  assert.deepEqual(resolveSubagentRouting("pi"), {
    model: "opencode-go/deepseek-v4-flash",
    reasoningEffort: "high",
  });
  assert.deepEqual(resolveSubagentRouting("claude"), {
    model: "claude-opus-5",
    reasoningEffort: "high",
  });
  assert.deepEqual(resolveSubagentRouting("codex"), {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
});

test("DeepSeek V4 Flash accepts only high or max reasoning", () => {
  assert.equal(
    resolveSubagentRouting("pi", "deepseek-v4-flash", "max").reasoningEffort,
    "max",
  );
  assert.throws(
    () => resolveSubagentRouting("pi", "deepseek-v4-flash", "medium"),
    /only support high or max/,
  );
});

test("other models may use other reasoning levels", () => {
  assert.equal(
    resolveSubagentRouting("codex", "gpt-5.6-sol", "low").reasoningEffort,
    "low",
  );
});
