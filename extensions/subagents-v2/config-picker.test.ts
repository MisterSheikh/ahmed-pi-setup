import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { supportedReasoning, validateConfig } from "./src/config.ts";
import {
  ConfigPicker,
  type ConfigPickerConfig,
  type ConfigPickerRegistry,
  type ConfigPickerTheme,
  type ConfigPickerTui,
} from "./src/config-picker.ts";
import type { SubagentsConfig } from "./src/types.ts";

const KEY = {
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  enter: "\r",
  space: " ",
} as const;

function model(
  id: string,
  reasoning = true,
  name = id,
  thinkingLevelMap?: Record<string, string | null>,
): Model<never> {
  return {
    provider: "fake",
    id,
    name,
    reasoning,
    thinkingLevelMap,
  } as unknown as Model<never>;
}

// The real `supportedReasoning` reads `thinkingLevelMap`, so make the fake
// reasoner genuinely support only off/low/high. This keeps the picker and
// `validateConfig` in agreement.
const REASONER_MAP: Record<string, string | null> = {
  minimal: null,
  medium: null,
  xhigh: null,
  max: null,
};

function defaultModels(): Model<never>[] {
  return [
    model("basic", false),
    model("reasoner", true, "reasoner", REASONER_MAP),
  ];
}

function registry(models: Model<never>[]): ConfigPickerRegistry {
  return {
    getAvailable: () => models as unknown as Model<Api>[],
    find: (provider, id) =>
      models.find(
        (candidate) => candidate.provider === provider && candidate.id === id,
      ) as unknown as Model<Api> | undefined,
  };
}

const theme: ConfigPickerTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function fakeTui(rows = 24): ConfigPickerTui & { terminal: { rows: number } } {
  return { requestRender() {}, terminal: { rows } };
}

interface SetupOptions {
  config?: Partial<ConfigPickerConfig>;
  models?: Model<never>[];
  rows?: number;
  onChange?: (config: ConfigPickerConfig) => Promise<void>;
}

function setup(options: SetupOptions = {}) {
  const changes: ConfigPickerConfig[] = [];
  const dones: number[] = [];
  const config: ConfigPickerConfig = {
    enabled: false,
    allowedModels: [],
    modelReasoning: {},
    maxActive: 4,
    ...options.config,
  };
  const tui = fakeTui(options.rows ?? 24);
  const picker = new ConfigPicker<ConfigPickerConfig>({
    tui,
    theme,
    registry: registry(options.models ?? defaultModels()),
    supportedReasoning,
    initial: config,
    onChange:
      options.onChange ??
      (async (next) => {
        changes.push(structuredClone(next));
      }),
    done: () => dones.push(1),
  });
  return { picker, changes, dones, tui };
}

type Picker = ConfigPicker<ConfigPickerConfig>;

interface ValidatedSetup {
  config: Partial<SubagentsConfig>;
  models?: Model<never>[];
}

/** Drive a picker whose onChange runs the real `validateConfig`. */
function setupValidated(options: ValidatedSetup) {
  const changes: SubagentsConfig[] = [];
  const initial: SubagentsConfig = {
    version: 2,
    enabled: false,
    allowedModels: [],
    modelReasoning: {},
    maxActive: 4,
    ...options.config,
  };
  const models = options.models ?? defaultModels();
  const reg = registry(models);
  const picker = new ConfigPicker<SubagentsConfig>({
    tui: fakeTui(24),
    theme,
    registry: reg,
    supportedReasoning,
    initial,
    onChange: async (next) => {
      validateConfig(next, reg as unknown as ModelRegistry);
      changes.push(structuredClone(next));
    },
    done: () => {},
  });
  return { picker, changes };
}

async function pressValidated(
  picker: ConfigPicker<SubagentsConfig>,
  key: string,
): Promise<void> {
  picker.handleInput(key);
  await picker.flush();
}

async function press(picker: Picker, key: string): Promise<void> {
  picker.handleInput(key);
  await picker.flush();
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function openModels(picker: Picker): Promise<void> {
  await press(picker, KEY.down);
  await press(picker, KEY.down);
  await press(picker, KEY.down);
  await press(picker, KEY.enter);
}

async function openDefaultPicker(picker: Picker): Promise<void> {
  await press(picker, KEY.down);
  await press(picker, KEY.down);
  await press(picker, KEY.enter);
}

const allowedReasoner = (
  overrides: Partial<ConfigPickerConfig> = {},
): Partial<ConfigPickerConfig> => ({
  allowedModels: ["fake/reasoner"],
  modelReasoning: { "fake/reasoner": { allowed: ["low"], default: "low" } },
  ...overrides,
});

test("settings applies enable and maxActive changes immediately", async () => {
  const { picker, changes } = setup();
  await press(picker, KEY.space);
  assert.equal(picker.config.enabled, true);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].enabled, true);

  await press(picker, KEY.down);
  await press(picker, KEY.right);
  assert.equal(picker.config.maxActive, 5);
  assert.equal(changes.at(-1)?.maxActive, 5);

  for (let index = 0; index < 10; index++) await press(picker, KEY.left);
  assert.equal(picker.config.maxActive, 1);
  for (let index = 0; index < 40; index++) await press(picker, KEY.right);
  assert.equal(picker.config.maxActive, 32);
});

