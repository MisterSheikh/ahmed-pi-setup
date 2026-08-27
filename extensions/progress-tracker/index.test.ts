import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import progressTracker from "./index.ts";

test("registers only the progress command and lifecycle hooks", () => {
  const events = new Set<string>();
  const commands = new Set<string>();
  let tools = 0;
  let renderers = 0;
  const api = {
    on: (event: string) => events.add(event),
    registerCommand: (name: string) => commands.add(name),
    registerTool: () => {
      tools += 1;
    },
    registerEntryRenderer: () => {
      renderers += 1;
    },
  } as unknown as ExtensionAPI;

  progressTracker(api);

  assert.deepEqual(
    events,
    new Set(["session_start", "agent_settled", "session_shutdown"]),
  );
  assert.deepEqual(commands, new Set(["progress"]));
  assert.equal(tools, 0);
  assert.equal(renderers, 0);
});

test("/progress track selects and loads a project roadmap", async () => {
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => Promise<void>
  >();
  let progressCommand:
    ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const api = {
    on: (
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => Promise<void>,
    ) => handlers.set(event, handler),
    registerCommand: (
      name: string,
      options: {
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
      },
    ) => {
      if (name === "progress") progressCommand = options.handler;
    },
  } as unknown as ExtensionAPI;
  progressTracker(api);

  const project = await mkdtemp(join(tmpdir(), "pi-progress-track-"));
  await mkdir(join(project, ".git"));
  await mkdir(join(project, "docs"));
  await writeFile(
    join(project, "docs", "implementation plan.md"),
    "# Project\n\n## Work\n- [ ] Task\n",
  );
  const notifications: Array<[string, string]> = [];
  const ctx = {
    mode: "tui",
    cwd: project,
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      setWidget: () => undefined,
      notify: (message: string, level: string) =>
        notifications.push([message, level]),
    },
  } as unknown as ExtensionCommandContext;

  try {
    await handlers.get("session_start")?.({}, ctx);
    assert.ok(progressCommand);
    await progressCommand('track "docs/implementation plan.md"', ctx);
    assert.equal(
      await readFile(join(project, ".pi", "progress.json"), "utf8"),
      '{\n  "path": "docs/implementation plan.md"\n}\n',
    );
    assert.deepEqual(notifications.at(-1), [
      "Now tracking docs/implementation plan.md.",
      "info",
    ]);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test("a failed refresh removes the previous roadmap widget", async () => {
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => Promise<void>
  >();
  const api = {
    on: (
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => Promise<void>,
    ) => handlers.set(event, handler),
    registerCommand: () => undefined,
  } as unknown as ExtensionAPI;
  progressTracker(api);

  const project = await mkdtemp(join(tmpdir(), "pi-progress-index-"));
  await mkdir(join(project, ".git"));
  await writeFile(
    join(project, "ROADMAP.md"),
    "# Project\n\n## Work\n- [ ] Task\n",
  );
  const widgetValues: unknown[] = [];
  const ctx = {
    mode: "tui",
    cwd: project,
    isProjectTrusted: () => true,
    ui: {
      setWidget: (_key: string, content: unknown) => widgetValues.push(content),
    },
  } as unknown as ExtensionContext;

  try {
    await handlers.get("session_start")?.({}, ctx);
    assert.notEqual(widgetValues.at(-1), undefined);

    await rm(join(project, "ROADMAP.md"));
    await mkdir(join(project, "ROADMAP.md"));
    await handlers.get("agent_settled")?.({}, ctx);
    assert.equal(widgetValues.at(-1), undefined);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
