import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { selectionGuidance } from "./src/selection-guidance.ts";
import type { SubagentsConfig } from "./src/types.ts";

const flash: Model<"openai-completions"> = {
  id: "flash",
  provider: "fake",
  name: "Flash",
  api: "openai-completions",
  baseUrl: "https://invalid.example",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10000,
  maxTokens: 1000,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  },
};
const config: SubagentsConfig = {
  version: 2,
  enabled: true,
  allowedModels: ["fake/flash", "fake/other"],
  modelReasoning: {
    "fake/flash": { allowed: ["low", "high"], default: "high" },
    "fake/other": { allowed: ["low"] },
  },
  defaultModel: "fake/flash",
  maxActive: 4,
};

test("parent instructions enumerate only available allowed pairs and per-model defaults", () => {
  const text = selectionGuidance(config, {
    getAvailable: () => [
      flash,
      { ...flash, id: "other" },
      { ...flash, id: "unselected" },
    ],
  });
  const choices: unknown = JSON.parse(text.split("\n")[1]!);
  assert.deepEqual(choices, [
    {
      model: "fake/flash",
      reasoning: ["low", "high"],
      defaultReasoning: "high",
    },
    { model: "fake/other", reasoning: ["low"] },
  ]);
  assert.match(text, /parent agent, choose/);
  assert.match(text, /Default model: "fake\/flash"/);
  assert.match(text, /supply reasoning explicitly/);
});

test("parent instructions do not advertise unavailable models or newly unsupported reasoning", () => {
  const text = selectionGuidance(config, {
    getAvailable: () => [
      { ...flash, thinkingLevelMap: { ...flash.thinkingLevelMap, high: null } },
    ],
  });
  assert.deepEqual(JSON.parse(text.split("\n")[1]!), [
    { model: "fake/flash", reasoning: ["low"] },
  ]);
  const unavailable = selectionGuidance(config, { getAvailable: () => [] });
  assert.match(unavailable, /Default model: "fake\/flash"/);
  assert.match(unavailable, /currently unavailable/);
  assert.match(unavailable, /omission does not select a fallback/);
  assert.match(
    selectionGuidance(
      { ...config, defaultModel: undefined },
      { getAvailable: () => [flash] },
    ),
    /Default model: none/,
  );
  assert.equal(
    selectionGuidance(
      { ...config, enabled: false },
      { getAvailable: () => [flash] },
    ),
    "Subagent delegation is disabled.",
  );
});
