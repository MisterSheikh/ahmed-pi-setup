import assert from "node:assert/strict";
import test from "node:test";
import {
  createInitialSelection,
  moveCursor,
  parseShareArguments,
  selectionBounds,
  selectionCount,
  setAnchorAtCursor,
} from "./src/selection.ts";

test("parses defaults, counts, and skipped recent messages", () => {
  assert.deepEqual(parseShareArguments(""), { count: 4, skip: 0 });
  assert.deepEqual(parseShareArguments("6"), { count: 6, skip: 0 });
  assert.deepEqual(parseShareArguments("6 --skip 2"), { count: 6, skip: 2 });
  assert.deepEqual(parseShareArguments("--skip 2 6"), { count: 6, skip: 2 });
});

test("rejects invalid share arguments", () => {
  assert.throws(() => parseShareArguments("0"), /positive integer/);
  assert.throws(() => parseShareArguments("4 --skip -1"), /non-negative/);
  assert.throws(
    () => parseShareArguments("4 --skip 1 --skip 2"),
    /only be provided once/,
  );
  assert.throws(() => parseShareArguments("4 extra"), /Unknown argument/);
  assert.throws(() => parseShareArguments("4 5"), /Unknown argument/);
});

test("initial selection counts backward after the skipped tail", () => {
  assert.deepEqual(createInitialSelection(12, 6, 2), {
    anchor: 9,
    cursor: 4,
  });
  assert.deepEqual(createInitialSelection(3, 8, 0), {
    anchor: 2,
    cursor: 0,
  });
  assert.equal(createInitialSelection(3, 2, 3), undefined);
});

test("selection bounds are inclusive and independent of direction", () => {
  assert.deepEqual(selectionBounds({ anchor: 8, cursor: 3 }), {
    start: 3,
    end: 8,
  });
  assert.deepEqual(selectionBounds({ anchor: 3, cursor: 8 }), {
    start: 3,
    end: 8,
  });
  assert.equal(selectionCount({ anchor: 8, cursor: 3 }), 6);
});

test("cursor movement clamps and resetting the anchor collapses the range", () => {
  assert.deepEqual(moveCursor({ anchor: 3, cursor: 3 }, -10, 8), {
    anchor: 3,
    cursor: 0,
  });
  assert.deepEqual(moveCursor({ anchor: 3, cursor: 3 }, 10, 8), {
    anchor: 3,
    cursor: 7,
  });
  assert.deepEqual(setAnchorAtCursor({ anchor: 7, cursor: 2 }), {
    anchor: 2,
    cursor: 2,
  });
});