test("a new model stays pending until a reasoning level is chosen", async () => {
  const { picker, changes } = setup();
  await openModels(picker);
  assert.equal(picker.screen, "models");

  await press(picker, KEY.space);
  assert.equal(picker.pending, "fake/basic");
  assert.deepEqual(picker.config.allowedModels, []);
  assert.equal(changes.length, 0, "pending model must not be persisted");

  await press(picker, KEY.right);
  assert.equal(picker.screen, "reasoning");

  await press(picker, KEY.space);
  assert.deepEqual(picker.config.allowedModels, ["fake/basic"]);
  assert.deepEqual(picker.config.modelReasoning["fake/basic"].allowed, ["off"]);
  assert.equal(picker.pending, undefined);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].allowedModels, ["fake/basic"]);
});

test("pending model is discarded when leaving without reasoning", async () => {
  const { picker, changes } = setup();
  await openModels(picker);
  await press(picker, KEY.space);
  assert.equal(picker.pending, "fake/basic");
  await press(picker, KEY.escape);
  assert.equal(picker.screen, "settings");
  assert.deepEqual(picker.config.allowedModels, []);
  assert.equal(changes.length, 0);
});

test("Space toggles an allowed model without leaving the model list", async () => {
  const { picker, changes } = setup({
    config: {
      allowedModels: ["fake/reasoner"],
      modelReasoning: { "fake/reasoner": { allowed: ["low"] } },
    },
  });
  await openModels(picker);
  await press(picker, KEY.space);
  assert.equal(picker.screen, "models");
  assert.deepEqual(picker.config.allowedModels, []);
  assert.equal(changes.at(-1)?.allowedModels.length, 0);
  assert.deepEqual(
    picker.config.modelReasoning,
    {},
    "disabling a model drops its reasoning policy",
  );
});

test("cursor stays on the toggled model after re-sorting", async () => {
  const { picker } = setup({
    config: {
      allowedModels: ["fake/basic", "fake/reasoner"],
      modelReasoning: {
        "fake/basic": { allowed: ["off"] },
        "fake/reasoner": { allowed: ["low"] },
      },
    },
  });
  await openModels(picker);
  // Allowed models sort first alphabetically, so fake/basic is selected.
  await press(picker, KEY.space);
  assert.deepEqual(picker.config.allowedModels, ["fake/reasoner"]);
  const rendered = picker.render(80).join("\n");
  assert.match(rendered, /→ \[ \] fake\/basic/);
});

test("reasoning screen lists only real supported levels", async () => {
  const { picker } = setup({ config: allowedReasoner() });
  await openModels(picker);
  await press(picker, KEY.right);
  assert.equal(picker.screen, "reasoning");
  const rendered = picker.render(80).join("\n");
  assert.match(rendered, /off/);
  assert.match(rendered, /low/);
  assert.match(rendered, /high/);
  assert.doesNotMatch(rendered, /minimal/);
  assert.doesNotMatch(rendered, /medium/);
  assert.doesNotMatch(rendered, /xhigh/);
});

test("d sets and clears the optional per-model default", async () => {
  const { picker, changes } = setup({ config: allowedReasoner() });
  await openModels(picker);
  await press(picker, KEY.right);
  // Reasoning index starts on the configured default ("low").
  await press(picker, KEY.down);
  await press(picker, "d");
  assert.equal(picker.config.modelReasoning["fake/reasoner"].default, "high");
  assert.equal(changes.at(-1)?.modelReasoning["fake/reasoner"].default, "high");
  await press(picker, "d");
  assert.equal(
    picker.config.modelReasoning["fake/reasoner"].default,
    undefined,
  );
});

