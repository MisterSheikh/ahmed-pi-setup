import type { BackendName, ReasoningEffort } from "./domain.ts";

const DEFAULTS = {
  pi: {
    model: "opencode-go/deepseek-v4-flash",
    reasoningEffort: "high",
  },
  claude: { model: "claude-opus-5", reasoningEffort: "high" },
  codex: { model: "gpt-5.6-sol", reasoningEffort: "high" },
} as const satisfies Record<
  BackendName,
  { model: string; reasoningEffort: ReasoningEffort }
>;

function isDeepSeekV4Flash(model: string) {
  return model === "deepseek-v4-flash" || model.endsWith("/deepseek-v4-flash");
}

export function resolveSubagentRouting(
  harness: BackendName,
  model?: string,
  reasoningEffort?: ReasoningEffort,
) {
  const resolved = {
    model: model ?? DEFAULTS[harness].model,
    reasoningEffort: reasoningEffort ?? DEFAULTS[harness].reasoningEffort,
  };

  if (
    harness === "pi" &&
    isDeepSeekV4Flash(resolved.model) &&
    resolved.reasoningEffort !== "high" &&
    resolved.reasoningEffort !== "max"
  ) {
    throw new Error(
      "DeepSeek V4 Flash subagents only support high or max reasoning.",
    );
  }

  return resolved;
}
