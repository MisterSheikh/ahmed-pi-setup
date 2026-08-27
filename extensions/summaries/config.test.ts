import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SUMMARY_CONFIG,
  parseSummaryConfig,
  PRIVATE_CONFIG_PATH,
} from "./src/config.ts";

test("summary config is stored outside the extension source", () => {
  assert.equal(
    PRIVATE_CONFIG_PATH,
    join(getAgentDir(), "state", "summaries.json"),
  );
});

test("summary config defaults to Codex Luna at medium reasoning", () => {
  assert.deepEqual(parseSummaryConfig(undefined), DEFAULT_SUMMARY_CONFIG);
  assert.deepEqual(DEFAULT_SUMMARY_CONFIG, {
    enabled: true,
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    reasoning: "medium",
  });
});

test("summary config accepts valid private overrides and rejects partial corruption", () => {
  assert.deepEqual(
    parseSummaryConfig({
      provider: " anthropic ",
      model: " claude-sonnet ",
      reasoning: "high",
    }),
    {
      enabled: true,
      provider: "anthropic",
      model: "claude-sonnet",
      reasoning: "high",
    },
  );

  assert.deepEqual(
    parseSummaryConfig({
      enabled: false,
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      reasoning: "medium",
    }),
    {
      enabled: false,
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      reasoning: "medium",
    },
  );

  assert.deepEqual(
    parseSummaryConfig({ provider: "", model: 42, reasoning: "turbo" }),
    DEFAULT_SUMMARY_CONFIG,
  );
  assert.deepEqual(
    parseSummaryConfig({
      provider: "anthropic",
      model: 42,
      reasoning: "high",
    }),
    DEFAULT_SUMMARY_CONFIG,
  );
});