test("d on a disabled level enables it and makes it the default", async () => {
  const { picker } = setup({
    config: {
      allowedModels: ["fake/reasoner"],
      modelReasoning: { "fake/reasoner": { allowed: ["off"] } },
    },
  });
  await openModels(picker);
  await press(picker, KEY.right);
  await press(picker, KEY.down);
  await press(picker, "d");
  assert.deepEqual(picker.config.modelReasoning["fake/reasoner"].allowed, [
    "off",
    "low",
  ]);
  assert.equal(picker.config.modelReasoning["fake/reasoner"].default, "low");
});

test("removing the last level disables the model coherently", async () => {
  const { picker, changes } = setup({
    config: {
      allowedModels: ["fake/reasoner"],
      modelReasoning: { "fake/reasoner": { allowed: ["low"] } },
      defaultModel: "fake/reasoner",
    },
  });
  await openModels(picker);
  await press(picker, KEY.right);
  await press(picker, KEY.down);
  await press(picker, KEY.space);
  assert.deepEqual(picker.config.allowedModels, []);
  assert.deepEqual(picker.config.modelReasoning, {});
  assert.equal(picker.config.defaultModel, undefined);
  const persisted = changes.at(-1)!;
  assert.deepEqual(persisted.allowedModels, []);
  assert.deepEqual(persisted.modelReasoning, {});
  assert.equal(persisted.defaultModel, undefined);
});

test("literal t and d type into model search instead of acting as hotkeys", async () => {
  const { picker } = setup();
  await openModels(picker);
  await press(picker, "t");
  assert.equal(picker.screen, "models");
  assert.equal(picker.query, "t");
  await press(picker, "d");
  assert.equal(picker.query, "td");
  assert.deepEqual(picker.config.allowedModels, []);
});

test("fuzzy search filters the model list", async () => {
  const { picker } = setup();
  await openModels(picker);
  for (const character of "rsnr") await press(picker, character);
  const rendered = picker.render(80).join("\n");
  assert.match(rendered, /fake\/reasoner/);
  assert.doesNotMatch(rendered, /fake\/basic/);
});

test("fuzzy search matches the friendly model name as well as the key", async () => {
  const { picker } = setup({
    models: [model("basic", false), model("r1", true, "Friendly Reasoner")],
  });
  await openModels(picker);
  for (const character of "friendly") await press(picker, character);
  const rendered = picker.render(80).join("\n");
  assert.match(rendered, /fake\/r1/);
  assert.doesNotMatch(rendered, /fake\/basic/);
});

test("selecting an allowed model as default returns to settings", async () => {
  const { picker, changes } = setup({ config: allowedReasoner() });
  await openDefaultPicker(picker);
  assert.equal(picker.screen, "models");
  await press(picker, KEY.enter);
  assert.equal(picker.screen, "settings");
  assert.equal(picker.config.defaultModel, "fake/reasoner");
  assert.equal(changes.at(-1)?.defaultModel, "fake/reasoner");
});

test("settings Space clears the default model", async () => {
  const { picker } = setup({
    config: allowedReasoner({ defaultModel: "fake/reasoner" }),
  });
  await press(picker, KEY.down);
  await press(picker, KEY.down);
  await press(picker, KEY.space);
  assert.equal(picker.config.defaultModel, undefined);
});

test("rejected writes revert and surface the error without claiming success", async () => {
  let attempts = 0;
  const { picker } = setup({
    onChange: async () => {
      attempts++;
      throw new Error("write failed");
    },
  });
  await press(picker, KEY.space);
  assert.equal(attempts, 1);
  assert.equal(picker.config.enabled, false);
  const rendered = picker.render(80).join("\n");
  assert.match(rendered, /write failed/);
});

test("Escape returns from subviews and closes settings", async () => {
  const { picker, dones } = setup();
  await openModels(picker);
  await press(picker, KEY.escape);
  assert.equal(picker.screen, "settings");
  assert.equal(dones.length, 0);
  picker.handleInput(KEY.escape);
  await picker.flush();
  await tick();
  assert.equal(dones.length, 1);
});

test("rendering stays within width and height on all screens", async () => {
  const { picker } = setup({ config: allowedReasoner() });
  const widths = [1, 2, 4, 8, 15, 30, 60, 120];
  const check = (label: string) => {
    for (const width of widths) {
      const lines = picker.render(width);
      assert.ok(
        lines.length <= 20,
        `${label}: height ${lines.length} exceeds bound`,
      );
      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `${label}: width ${width} overflowed: ${JSON.stringify(line)}`,
        );
      }
    }
  };
  check("settings");
  await openModels(picker);
  check("models");
  await press(picker, KEY.right);
  check("reasoning");
});

