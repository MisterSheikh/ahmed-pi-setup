import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const oldSource = path.join(repo, "extensions/subagents");
const newSource = path.join(repo, "extensions/subagents-v2");
const toolNames = [
  "subagent_spawn",
  "subagent_followup",
  "subagent_steer",
  "subagent_interrupt",
  "subagent_wait",
  "subagent_list",
];

async function fixture(
  run: (dir: string, command: (name: string) => void) => Promise<void> | void,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-v2-adoption-"));
  const originalDir = process.env.PI_CODING_AGENT_DIR;
  const originalOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_OFFLINE = "1";
  fs.mkdirSync(path.join(dir, "extensions"));
  const command = (name: string) => {
    execFileSync("sh", [path.join(repo, "scripts", `${name}.sh`)], {
      env: { ...process.env, PI_CODING_AGENT_DIR: dir },
      stdio: "pipe",
    });
  };
  try {
    await run(dir, command);
  } finally {
    if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalDir;
    if (originalOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = originalOffline;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertOnlyV2(loader: DefaultResourceLoader) {
  const { extensions, errors } = loader.getExtensions();
  assert.deepEqual(errors, []);
  const providers = extensions.filter((extension) =>
    extension.tools.has("subagent_spawn"),
  );
  assert.equal(
    providers.length,
    1,
    "exactly one extension may own subagent tools",
  );
  assert.match(providers[0]!.resolvedPath, /subagents-v2/);
  assert.deepEqual(
    [...providers[0]!.tools.keys()].sort(),
    [...toolNames].sort(),
  );
  assert.deepEqual(
    [...providers[0]!.messageRenderers.keys()].sort(),
    ["subagents-v2-fyi", "subagents-v2-results"],
    "both incoming message renderers must be registered",
  );
  const commandOwners = extensions.filter(
    (extension) =>
      extension.commands.has("subagents") ||
      extension.commands.has("subagent-config"),
  );
  assert.equal(commandOwners.length, 1, "one extension owns the commands");
  assert.ok(commandOwners[0]!.commands.has("subagents"));
  assert.ok(
    commandOwners[0]!.commands.has("subagent-config"),
    "/subagent-config must be discoverable alongside /subagents",
  );
}

test("link adoption and SDK reload discover only V2, disabled by default, without migrating sessions", async () => {
  await fixture(async (dir, command) => {
    const oldLink = path.join(dir, "extensions/subagents");
    const newLink = path.join(dir, "extensions/subagents-v2");
    fs.symlinkSync(oldSource, oldLink);
    const legacySession = path.join(dir, "sessions/legacy.jsonl");
    fs.mkdirSync(path.dirname(legacySession));
    fs.writeFileSync(legacySession, "legacy session stays untouched\n");
    command("link");
    assert.equal(fs.existsSync(oldLink), false);
    assert.equal(fs.readlinkSync(newLink), newSource);
    command("link");
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      noSkills: true,
      noThemes: true,
      noContextFiles: true,
      noPromptTemplates: true,
    });
    await loader.reload();
    assertOnlyV2(loader);
    const { session } = await createAgentSession({
      cwd: dir,
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(dir),
    });
    const extensionErrors: string[] = [];
    try {
      // reload emits session_start only when host bindings exist, as they do
      // in interactive Pi. A diagnostic listener supplies that SDK binding.
      await session.bindExtensions({
        mode: "print",
        onError: (error) => {
          extensionErrors.push(error.error);
        },
      });
      const prompt = await session.extensionRunner.emitBeforeAgentStart(
        "No inference",
        undefined,
        {
          cwd: dir,
          sections: { existing: "Preserve other extensions' instructions." },
        },
      );
      assert.equal(
        prompt.systemPromptOptions.sections.subagent_configuration,
        "Subagent delegation is disabled.",
      );
      assert.equal(
        prompt.systemPromptOptions.sections.existing,
        "Preserve other extensions' instructions.",
      );
      assert.equal(prompt.systemPromptOptions.forceSystemPrompt, undefined);
      assert.ok(session.getToolDefinition("subagent_followup"));
      assert.ok(!session.getActiveToolNames().includes("subagent_spawn"));
      await session.reload();
      assertOnlyV2(loader);
      assert.ok(session.getToolDefinition("subagent_interrupt"));
      assert.ok(!session.getActiveToolNames().includes("subagent_spawn"));
      assert.deepEqual(extensionErrors, []);
      assert.equal(
        fs.existsSync(path.join(dir, "subagents-v2/config.json")),
        false,
      );
    } finally {
      try {
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
      } finally {
        session.dispose();
      }
    }
    command("unlink");
    command("unlink");
    assert.equal(fs.existsSync(newLink), false);
    assert.equal(
      fs.readFileSync(legacySession, "utf8"),
      "legacy session stays untouched\n",
    );
    assert.ok(fs.existsSync(path.join(oldSource, "index.ts")));
  });
});

test("both scripts refuse unrelated legacy paths without installing V2", async () => {
  for (const kind of ["file", "directory", "symlink"]) {
    await fixture((dir, command) => {
      const legacy = path.join(dir, "extensions/subagents");
      if (kind === "file") fs.writeFileSync(legacy, "keep me");
      else if (kind === "directory") fs.mkdirSync(legacy);
      else fs.symlinkSync(dir, legacy);
      assert.throws(() => command("link"));
      assert.throws(() => command("unlink"));
      assert.ok(fs.lstatSync(legacy));
      assert.equal(
        fs.existsSync(path.join(dir, "extensions/subagents-v2")),
        false,
      );
      assert.equal(fs.existsSync(path.join(dir, "AGENTS.md")), false);
    });
  }
});

test("failed V2 preflight leaves the owned legacy link intact", async () => {
  await fixture((dir, command) => {
    const legacy = path.join(dir, "extensions/subagents");
    const current = path.join(dir, "extensions/subagents-v2");
    fs.symlinkSync(oldSource, legacy);
    fs.symlinkSync(dir, current);
    assert.throws(() => command("link"));
    assert.throws(() => command("unlink"));
    assert.equal(fs.readlinkSync(legacy), oldSource);
    assert.equal(fs.readlinkSync(current), dir);
  });
});

test("active skill documents V2 tools and explicit configuration rather than legacy aliases", () => {
  const skill = fs.readFileSync(
    path.join(repo, "skills/subagents/SKILL.md"),
    "utf8",
  );
  for (const name of [...toolNames, "subagent_report"])
    assert.ok(skill.includes(name));
  assert.doesNotMatch(skill, /subagent_check|subagent_cancel|reasoning_effort/);
  assert.match(skill, /Delegation starts disabled/);
  assert.match(skill, /never inherit/);
  assert.match(skill, /selected model's own configured default/);
});
