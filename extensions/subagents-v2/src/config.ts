import * as fs from "node:fs";
import * as path from "node:path";
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  modelKey,
  THINKING_LEVELS,
  type ModelReasoningConfig,
  type ResolvedSelection,
  type SubagentsConfig,
  type ThinkingLevel,
} from "./types.ts";

/** The synchronous registry surface needed to resolve and validate models. */
type Registry = Pick<ModelRegistry, "getAvailable" | "find">;

const freshDefaultConfig = (): SubagentsConfig => ({
  version: 2,
  enabled: false,
  allowedModels: [],
  modelReasoning: {},
  maxActive: 4,
});

export const DEFAULT_CONFIG: SubagentsConfig = freshDefaultConfig();

const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The levels pi-ai reports for a concrete model, including any
 * `thinkingLevelMap` exclusions. Never a generic superset or a clamped level.
 */
export function supportedReasoning<TApi extends Api>(
  model: Model<TApi>,
): ThinkingLevel[] {
  return getSupportedThinkingLevels(model);
}

function findModel(key: string, registry: Registry): Model<Api> | undefined {
  const slash = key.indexOf("/");
  if (slash < 1 || slash === key.length - 1) return undefined;
  return registry.find(key.slice(0, slash), key.slice(slash + 1));
}

function parseModelReasoning(
  value: unknown,
): Record<string, ModelReasoningConfig> {
  if (!isRecord(value))
    throw new Error(
      "modelReasoning must be an object keyed by provider/model identifiers.",
    );
  const result: Record<string, ModelReasoningConfig> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw))
      throw new Error(`modelReasoning["${key}"] must be an object.`);
    if (
      !Array.isArray(raw.allowed) ||
      raw.allowed.length === 0 ||
      !raw.allowed.every(isThinkingLevel)
    ) {
      throw new Error(
        `modelReasoning["${key}"].allowed must be a nonempty array of reasoning levels.`,
      );
    }
    const allowed = [...new Set(raw.allowed as ThinkingLevel[])];
    const parsed: ModelReasoningConfig = { allowed };
    if (raw.default !== undefined) {
      if (!isThinkingLevel(raw.default))
        throw new Error(`modelReasoning["${key}"].default is invalid.`);
      if (!allowed.includes(raw.default))
        throw new Error(
          `modelReasoning["${key}"].default must be one of its allowed levels.`,
        );
      parsed.default = raw.default;
    }
    result[key] = parsed;
  }
  return result;
}

export function parseConfig(value: unknown): SubagentsConfig {
  if (!isRecord(value)) throw new Error("Configuration must be an object.");
  if (value.version !== 2)
    throw new Error("Unsupported subagents V2 configuration version.");
  if (typeof value.enabled !== "boolean")
    throw new Error("enabled must be boolean.");
  if (
    !Array.isArray(value.allowedModels) ||
    !value.allowedModels.every((item) => typeof item === "string")
  ) {
    throw new Error("allowedModels must be an array of model identifiers.");
  }
  const modelReasoning = parseModelReasoning(value.modelReasoning);
  if (
    !Number.isInteger(value.maxActive) ||
    Number(value.maxActive) < 1 ||
    Number(value.maxActive) > 32
  ) {
    throw new Error("maxActive must be an integer from 1 to 32.");
  }
  if (
    value.defaultModel !== undefined &&
    typeof value.defaultModel !== "string"
  )
    throw new Error("defaultModel must be a string.");
  const config: SubagentsConfig = {
    version: 2,
    enabled: value.enabled,
    allowedModels: [...new Set(value.allowedModels as string[])],
    modelReasoning,
    maxActive: Number(value.maxActive),
  };
  if (value.defaultModel) config.defaultModel = value.defaultModel;
  validateConfig(config);
  return config;
}

