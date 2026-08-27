import type { BackendName, ReasoningEffort } from "./domain.ts";

const DEFAULTS = {
  claude: { model: "claude-opus-5", reasoningEffort: "high" },
  codex: { model: "gpt-5.6-sol", reasoningEffort: "high" },
} as const satisfies Record<
  Exclude<BackendName, "pi">,
  { model: string; reasoningEffort: ReasoningEffort }
>;

export function resolveSubagentRouting(
  harness: BackendName,
  model?: string,
  reasoningEffort?: ReasoningEffort,
) {
  if (harness === "pi") {
    return { model, reasoningEffort };
  }

  return {
    model: model ?? DEFAULTS[harness].model,
    reasoningEffort: reasoningEffort ?? DEFAULTS[harness].reasoningEffort,
  };
}
