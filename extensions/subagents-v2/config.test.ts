import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  loadConfig,
  parseConfig,
  resolveSelection,
  supportedReasoning,
  validateConfig,
} from "./src/config.ts";
import type { SubagentsConfig } from "./src/types.ts";

type Registry = Pick<ModelRegistry, "getAvailable" | "find">;

const fakeModel = {
  provider: "fake",
  id: "model",
  reasoning: true,
} as Model<never>;

/**
 * Fixture copied from the catalog entry for opencode-go/deepseek-v4.1-flash.
 * `null` entries are explicit exclusions, so only low/high/max are valid.
 */
const flashModel = {
  provider: "opencode-go",
  id: "deepseek-v4.1-flash",
  reasoning: true,
  thinkingLevelMap: {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  },
} as Model<never>;

const plainModel = {
  provider: "fake",
  id: "plain",
  reasoning: false,
} as Model<never>;

function registry(models: readonly Model<never>[] = [fakeModel]): Registry {
  return {
    find: (provider: string, id: string) =>
      models.find((model) => model.provider === provider && model.id === id),
    getAvailable: () => [...models],
  } as unknown as Registry;
}

function config(overrides: Partial<SubagentsConfig> = {}): SubagentsConfig {
  return {
    version: 2,
    enabled: true,
    allowedModels: ["fake/model"],
    modelReasoning: { "fake/model": { allowed: ["low"] } },
    maxActive: 4,
    ...overrides,
  };
}

function withTempConfig(contents: unknown, run: (file: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-v2-config-"));
  const file = path.join(dir, "config.json");
  if (contents !== undefined)
    fs.writeFileSync(file, `${JSON.stringify(contents, null, 2)}\n`);
  try {
    run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("configuration defaults to disabled version 2 and requires explicit per-model reasoning", () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    version: 2,
    enabled: false,
    allowedModels: [],
    modelReasoning: {},
    maxActive: 4,
  });
  assert.deepEqual(
    parseConfig({
      version: 2,
      enabled: false,
      allowedModels: [],
      modelReasoning: {},
      maxActive: 4,
    }),
    {
      version: 2,
      enabled: false,
      allowedModels: [],
      modelReasoning: {},
      maxActive: 4,
    },
  );
  assert.deepEqual(
    parseConfig({
      version: 2,
      enabled: false,
      allowedModels: ["fake/model", "fake/model"],
      modelReasoning: { "fake/model": { allowed: ["low", "low"] } },
      maxActive: 4,
    }),
    {
      version: 2,
      enabled: false,
      allowedModels: ["fake/model"],
      modelReasoning: { "fake/model": { allowed: ["low"] } },
      maxActive: 4,
    },
  );
  assert.throws(
    () =>
      parseConfig({
        version: 1,
        enabled: false,
        allowedModels: [],
        allowedReasoning: [],
        maxActive: 4,
      }),
    /version/,
  );
  assert.throws(
    () => validateConfig(config({ allowedModels: [] })),
    /allowed model/,
  );
  assert.throws(
    () => validateConfig(config({ modelReasoning: {} })),
    /needs at least one allowed reasoning level/,
  );
  assert.throws(
    () => validateConfig(config(), registry([])),
    /available.*allowed model/,
  );
  assert.throws(
    () => resolveSelection(config(), registry()),
    /No model was supplied/,
  );
  assert.throws(
    () => resolveSelection(config({ defaultModel: "fake/model" }), registry()),
    /has no configured default/,
  );
});

test("parseConfig rejects malformed version 2 configuration", () => {
  const base = {
    version: 2,
    enabled: false,
    allowedModels: [] as string[],
    modelReasoning: {} as Record<string, unknown>,
    maxActive: 4,
  };
  assert.throws(() => parseConfig(null), /object/);
  assert.throws(
    () => parseConfig({ ...base, modelReasoning: undefined }),
    /modelReasoning/,
  );
  assert.throws(
    () =>
      parseConfig({
        ...base,
        modelReasoning: { "fake/model": { allowed: [] } },
      }),
    /nonempty/,
  );
  assert.throws(
    () =>
      parseConfig({
        ...base,
        modelReasoning: { "fake/model": { allowed: ["bogus"] } },
      }),
    /nonempty/,
  );
  assert.throws(
    () =>
      parseConfig({
        ...base,
        modelReasoning: { "fake/model": { allowed: ["low"], default: "high" } },
      }),
    /default must be one of/,
  );
  assert.throws(
    () =>
      parseConfig({
        ...base,
        allowedModels: ["fake/model"],
        modelReasoning: {},
      }),
    /needs at least one allowed reasoning level/,
  );
  assert.throws(() => parseConfig({ ...base, maxActive: 0 }), /maxActive/);
  assert.throws(
    () =>
      parseConfig({
        ...base,
        allowedModels: ["fake/model"],
        modelReasoning: { "fake/model": { allowed: ["low"] } },
        defaultModel: "other/model",
      }),
    /default model is not allowed/,
  );
});

