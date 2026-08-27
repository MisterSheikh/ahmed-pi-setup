import assert from "node:assert/strict";
import test from "node:test";
import {
  initTheme,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { parseRoadmap } from "./src/roadmap.ts";
import { showRoadmapOverlay, widgetText } from "./src/ui.ts";

test("widget text shows project progress, stage, focus, and next item", () => {
  const roadmap = parseRoadmap(
    `# Example project

## Current focus
Build the simulator.

## Simulation
- [x] Map abilities
- [ ] Implement combat
`,
    "fallback",
  );

  assert.deepEqual(widgetText(roadmap), [
    "◆ Roadmap · Example project · 1/2 done",
    "Stage 1/1: Simulation · Focus: Build the simulator. · Next open: Implement combat",
  ]);
});

test("widget text clearly reports a completed roadmap", () => {
  const roadmap = parseRoadmap(
    `# Complete

## Work
- [x] Finished
`,
    "fallback",
  );

  assert.deepEqual(widgetText(roadmap), [
    "◆ Roadmap · Complete · 1/1 done",
    "✓ All tracked items complete",
  ]);
});

test("the roadmap overlay bounds and scrolls long content", async () => {
  initTheme("dark", false);
  const tasks = Array.from(
    { length: 40 },
    (_, index) => `- [ ] Task ${index + 1}`,
  ).join("\n");
  const roadmap = parseRoadmap(
    `# Long roadmap\n\n## Work\n${tasks}\n`,
    "fallback",
  );
  let overlay: (Component & { handleInput(data: string): void }) | undefined;
  let renders = 0;
  const tui = {
    terminal: { rows: 24, columns: 80 },
    requestRender: () => {
      renders += 1;
    },
  } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const ctx = {
    ui: {
      custom: async (factory: (...args: never[]) => Component) => {
        overlay = factory(
          tui as never,
          theme as never,
          undefined as never,
          (() => undefined) as never,
        ) as Component & { handleInput(data: string): void };
      },
    },
  } as unknown as ExtensionCommandContext;

  await showRoadmapOverlay(ctx, roadmap);
  assert.ok(overlay);
  const first = overlay.render(68);
  assert.ok(first.length <= 20);
  assert.ok(first.some((line) => line.includes("Task 1")));
  assert.ok(first.every((line) => !line.includes("Task 40")));

  overlay.handleInput("\u001b[F");
  const last = overlay.render(68);
  assert.ok(last.some((line) => line.includes("Task 40")));
  assert.ok(renders > 0);
});