export function validateConfig(config: SubagentsConfig, registry?: Registry) {
  if (config.version !== 2)
    throw new Error("Unsupported subagents V2 configuration version.");
  if (typeof config.enabled !== "boolean")
    throw new Error("enabled must be boolean.");
  if (
    !Array.isArray(config.allowedModels) ||
    !config.allowedModels.every((model) => typeof model === "string")
  ) {
    throw new Error("allowedModels must be an array of model identifiers.");
  }
  if (
    !Number.isInteger(config.maxActive) ||
    config.maxActive < 1 ||
    config.maxActive > 32
  ) {
    throw new Error("maxActive must be an integer from 1 to 32.");
  }
  for (const model of config.allowedModels) {
    const slash = model.indexOf("/");
    if (
      slash < 1 ||
      slash === model.length - 1 ||
      !model.slice(0, slash).trim() ||
      !model.slice(slash + 1).trim()
    ) {
      throw new Error(
        "Allowed models must use provider/model identifiers with nonempty sides.",
      );
    }
  }
  if (!isRecord(config.modelReasoning)) {
    throw new Error(
      "modelReasoning must be an object keyed by provider/model identifiers.",
    );
  }
  for (const [model, policy] of Object.entries(config.modelReasoning)) {
    if (!isRecord(policy))
      throw new Error(`modelReasoning["${model}"] must be an object.`);
    if (
      !Array.isArray(policy.allowed) ||
      policy.allowed.length === 0 ||
      !policy.allowed.every(isThinkingLevel)
    ) {
      throw new Error(
        `modelReasoning["${model}"].allowed must be a nonempty array of reasoning levels.`,
      );
    }
    if (policy.default !== undefined) {
      if (!isThinkingLevel(policy.default))
        throw new Error(`modelReasoning["${model}"].default is invalid.`);
      if (!(policy.allowed as ThinkingLevel[]).includes(policy.default)) {
        throw new Error(
          `modelReasoning["${model}"].default must be one of its allowed levels.`,
        );
      }
    }
  }
  for (const model of config.allowedModels) {
    const policy = config.modelReasoning[model];
    if (!policy || policy.allowed.length === 0) {
      throw new Error(
        `Allowed model "${model}" needs at least one allowed reasoning level.`,
      );
    }
  }
  if (
    config.defaultModel &&
    !config.allowedModels.includes(config.defaultModel)
  ) {
    throw new Error("The default model is not allowed.");
  }
  if (config.enabled && config.allowedModels.length === 0) {
    throw new Error(
      "Add at least one allowed model and reasoning level before enabling delegation.",
    );
  }
  if (!registry) return;

  // Real capability validation runs whenever a registry is supplied, even
  // while delegation is disabled. Availability is only required to enable.
  for (const key of config.allowedModels) {
    const model = findModel(key, registry);
    if (!model) continue;
    const supported = supportedReasoning(model);
    const unsupported = config.modelReasoning[key]!.allowed.filter(
      (level) => !supported.includes(level),
    );
    if (unsupported.length > 0) {
      throw new Error(
        `Model "${key}" does not support reasoning level(s) ${unsupported.join(", ")}.`,
      );
    }
  }
  if (!config.enabled) return;

  const available = new Set(registry.getAvailable().map(modelKey));
  const usableModels = config.allowedModels.flatMap((key) => {
    const model = findModel(key, registry);
    return model && available.has(key) ? [{ key, model }] : [];
  });
  if (usableModels.length === 0) {
    throw new Error(
      "Delegation requires at least one available, authenticated allowed model.",
    );
  }
  if (
    config.defaultModel &&
    !usableModels.some(({ key }) => key === config.defaultModel)
  ) {
    throw new Error(
      `Default model "${config.defaultModel}" is unavailable or has no configured authentication.`,
    );
  }
}

interface LegacyConfigV1 {
  enabled: boolean;
  allowedModels: string[];
  allowedReasoning: ThinkingLevel[];
  defaultModel?: string;
  defaultReasoning?: ThinkingLevel;
  maxActive: number;
}

function parseV1(value: unknown): LegacyConfigV1 {
  if (!isRecord(value)) throw new Error("Configuration must be an object.");
  if (value.version !== 1)
    throw new Error("Unsupported subagents V2 configuration version.");
  if (typeof value.enabled !== "boolean")
    throw new Error("enabled must be boolean.");
  if (
    !Array.isArray(value.allowedModels) ||
    !value.allowedModels.every((item) => typeof item === "string")
  ) {
    throw new Error("allowedModels must be an array of model identifiers.");
  }
  if (
    !Array.isArray(value.allowedReasoning) ||
    !value.allowedReasoning.every(isThinkingLevel)
  ) {
    throw new Error("allowedReasoning contains an invalid level.");
  }
  if (
    !Number.isInteger(value.maxActive) ||
    Number(value.maxActive) < 1 ||
    Number(value.maxActive) > 32
  ) {
    throw new Error("maxActive must be an integer from 1 to 32.");
  }
  if (
    value.defaultModel !== undefined &&
    typeof value.defaultModel !== "string"
  )
    throw new Error("defaultModel must be a string.");
  if (
    value.defaultReasoning !== undefined &&
    !isThinkingLevel(value.defaultReasoning)
  ) {
    throw new Error("defaultReasoning is invalid.");
  }
  const legacy: LegacyConfigV1 = {
    enabled: value.enabled,
    allowedModels: [...new Set(value.allowedModels as string[])],
    allowedReasoning: [...new Set(value.allowedReasoning as ThinkingLevel[])],
    maxActive: Number(value.maxActive),
  };
  if (value.defaultModel) legacy.defaultModel = value.defaultModel;
  if (value.defaultReasoning)
    legacy.defaultReasoning = value.defaultReasoning as ThinkingLevel;
  return legacy;
}