test("short terminals keep the focused row and Escape hint visible", async () => {
  const { picker, tui } = setup({ config: allowedReasoner() });
  for (const rows of [24, 20, 16, 14, 12]) {
    tui.terminal.rows = rows;
    picker.invalidate();
    const lines = picker.render(100);
    assert.ok(
      lines.length <= Math.max(6, rows - 2),
      `rows=${rows}: rendered ${lines.length} lines`,
    );
    const text = lines.join("\n");
    assert.match(text, /Enabled/, `rows=${rows}: settings rows`);
    assert.match(text, /Esc close/, `rows=${rows}: settings help`);
  }

  await openModels(picker);
  for (const rows of [24, 20, 16, 14, 12]) {
    tui.terminal.rows = rows;
    picker.invalidate();
    const lines = picker.render(100);
    assert.ok(
      lines.length <= Math.max(6, rows - 2),
      `rows=${rows}: rendered ${lines.length} lines`,
    );
    const text = lines.join("\n");
    assert.match(text, /→ \[x\] fake\/reasoner/, `rows=${rows}: selected row`);
    assert.match(text, /Esc back/, `rows=${rows}: model help`);
  }
});

test("the popup draws a box whose side borders join the top and bottom edges", async () => {
  const { picker } = setup({ config: allowedReasoner() });
  const check = (label: string, width: number) => {
    const lines = picker.render(width);
    assert.equal(visibleWidth(lines[0]), width, `${label} ${width}: top edge`);
    assert.equal(
      visibleWidth(lines.at(-1)!),
      width,
      `${label} ${width}: bottom edge`,
    );
    assert.match(lines[0], /^┌─+┐$/, `${label} ${width}: top corners`);
    assert.match(lines.at(-1)!, /^└─+┘$/, `${label} ${width}: bottom corners`);
    for (const [index, line] of lines.entries()) {
      assert.equal(
        visibleWidth(line),
        width,
        `${label} ${width}: line ${index} width`,
      );
      if (index === 0 || index === lines.length - 1) continue;
      assert.ok(
        line.startsWith("│"),
        `${label} ${width}: line ${index} left border`,
      );
      assert.ok(
        line.endsWith("│"),
        `${label} ${width}: line ${index} right border`,
      );
    }
  };
  for (const width of [8, 15, 30, 60, 120]) check("settings", width);
  await openModels(picker);
  for (const width of [8, 15, 30, 60, 120]) check("models", width);
  await press(picker, KEY.right);
  for (const width of [8, 15, 30, 60, 120]) check("reasoning", width);
});

test("the model search has no placeholder and uses the default prompt", async () => {
  const { picker } = setup();
  await openModels(picker);
  const lines = picker.render(60);
  const text = lines.join("\n");
  assert.doesNotMatch(text, /Search models/);
  assert.doesNotMatch(text, /placeholder/i);
  assert.ok(
    lines.some((line) => line.includes("│ > ")),
    'search row uses Pi\'s default "> " prompt',
  );
  // Typing still filters the list as before.
  await press(picker, "r");
  assert.equal(picker.query, "r");
});

test("the model list shows more rows and spacing than the old eight-row cap", async () => {
  const models = Array.from({ length: 20 }, (_, index) =>
    model(`m${index}`, true, `m${index}`, REASONER_MAP),
  );
  const { picker } = setup({ models, rows: 40 });
  await openModels(picker);
  const lines = picker.render(80);
  const visible = lines.filter((line) =>
    /\[\s*\] fake\/m\d+/.test(line),
  ).length;
  assert.ok(visible > 8, `expected more than 8 visible models, saw ${visible}`);
  assert.ok(
    visible >= 10,
    `expected at least 10 visible models, saw ${visible}`,
  );
  const searchIndex = lines.findIndex((line) => line.includes("│ > "));
  assert.ok(searchIndex >= 0, "search row present");
  assert.match(lines[searchIndex + 1], /^│\s+│$/, "blank line after search");
});

test("focused search keeps the cursor marker inside the framed line", async () => {
  const { picker } = setup();
  await openModels(picker);
  picker.focused = true;
  const width = 60;
  const lines = picker.render(width);
  assert.ok(
    lines.some((line) => line.includes(CURSOR_MARKER)),
    "cursor marker must survive framing",
  );
  for (const line of lines) {
    assert.equal(visibleWidth(line), width);
  }
  picker.focused = false;
});

