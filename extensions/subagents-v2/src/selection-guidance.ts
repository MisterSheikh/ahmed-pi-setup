import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { supportedReasoning } from "./config.ts";
import { modelKey, type SubagentsConfig } from "./types.ts";

/** Expose current choices to the parent without replacing its system prompt. */
export function selectionGuidance(
  config: SubagentsConfig,
  registry: Pick<ModelRegistry, "getAvailable">,
): string {
  if (!config.enabled) return "Subagent delegation is disabled.";
  const choices = registry.getAvailable().flatMap((model) => {
    const key = modelKey(model);
    if (!config.allowedModels.includes(key)) return [];
    const policy = config.modelReasoning[key];
    if (!policy) return [];
    const supported = supportedReasoning(model);
    const allowed = policy.allowed.filter((level) => supported.includes(level));
    if (!allowed.length) return [];
    return [
      {
        model: key,
        reasoning: allowed,
        ...(policy.default && allowed.includes(policy.default)
          ? { defaultReasoning: policy.default }
          : {}),
      },
    ];
  });
  return [
    "You, the parent agent, choose the worker model and reasoning level for each task from these currently available, user-allowed choices:",
    JSON.stringify(choices),
    `Default model: ${config.defaultModel ? JSON.stringify(config.defaultModel) : "none"}.`,
    ...(config.defaultModel &&
    !choices.some((choice) => choice.model === config.defaultModel)
      ? [
          "The configured default model is currently unavailable or has no supported allowed levels. Supply an available allowed model explicitly; omission does not select a fallback.",
        ]
      : []),
    "Omitting reasoning uses only the selected model's configured default. Without that default, supply reasoning explicitly. Workers do not choose their own model or reasoning. There is no parent-setting inheritance or fallback.",
  ].join("\n");
}