/**
 * Convert a version 1 configuration in memory. Global levels are intersected
 * with each concrete model's real supported levels, so no level is invented
 * and unsupported levels are never carried forward. Models left with no valid
 * level are dropped; delegation is disabled when none remain. Never writes.
 */
function migrateV1Config(value: unknown, registry: Registry): SubagentsConfig {
  const legacy = parseV1(value);
  const modelReasoning: Record<string, ModelReasoningConfig> = {};
  for (const key of legacy.allowedModels) {
    const model = findModel(key, registry);
    if (!model) continue;
    const supported = supportedReasoning(model);
    const allowed = legacy.allowedReasoning.filter((level) =>
      supported.includes(level),
    );
    if (allowed.length === 0) continue;
    const policy: ModelReasoningConfig = { allowed };
    // Legacy resolution applied the global default to any explicitly selected
    // allowed model, so carry it to every model that still supports it.
    if (legacy.defaultReasoning && allowed.includes(legacy.defaultReasoning)) {
      policy.default = legacy.defaultReasoning;
    }
    modelReasoning[key] = policy;
  }
  const allowedModels = Object.keys(modelReasoning);
  const config: SubagentsConfig = {
    version: 2,
    enabled: legacy.enabled && allowedModels.length > 0,
    allowedModels,
    modelReasoning,
    maxActive: legacy.maxActive,
  };
  if (legacy.defaultModel && allowedModels.includes(legacy.defaultModel))
    config.defaultModel = legacy.defaultModel;
  return config;
}

export function loadConfig(
  file: string,
  registry?: Registry,
): {
  config: SubagentsConfig;
  error?: string;
} {
  try {
    if (!fs.existsSync(file)) return { config: freshDefaultConfig() };
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (isRecord(raw) && raw.version === 1) {
      if (!registry) {
        return {
          config: freshDefaultConfig(),
          error: `Could not load ${file}: legacy version 1 configuration needs a model registry to validate reasoning levels. Delegation remains disabled.`,
        };
      }
      return { config: migrateV1Config(raw, registry) };
    }
    return { config: parseConfig(raw) };
  } catch (error) {
    return {
      config: freshDefaultConfig(),
      error: `Could not load ${file}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function saveConfig(file: string, config: SubagentsConfig) {
  validateConfig(config);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

export function resolveSelection(
  config: SubagentsConfig,
  registry: Registry,
  requestedModel?: string,
  requestedReasoning?: ThinkingLevel,
): ResolvedSelection {
  if (!config.enabled)
    throw new Error(
      "Subagent delegation is disabled. Use /subagent-config to enable it.",
    );
  const requestedKey = requestedModel ?? config.defaultModel;
  if (!requestedKey)
    throw new Error(
      "No model was supplied and no default model is configured.",
    );
  if (!config.allowedModels.includes(requestedKey))
    throw new Error(`Model "${requestedKey}" is not allowed.`);
  const policy = config.modelReasoning[requestedKey];
  if (!policy || policy.allowed.length === 0) {
    throw new Error(
      `Model "${requestedKey}" has no allowed reasoning levels configured.`,
    );
  }
  const reasoning = requestedReasoning ?? policy.default;
  if (!reasoning) {
    throw new Error(
      `No reasoning level was supplied and model "${requestedKey}" has no configured default.`,
    );
  }
  if (!policy.allowed.includes(reasoning))
    throw new Error(
      `Reasoning level "${reasoning}" is not allowed for model "${requestedKey}".`,
    );
  const model = findModel(requestedKey, registry);
  const available = registry
    .getAvailable()
    .some((candidate) => modelKey(candidate) === requestedKey);
  if (!model || !available)
    throw new Error(
      `Model "${requestedKey}" is unavailable or has no configured authentication.`,
    );
  if (!supportedReasoning(model).includes(reasoning))
    throw new Error(
      `Model "${requestedKey}" does not support reasoning level "${reasoning}".`,
    );
  return { modelKey: requestedKey, model, reasoning };
}