test("resolution uses only the selected model's configured default and rejects invalid choices", () => {
  const configured = config({
    defaultModel: "fake/model",
    modelReasoning: {
      "fake/model": { allowed: ["low", "medium"], default: "low" },
    },
  });
  const selection = resolveSelection(configured, registry());
  assert.equal(selection.modelKey, "fake/model");
  assert.equal(selection.reasoning, "low");
  assert.equal(
    resolveSelection(configured, registry(), "fake/model", "medium").reasoning,
    "medium",
  );
  assert.throws(
    () => resolveSelection(configured, registry([])),
    /unavailable|authentication/,
  );
  assert.throws(
    () => resolveSelection(configured, registry(), "other/model", "low"),
    /not allowed/,
  );
  assert.throws(
    () => resolveSelection(configured, registry(), "fake/model", "high"),
    /not allowed for model/,
  );
  assert.throws(
    () => resolveSelection(config({ enabled: false }), registry()),
    /disabled/,
  );
  assert.throws(
    () =>
      resolveSelection(
        config({
          defaultModel: "fake/model",
          modelReasoning: {
            "fake/model": { allowed: ["max"], default: "max" },
          },
        }),
        registry(),
      ),
    /does not support reasoning level/,
  );

  const perModel = config({
    allowedModels: ["fake/model", "opencode-go/deepseek-v4.1-flash"],
    modelReasoning: {
      "fake/model": { allowed: ["low"], default: "low" },
      "opencode-go/deepseek-v4.1-flash": { allowed: ["high"], default: "high" },
    },
  });
  const models = registry([fakeModel, flashModel]);
  assert.equal(
    resolveSelection(perModel, models, "opencode-go/deepseek-v4.1-flash")
      .reasoning,
    "high",
  );
  assert.throws(
    () =>
      resolveSelection(
        perModel,
        models,
        "opencode-go/deepseek-v4.1-flash",
        "low",
      ),
    /not allowed for model/,
  );
});

