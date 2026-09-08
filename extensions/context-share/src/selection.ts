export interface SelectionState {
  anchor: number;
  cursor: number;
}

export interface ShareArguments {
  count: number;
  skip: number;
}

export const DEFAULT_SELECTION_COUNT = 4;

export function parseShareArguments(args: string): ShareArguments {
  const tokens = args.trim() ? args.trim().split(/\s+/) : [];
  let count = DEFAULT_SELECTION_COUNT;
  let skip = 0;
  let sawCount = false;
  let sawSkip = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--skip") {
      if (sawSkip) throw new Error("--skip may only be provided once");
      const value = tokens[index + 1];
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error("--skip requires a non-negative integer");
      }
      skip = Number(value);
      sawSkip = true;
      index += 1;
      continue;
    }
    if (!sawCount && /^\d+$/.test(token)) {
      count = Number(token);
      sawCount = true;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Message count must be a positive integer");
  }
  if (!Number.isSafeInteger(skip) || skip < 0) {
    throw new Error("--skip requires a non-negative integer");
  }
  return { count, skip };
}

export function createInitialSelection(
  total: number,
  count: number,
  skip: number,
): SelectionState | undefined {
  if (total <= 0 || skip >= total) return undefined;
  const newest = total - skip - 1;
  const oldest = Math.max(0, newest - count + 1);
  return { anchor: newest, cursor: oldest };
}

export function selectionBounds(selection: SelectionState) {
  return {
    start: Math.min(selection.anchor, selection.cursor),
    end: Math.max(selection.anchor, selection.cursor),
  };
}

export function selectionCount(selection: SelectionState) {
  const { start, end } = selectionBounds(selection);
  return end - start + 1;
}

export function moveCursor(
  selection: SelectionState,
  delta: number,
  total: number,
): SelectionState {
  return {
    ...selection,
    cursor: Math.min(Math.max(0, selection.cursor + delta), total - 1),
  };
}

export function setAnchorAtCursor(selection: SelectionState): SelectionState {
  return { anchor: selection.cursor, cursor: selection.cursor };
}
