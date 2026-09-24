import assert from "node:assert/strict";
import test from "node:test";
import {
  formatSubscriptionUsage,
  parseCodexUsage,
  parseCodexUsageResponse,
} from "./index.ts";

test("parses Codex quota headers case-insensitively", () => {
  assert.deepEqual(
    parseCodexUsage({
      "X-Codex-Primary-Used-Percent": "18",
      "X-Codex-Primary-Window-Minutes": "300",
      "x-codex-secondary-used-percent": "36.5",
      "x-codex-secondary-window-minutes": "10080",
    }),
    {
      provider: "OpenAI",
      primary: { usedPercent: 18, windowMinutes: 300, resetsAt: undefined },
      secondary: {
        usedPercent: 36.5,
        windowMinutes: 10_080,
        resetsAt: undefined,
      },
    },
  );
});

test("parses the Codex subscription usage endpoint", () => {
  assert.deepEqual(
    parseCodexUsageResponse({
      rate_limit: {
        primary_window: {
          used_percent: 69,
          limit_window_seconds: 604_800,
          reset_at: 1_790_553_671,
        },
        secondary_window: null,
      },
    }),
    {
      provider: "OpenAI",
      primary: {
        usedPercent: 69,
        windowMinutes: 10_080,
        resetsAt: 1_790_553_671,
      },
      secondary: undefined,
    },
  );
});

test("formats remaining usage by actual window duration", () => {
  const usage = parseCodexUsage({
    "x-codex-primary-used-percent": "18",
    "x-codex-primary-window-minutes": "300",
    "x-codex-secondary-used-percent": "36.5",
    "x-codex-secondary-window-minutes": "10080",
  });
  assert.ok(usage);
  assert.equal(
    formatSubscriptionUsage(usage),
    "OpenAI · 5h 82% left · week 63.5% left",
  );
});

test("ignores responses without subscription quota headers", () => {
  assert.equal(parseCodexUsage({ "x-ratelimit-remaining": "100" }), undefined);
});
