import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  defaultExportPath,
  resolveExportPath,
  saveSharedContext,
} from "./src/save.ts";

test("builds a timestamped default Markdown path", () => {
  assert.equal(
    defaultExportPath("/work", new Date(2026, 3, 1, 14, 30, 9)),
    join("/work", "pi-context-20260401-143009.md"),
  );
});

test("resolves relative paths and rejects multiline paths", () => {
  assert.equal(
    resolveExportPath("notes/context.md", "/work"),
    "/work/notes/context.md",
  );
  assert.throws(() => resolveExportPath("a\nb.md", "/work"), /one line/);
  assert.throws(
    () => resolveExportPath("~someone/file", "/work"),
    /not supported/,
  );
});

test("creates exclusively and overwrites only when requested", async () => {
  const dir = await mkdtemp(join(tmpdir(), "context-share-"));
  const path = join(dir, "context.md");
  try {
    await saveSharedContext(path, "first\n");
    await assert.rejects(saveSharedContext(path, "second\n"), {
      code: "EEXIST",
    });
    assert.equal(await readFile(path, "utf8"), "first\n");

    await saveSharedContext(path, "second\n", true);
    assert.equal(await readFile(path, "utf8"), "second\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
