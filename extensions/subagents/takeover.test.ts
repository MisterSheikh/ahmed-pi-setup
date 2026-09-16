import assert from "node:assert/strict";
import test from "node:test";
import { formatModelAndReasoning } from "./src/format.ts";

test("model display includes native reasoning levels and marks unknown metadata", () => {
  for (const level of [
    "off",
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]) {
    assert.equal(
      formatModelAndReasoning({
        backend: "pi",
        modelLabel: "model",
        reasoningLevel: level,
      }),
      `model · reasoning: ${level}`,
    );
  }
  assert.equal(
    formatModelAndReasoning({ backend: "codex", modelLabel: "model" }),
    "model · reasoning: ?",
  );
  assert.equal(
    formatModelAndReasoning({ backend: "claude" }),
    "? · reasoning: ?",
  );
});
import {
  reconcileDashboardSelection,
  type DashboardSelection,
} from "./src/ui/takeover.ts";

test("dashboard selection follows its subagent id and falls back by row", () => {
  const selection: DashboardSelection = { id: "sa-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "sa-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `sa-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "sa-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sa-${index + 1}` })),
    { id: "sa-8" },
    { id: "sa-9" },
  ]);
  assert.deepEqual(selection, { id: "sa-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "sa-1" }, { id: "sa-2" }]);
  assert.deepEqual(selection, { id: "sa-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});
