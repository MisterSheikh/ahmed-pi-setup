import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubagentRouting } from "./src/routing.ts";

test("Pi inherits the parent model and reasoning level by default", () => {
  assert.deepEqual(resolveSubagentRouting("pi"), {
    model: undefined,
    reasoningEffort: undefined,
  });
});

test("applies the configured Claude and Codex defaults", () => {
  assert.deepEqual(resolveSubagentRouting("claude"), {
    model: "claude-opus-5",
    reasoningEffort: "high",
  });
  assert.deepEqual(resolveSubagentRouting("codex"), {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
});

test("preserves explicit Pi model and reasoning choices", () => {
  assert.deepEqual(
    resolveSubagentRouting("pi", "opencode-go/glm-5.3-flash", "max"),
    {
      model: "opencode-go/glm-5.3-flash",
      reasoningEffort: "max",
    },
  );
});

test("preserves explicit overrides for other harnesses", () => {
  assert.equal(
    resolveSubagentRouting("codex", "gpt-5.6-sol", "low").reasoningEffort,
    "low",
  );
});