test("supportedReasoning mirrors the concrete catalog thinkingLevelMap without a superset", () => {
  assert.deepEqual(supportedReasoning(flashModel), ["low", "high", "max"]);
  assert.deepEqual(supportedReasoning(fakeModel), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
  assert.deepEqual(supportedReasoning(plainModel), ["off"]);
});

test("validateConfig rejects allowed levels the concrete model does not support", () => {
  assert.throws(
    () =>
      validateConfig(
        config({
          allowedModels: ["opencode-go/deepseek-v4.1-flash"],
          modelReasoning: {
            "opencode-go/deepseek-v4.1-flash": { allowed: ["low", "medium"] },
          },
        }),
        registry([flashModel]),
      ),
    /does not support reasoning level\(s\) medium/,
  );
  validateConfig(
    config({
      allowedModels: ["opencode-go/deepseek-v4.1-flash"],
      modelReasoning: {
        "opencode-go/deepseek-v4.1-flash": { allowed: ["low"], default: "low" },
      },
    }),
    registry([flashModel]),
  );
  assert.throws(
    () =>
      validateConfig(
        config({
          allowedModels: ["fake/model", "opencode-go/deepseek-v4.1-flash"],
          modelReasoning: {
            "fake/model": { allowed: ["low"] },
            "opencode-go/deepseek-v4.1-flash": { allowed: ["low"] },
          },
          defaultModel: "fake/model",
        }),
        registry([flashModel]),
      ),
    /Default model "fake\/model" is unavailable/,
  );
});

test("validateConfig directly rejects invalid levels, defaults, identifiers, and maxActive", () => {
  const raw = (value: unknown) => value as SubagentsConfig;
  assert.throws(
    () => validateConfig(raw({ ...config(), enabled: "yes" })),
    /enabled must be boolean/,
  );
  assert.throws(
    () => validateConfig(raw({ ...config(), maxActive: 0 })),
    /maxActive/,
  );
  assert.throws(
    () => validateConfig(raw({ ...config(), maxActive: 33 })),
    /maxActive/,
  );
  assert.throws(
    () => validateConfig(raw({ ...config(), maxActive: 2.5 })),
    /maxActive/,
  );
  assert.throws(
    () =>
      validateConfig(
        raw({ ...config(), modelReasoning: { "fake/model": { allowed: [] } } }),
      ),
    /nonempty array of reasoning levels/,
  );
  assert.throws(
    () =>
      validateConfig(
        raw({
          ...config(),
          modelReasoning: { "fake/model": { allowed: ["bogus"] } },
        }),
      ),
    /nonempty array of reasoning levels/,
  );
  assert.throws(
    () =>
      validateConfig(
        raw({
          ...config(),
          modelReasoning: {
            "fake/model": { allowed: ["low"], default: "bogus" },
          },
        }),
      ),
    /default is invalid/,
  );
  assert.throws(
    () =>
      validateConfig(
        raw({
          ...config(),
          modelReasoning: {
            "fake/model": { allowed: ["low"], default: "high" },
          },
        }),
      ),
    /default must be one of/,
  );
  assert.throws(
    () =>
      validateConfig(
        raw({ ...config(), modelReasoning: { "fake/model": null } }),
      ),
    /must be an object/,
  );
  for (const model of ["noslash", "/model", "fake/", " /model", "fake/ "]) {
    assert.throws(
      () =>
        validateConfig(
          raw({
            ...config(),
            allowedModels: [model],
            modelReasoning: { [model]: { allowed: ["low"] } },
          }),
        ),
      /provider\/model identifiers with nonempty sides/,
      model,
    );
  }
});

test("validateConfig checks real capabilities even when delegation is disabled", () => {
  assert.throws(
    () =>
      validateConfig(
        config({
          enabled: false,
          allowedModels: ["opencode-go/deepseek-v4.1-flash"],
          modelReasoning: {
            "opencode-go/deepseek-v4.1-flash": { allowed: ["medium"] },
          },
        }),
        registry([flashModel]),
      ),
    /does not support reasoning level\(s\) medium/,
  );
  // Availability is only required to enable delegation.
  validateConfig(
    config({
      enabled: false,
      allowedModels: ["fake/model"],
      modelReasoning: { "fake/model": { allowed: ["low"] } },
    }),
    registry([]),
  );
  assert.throws(
    () =>
      validateConfig(
        config({
          allowedModels: ["fake/model"],
          modelReasoning: { "fake/model": { allowed: ["low"] } },
        }),
        registry([]),
      ),
    /available.*allowed model/,
  );
});

test("version 1 migration intersects global levels with real model support and keeps only valid defaults", () => {
  const legacy = {
    version: 1,
    enabled: true,
    allowedModels: ["opencode-go/deepseek-v4.1-flash", "fake/model"],
    allowedReasoning: ["low", "medium", "high", "max"],
    defaultModel: "opencode-go/deepseek-v4.1-flash",
    defaultReasoning: "max",
    maxActive: 6,
  };
  withTempConfig(legacy, (file) => {
    const before = fs.readFileSync(file, "utf8");
    const { config: migrated, error } = loadConfig(
      file,
      registry([flashModel, fakeModel]),
    );
    assert.equal(error, undefined);
    assert.deepEqual(migrated, {
      version: 2,
      enabled: true,
      allowedModels: ["opencode-go/deepseek-v4.1-flash", "fake/model"],
      modelReasoning: {
        "opencode-go/deepseek-v4.1-flash": {
          allowed: ["low", "high", "max"],
          default: "max",
        },
        "fake/model": { allowed: ["low", "medium", "high"] },
      },
      defaultModel: "opencode-go/deepseek-v4.1-flash",
      maxActive: 6,
    });
    assert.equal(
      fs.readFileSync(file, "utf8"),
      before,
      "migration must not write to disk",
    );
  });
});

test("migration drops unsupported defaults and models with no valid level", () => {
  const legacy = {
    version: 1,
    enabled: true,
    allowedModels: [
      "opencode-go/deepseek-v4.1-flash",
      "fake/model",
      "ghost/model",
    ],
    allowedReasoning: ["medium"],
    defaultModel: "opencode-go/deepseek-v4.1-flash",
    defaultReasoning: "medium",
    maxActive: 4,
  };
  withTempConfig(legacy, (file) => {
    const before = fs.readFileSync(file, "utf8");
    const { config: migrated, error } = loadConfig(
      file,
      registry([flashModel, fakeModel]),
    );
    assert.equal(error, undefined);
    assert.deepEqual(migrated, {
      version: 2,
      enabled: true,
      allowedModels: ["fake/model"],
      modelReasoning: {
        "fake/model": { allowed: ["medium"], default: "medium" },
      },
      maxActive: 4,
    });
    assert.equal(migrated.defaultModel, undefined);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

test("migration carries the legacy global default to every model that still supports it", () => {
  const legacy = {
    version: 1,
    enabled: true,
    allowedModels: ["opencode-go/deepseek-v4.1-flash", "fake/model"],
    allowedReasoning: ["low", "high"],
    defaultReasoning: "low",
    maxActive: 4,
  };
  withTempConfig(legacy, (file) => {
    const { config: migrated, error } = loadConfig(
      file,
      registry([flashModel, fakeModel]),
    );
    assert.equal(error, undefined);
    assert.deepEqual(migrated, {
      version: 2,
      enabled: true,
      allowedModels: ["opencode-go/deepseek-v4.1-flash", "fake/model"],
      modelReasoning: {
        "opencode-go/deepseek-v4.1-flash": {
          allowed: ["low", "high"],
          default: "low",
        },
        "fake/model": { allowed: ["low", "high"], default: "low" },
      },
      maxActive: 4,
    });
    assert.equal(migrated.defaultModel, undefined);
  });
});

test("migration disables delegation when no model retains a valid level", () => {
  const legacy = {
    version: 1,
    enabled: true,
    allowedModels: ["fake/model"],
    allowedReasoning: ["max"],
    defaultModel: "fake/model",
    defaultReasoning: "max",
    maxActive: 4,
  };
  withTempConfig(legacy, (file) => {
    const before = fs.readFileSync(file, "utf8");
    const { config: migrated, error } = loadConfig(file, registry([fakeModel]));
    assert.equal(error, undefined);
    assert.deepEqual(migrated, {
      version: 2,
      enabled: false,
      allowedModels: [],
      modelReasoning: {},
      maxActive: 4,
    });
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

test("version 1 without a registry returns a disabled default and an error without writing", () => {
  const legacy = {
    version: 1,
    enabled: true,
    allowedModels: ["fake/model"],
    allowedReasoning: ["low"],
    defaultModel: "fake/model",
    defaultReasoning: "low",
    maxActive: 4,
  };
  withTempConfig(legacy, (file) => {
    const before = fs.readFileSync(file, "utf8");
    const { config: loaded, error } = loadConfig(file);
    assert.ok(error);
    assert.equal(loaded.enabled, false);
    assert.equal(loaded.version, 2);
    assert.deepEqual(loaded.allowedModels, []);
    assert.deepEqual(loaded.modelReasoning, {});
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });
});

test("invalid legacy configuration reports an error and stays disabled", () => {
  const legacy = {
    version: 1,
    enabled: true,
    allowedModels: ["fake/model"],
    allowedReasoning: ["bogus"],
    maxActive: 4,
  };
  withTempConfig(legacy, (file) => {
    const { config: loaded, error } = loadConfig(file, registry([fakeModel]));
    assert.ok(error);
    assert.equal(loaded.enabled, false);
  });
});

test("loadConfig parses version 2 files and returns the disabled default when missing", () => {
  const v2 = {
    version: 2,
    enabled: false,
    allowedModels: ["fake/model"],
    modelReasoning: { "fake/model": { allowed: ["low"], default: "low" } },
    maxActive: 4,
  };
  withTempConfig(v2, (file) => {
    const { config: loaded, error } = loadConfig(file);
    assert.equal(error, undefined);
    assert.deepEqual(loaded, v2);
  });
  withTempConfig(undefined, (file) => {
    const { config: loaded, error } = loadConfig(file);
    assert.equal(error, undefined);
    assert.deepEqual(loaded, DEFAULT_CONFIG);
  });
});
