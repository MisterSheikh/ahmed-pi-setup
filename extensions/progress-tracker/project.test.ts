import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  findProjectRoot,
  loadRoadmapFile,
  setTrackedRoadmap,
} from "./src/project.ts";

async function withProject(
  run: (project: string) => Promise<void>,
  gitMarker: "directory" | "file" = "directory",
) {
  const parent = await mkdtemp(join(tmpdir(), "pi-progress-"));
  const project = join(parent, "project");
  await mkdir(project);
  if (gitMarker === "directory") await mkdir(join(project, ".git"));
  else await writeFile(join(project, ".git"), "gitdir: somewhere\n");
  try {
    await run(project);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

test("finds the enclosing Git project from a nested directory", async () => {
  await withProject(async (project) => {
    const nested = join(project, "src", "components");
    await mkdir(nested, { recursive: true });
    assert.equal(findProjectRoot(nested), project);
  });
});

test("recognizes a worktree .git file", async () => {
  await withProject(async (project) => {
    const nested = join(project, "src");
    await mkdir(nested);
    assert.equal(findProjectRoot(nested), project);
  }, "file");
});

test("loads ROADMAP.md by default", async () => {
  await withProject(async (project) => {
    await writeFile(join(project, "ROADMAP.md"), "# Default roadmap\n");
    const result = await loadRoadmapFile(project);
    assert.equal(result.status, "loaded");
    if (result.status !== "loaded") return;
    assert.equal(result.roadmapPath, join(project, "ROADMAP.md"));
    assert.equal(result.markdown, "# Default roadmap\n");
  });
});

test("loads a project-relative path from .pi/progress.json", async () => {
  await withProject(async (project) => {
    await mkdir(join(project, ".pi"));
    await mkdir(join(project, "docs"));
    await writeFile(
      join(project, ".pi", "progress.json"),
      JSON.stringify({ path: "docs/implementation-plan.md" }),
    );
    await writeFile(
      join(project, "docs", "implementation-plan.md"),
      "# Configured roadmap\n",
    );

    const result = await loadRoadmapFile(project);
    assert.equal(result.status, "loaded");
    if (result.status !== "loaded") return;
    assert.equal(
      result.roadmapPath,
      join(project, "docs", "implementation-plan.md"),
    );
  });
});

test("writes the tracked roadmap configuration", async () => {
  await withProject(async (project) => {
    await mkdir(join(project, "docs"));
    await writeFile(join(project, "docs", "release plan.md"), "# Release\n");

    const configured = await setTrackedRoadmap(project, "docs/release plan.md");
    assert.equal(configured.configuredPath, "docs/release plan.md");
    assert.equal(
      await readFile(join(project, ".pi", "progress.json"), "utf8"),
      '{\n  "path": "docs/release plan.md"\n}\n',
    );

    const loaded = await loadRoadmapFile(project);
    assert.equal(loaded.status, "loaded");
    if (loaded.status !== "loaded") return;
    assert.equal(loaded.roadmapPath, join(project, "docs", "release plan.md"));
  });
});

test("refuses to configure invalid tracked files", async () => {
  await withProject(async (project) => {
    await assert.rejects(
      setTrackedRoadmap(project, "../outside.md"),
      /inside the project/,
    );
    await assert.rejects(
      setTrackedRoadmap(project, "missing.md"),
      /does not exist/,
    );
  });
});

test("ignores project configuration when it is not allowed", async () => {
  await withProject(async (project) => {
    await mkdir(join(project, ".pi"));
    await writeFile(
      join(project, ".pi", "progress.json"),
      JSON.stringify({ path: "other.md" }),
    );
    await writeFile(join(project, "ROADMAP.md"), "# Default\n");
    await writeFile(join(project, "other.md"), "# Other\n");

    const result = await loadRoadmapFile(project, {
      allowProjectConfig: false,
    });
    assert.equal(result.status, "loaded");
    if (result.status !== "loaded") return;
    assert.equal(result.roadmapPath, join(project, "ROADMAP.md"));
  });
});

test("rejects configured paths outside the project", async () => {
  await withProject(async (project) => {
    await mkdir(join(project, ".pi"));
    await writeFile(
      join(project, ".pi", "progress.json"),
      JSON.stringify({ path: "../outside.md" }),
    );

    const result = await loadRoadmapFile(project);
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.match(result.message, /inside the project/);
  });
});

test("rejects configured symlinks that leave the project", async () => {
  await withProject(async (project) => {
    await mkdir(join(project, ".pi"));
    await mkdir(join(project, "docs"));
    const outside = join(project, "..", "outside.md");
    await writeFile(outside, "# Outside\n");
    await symlink(outside, join(project, "docs", "roadmap.md"));
    await writeFile(
      join(project, ".pi", "progress.json"),
      JSON.stringify({ path: "docs/roadmap.md" }),
    );

    const result = await loadRoadmapFile(project);
    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.match(result.message, /inside the project/);
  });
});

test("reports malformed configuration and missing roadmaps", async () => {
  await withProject(async (project) => {
    await mkdir(join(project, ".pi"));
    await writeFile(join(project, ".pi", "progress.json"), "not json");
    const malformed = await loadRoadmapFile(project);
    assert.equal(malformed.status, "error");

    await rm(join(project, ".pi", "progress.json"));
    const missing = await loadRoadmapFile(project);
    assert.equal(missing.status, "missing");
    assert.equal(missing.roadmapPath, join(project, "ROADMAP.md"));
  });
});
