import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import registerContextShare from "./index.ts";

type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => Promise<void> | void;

function registeredHandler() {
  let name = "";
  let handler: CommandHandler | undefined;
  const pi = {
    registerCommand(commandName: string, options: { handler: CommandHandler }) {
      name = commandName;
      handler = options.handler;
    },
  } as unknown as ExtensionAPI;
  registerContextShare(pi);
  assert.equal(name, "excerpt");
  assert.ok(handler);
  return handler;
}

function branch(): SessionEntry[] {
  return [
    {
      type: "message",
      id: "user",
      parentId: null,
      timestamp: "2026-04-01T10:00:00.000Z",
      message: { role: "user", content: "Question", timestamp: 1 },
    },
    {
      type: "message",
      id: "agent",
      parentId: "user",
      timestamp: "2026-04-01T10:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Answer" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    },
  ];
}

function saveContext(outputPath: string, confirm = false) {
  const notifications: Array<{ message: string; type: string | undefined }> =
    [];
  let confirmations = 0;
  let pickerOpens = 0;
  const tui = {
    terminal: { rows: 24 },
    requestRender() {},
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const keybindings = {
    matches: () => false,
    getKeys: () => [],
  };
  const ui = {
    custom(factory: Function) {
      pickerOpens += 1;
      if (pickerOpens > 1) return Promise.resolve(null);
      return new Promise((resolve) => {
        const component = factory(tui, theme, keybindings, resolve);
        component.handleInput("s");
      });
    },
    input: async () => outputPath,
    confirm: async () => {
      confirmations += 1;
      return confirm;
    },
    notify(message: string, type?: string) {
      notifications.push({ message, type });
    },
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/unused",
    waitForIdle: async () => {},
    sessionManager: { getBranch: branch },
    ui,
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    notifications,
    confirmations: () => confirmations,
  };
}

test("registers /excerpt and saves the selected transcript", async () => {
  const dir = await mkdtemp(join(tmpdir(), "context-share-command-"));
  const outputPath = join(dir, "context.md");
  try {
    const { ctx, notifications } = saveContext(outputPath);
    await registeredHandler()("", ctx);

    assert.equal(
      await readFile(outputPath, "utf8"),
      "## User\n\nQuestion\n\n---\n\n## Agent\n\nAnswer\n",
    );
    assert.match(notifications.at(-1)?.message ?? "", /Saved 2 messages/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("requires confirmation before overwriting an existing export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "context-share-command-"));
  const outputPath = join(dir, "context.md");
  try {
    await writeFile(outputPath, "old");
    const declined = saveContext(outputPath, false);
    await registeredHandler()("", declined.ctx);
    assert.equal(await readFile(outputPath, "utf8"), "old");
    assert.equal(declined.confirmations(), 1);

    const accepted = saveContext(outputPath, true);
    await registeredHandler()("", accepted.ctx);
    assert.match(await readFile(outputPath, "utf8"), /## Agent\n\nAnswer/);
    assert.equal(accepted.confirmations(), 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reports invalid arguments before opening the selector", async () => {
  const notifications: string[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionCommandContext;

  await registeredHandler()("nope", ctx);
  assert.match(notifications[0] ?? "", /Usage: \/excerpt/);
});
