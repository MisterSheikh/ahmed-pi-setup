import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DefaultResourceLoader,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ENABLED_BACKEND_NAMES } from "./src/domain.ts";
import { MAX_RUNNING, SubagentManager } from "./src/manager.ts";
import {
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
} from "./src/prompt.ts";
import { createSubagentRuntime, runTool } from "./src/runtime.ts";

test("only Pi and Codex are enabled; concurrency stays at four", () => {
  assert.deepEqual(ENABLED_BACKEND_NAMES, ["pi", "codex"]);
  assert.equal(MAX_RUNNING, 4);
});

test("registered spawn schema exposes only enabled backends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-schema-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [
        fileURLToPath(new URL("./index.ts", import.meta.url)),
      ],
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
      noPromptTemplates: true,
    });
    await loader.reload();
    const { extensions, errors } = loader.getExtensions();
    assert.deepEqual(errors, []);
    const tool = extensions
      .flatMap((extension) => [...extension.tools.values()])
      .find((tool) => tool.definition.name === "subagent_spawn");
    assert.ok(tool);
    const schema = tool.definition.parameters;
    assert.ok("properties" in schema);
    const properties = schema.properties;
    assert.ok(
      properties && typeof properties === "object" && "harness" in properties,
    );
    const harness = properties.harness;
    assert.ok(harness && typeof harness === "object" && "enum" in harness);
    assert.deepEqual(harness.enum, ["pi", "codex"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("production runtime rejects Claude without starting a child", async () => {
  const runtime = createSubagentRuntime();
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("claude", {
          prompt: "Must not run",
          title: "disabled backend",
          cwd: process.cwd(),
          parent: { parentCwd: process.cwd(), projectTrusted: false },
        }),
      ),
      /Unknown backend "claude"/,
    );
    assert.deepEqual(manager.view.list(), []);
  } finally {
    await runtime.dispose();
  }
});

test("legacy skill and tool guidance recommend DeepSeek without advertising Claude or GLM", async () => {
  const skill = await readFile(
    new URL("./SKILL.legacy.md", import.meta.url),
    "utf8",
  );
  const prompt = [
    SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    SUBAGENT_SPAWN_PROMPT_SNIPPET,
    ...SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    ...Object.values(SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS),
  ].join("\n");
  for (const text of [skill, prompt]) {
    assert.match(text, /opencode-go\/deepseek-v4\.1-flash/);
    assert.doesNotMatch(text, /claude|glm|fable/i);
    assert.match(text, /high.*max/);
    assert.match(text, /inherit/i);
  }
});