test("borders and content stay aligned across terminal resizes", async () => {
  const { picker, tui } = setup({ config: allowedReasoner() });
  await openModels(picker);
  const sizes: Array<[number, number]> = [
    [40, 120],
    [24, 80],
    [16, 60],
    [12, 44],
    [8, 30],
  ];
  for (const [rows, width] of sizes) {
    tui.terminal.rows = rows;
    picker.invalidate();
    const lines = picker.render(width);
    assert.ok(
      lines.length <= Math.max(6, rows - 2),
      `rows=${rows}: rendered ${lines.length} lines`,
    );
    assert.match(lines[0], /^┌─+┐$/, `rows=${rows}: top edge`);
    assert.match(lines.at(-1)!, /^└─+┘$/, `rows=${rows}: bottom edge`);
    for (const [index, line] of lines.entries()) {
      assert.equal(
        visibleWidth(line),
        width,
        `rows=${rows} width=${width}: line ${index}`,
      );
    }
    const text = lines.join("\n");
    assert.match(text, /Esc back/, `rows=${rows}: help line`);
    assert.match(text, /→ \[x\] fake\/reasoner/, `rows=${rows}: selected row`);
  }
});

test("tiny settings view keeps the selected row, help, and box within the overlay", async () => {
  const { picker } = setup({ rows: 8 });
  for (const label of ["Enabled", "Max active", "Default model", "Models"]) {
    const lines = picker.render(30);
    assert.ok(lines.length <= 6, "leave room for the overlay margins");
    assert.match(lines[0], /^┌─+┐$/);
    assert.match(lines.at(-1)!, /^└─+┘$/);
    assert.ok(lines.some((line) => line.includes(`→ ${label}`)));
    assert.match(lines.join("\n"), /Esc close/);
    await press(picker, KEY.down);
  }
});

test("search text and errors are sanitized before rendering", async () => {
  const { picker } = setup({
    config: {
      allowedModels: ["fake/reasoner"],
      modelReasoning: { "fake/reasoner": { allowed: ["low"] } },
    },
    onChange: async () => {
      throw new Error("bad\u001b[31m write\nnext line");
    },
  });
  await press(picker, KEY.space);
  const rendered = picker.render(80).join("\n");
  assert.match(rendered, /bad.*write next line/);
  assert.doesNotMatch(rendered, /\u001b\[31m/);
  assert.ok(!rendered.includes("\nnext line"));
});

test("canonicalization clears an invalid default after capability shrinkage", async () => {
  const { picker, changes } = setupValidated({
    config: {
      enabled: false,
      allowedModels: ["fake/reasoner"],
      modelReasoning: {
        "fake/reasoner": { allowed: ["low", "max"], default: "max" },
      },
    },
  });
  // An unrelated edit (maxActive) must still persist after the catalog shrank.
  await pressValidated(picker, KEY.down);
  await pressValidated(picker, KEY.right);
  assert.equal(changes.length, 1);
  const saved = changes[0];
  assert.equal(saved.maxActive, 5);
  assert.deepEqual(saved.modelReasoning["fake/reasoner"].allowed, ["low"]);
  assert.equal(saved.modelReasoning["fake/reasoner"].default, undefined);
  assert.deepEqual(picker.config.modelReasoning["fake/reasoner"].allowed, [
    "low",
  ]);
  assert.equal(
    picker.config.modelReasoning["fake/reasoner"].default,
    undefined,
  );
});

test("enabled config can be disabled despite an unsupported-only policy", async () => {
  const { picker, changes } = setupValidated({
    config: {
      enabled: true,
      allowedModels: ["fake/reasoner"],
      modelReasoning: { "fake/reasoner": { allowed: ["max"], default: "max" } },
    },
  });
  await pressValidated(picker, KEY.space);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].enabled, false);
  assert.deepEqual(changes[0].allowedModels, []);
  assert.deepEqual(changes[0].modelReasoning, {});
  assert.equal(picker.config.enabled, false);
});

test("capability pruning of the last model cannot persist enabled with no model", async () => {
  const { picker, changes } = setupValidated({
    config: {
      enabled: true,
      allowedModels: ["fake/reasoner"],
      modelReasoning: { "fake/reasoner": { allowed: ["max"], default: "max" } },
    },
  });
  await pressValidated(picker, KEY.down);
  await pressValidated(picker, KEY.right);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].enabled, false);
  assert.deepEqual(changes[0].allowedModels, []);
  assert.deepEqual(changes[0].modelReasoning, {});
  assert.equal(changes[0].maxActive, 5);
  assert.equal(picker.config.enabled, false);
});

test("enabling an initially empty config still reports the validation error", async () => {
  const { picker, changes } = setupValidated({
    config: { enabled: false, allowedModels: [], modelReasoning: {} },
  });
  await pressValidated(picker, KEY.space);
  assert.equal(changes.length, 0);
  assert.equal(picker.config.enabled, false);
  assert.match(
    picker.render(100).join("\n"),
    /allowed model and reasoning level/,
  );
});
