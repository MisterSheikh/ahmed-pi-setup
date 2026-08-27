import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRoadmap,
  roadmapDisplayMarkdown,
  roadmapStageLabel,
} from "./src/roadmap.ts";

test("parses stages, focus, nested tasks, and current progress", () => {
  const roadmap = parseRoadmap(
    `# RS3 Ability Optimizer

## Current focus

Implement the basic combat simulation.

## 1. Combat simulation

- [x] Map abilities
- [ ] Implement all styles
  - [x] Melee
  - [ ] Magic

## 2. Gear integration

- [ ] Model equipment
`,
    "fallback",
  );

  assert.equal(roadmap.title, "RS3 Ability Optimizer");
  assert.equal(roadmap.currentFocus, "Implement the basic combat simulation.");
  assert.equal(roadmap.totalTasks, 5);
  assert.equal(roadmap.completedTasks, 2);
  assert.equal(roadmap.currentStageIndex, 0);
  assert.equal(roadmap.nextOpenItem, "Implement all styles");
  assert.equal(roadmap.stages[0]?.status, "current");
  assert.equal(roadmap.stages[1]?.status, "upcoming");
  assert.equal(roadmapStageLabel(roadmap), "Stage 1/2: Combat simulation");
});

test("handles CommonMark fence, heading, and ordered-task forms", () => {
  const roadmap = parseRoadmap(
    `# Real title

\`\`\`markdown
## Fake stage
- [ ] Fake task
\`\`\`

    \`\`\` this is indented code, not a fence

   ## Real stage
1. [x] First real task
2) [ ] Second real task
`,
    "fallback",
  );

  assert.equal(roadmap.stages.length, 1);
  assert.equal(roadmap.totalTasks, 2);
  assert.equal(roadmap.completedTasks, 1);
  assert.equal(roadmap.complete, false);
  assert.equal(roadmap.stages[0]?.status, "current");
  assert.equal(roadmap.nextOpenItem, "Second real task");
});

test("uses a fallback title and keeps stages without tasks untracked", () => {
  const roadmap = parseRoadmap(
    `## Background
Some useful prose.

## Work
- [ ] Start here
`,
    "sample-project",
  );

  assert.equal(roadmap.title, "sample-project");
  assert.equal(roadmap.stages[0]?.status, "untracked");
  assert.equal(roadmap.stages[1]?.status, "current");
  assert.equal(roadmap.currentStageIndex, 1);
});

test("marks every tracked stage complete when all checkboxes are checked", () => {
  const roadmap = parseRoadmap(
    `# Complete project

## First
- [x] One

## Second
- [X] Two
`,
    "fallback",
  );

  assert.equal(roadmap.complete, true);
  assert.equal(roadmap.currentStageIndex, undefined);
  assert.equal(roadmap.nextOpenItem, undefined);
  assert.equal(roadmapStageLabel(roadmap), "Complete");
});

test("decorates stage headings without changing current-focus content", () => {
  const roadmap = parseRoadmap(
    `# Project

## Current focus
Stay focused.

## Done
- [x] Finished

## Active
- [ ] Working

## Later
- [ ] Waiting

## Notes
No checkboxes.
`,
    "fallback",
  );
  const display = roadmapDisplayMarkdown(roadmap);

  assert.match(display, /## Current focus/);
  assert.match(display, /## ✓ Done/);
  assert.match(display, /## ◆ Active/);
  assert.match(display, /## ○ Later/);
  assert.match(display, /## – Notes/);
});
