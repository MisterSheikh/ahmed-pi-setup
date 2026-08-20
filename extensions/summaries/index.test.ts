import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import summariesExtension, { hasSuccessfulRecap } from "./index.ts";

test("registers only the recap renderer, command, and bounded lifecycle hooks", () => {
  const events = new Set<string>();
  const renderers = new Set<string>();
  const commands = new Set<string>();
  const api = {
    on: (event: string) => events.add(event),
    registerEntryRenderer: (customType: string) => renderers.add(customType),
    registerCommand: (name: string) => commands.add(name),
  } as unknown as ExtensionAPI;

  summariesExtension(api);

  assert.deepEqual(
    events,
    new Set([
      "session_start",
      "before_agent_start",
      "agent_settled",
      "session_shutdown",
    ]),
  );
  assert.deepEqual(renderers, new Set(["summary-recap"]));
  assert.deepEqual(commands, new Set(["recap", "summary-model"]));
});

test("only a generated recap counts as successful for its run", () => {
  const recap = (
    id: string,
    runEndLeafId: string,
    fallback?: boolean,
  ): SessionEntry => ({
    type: "custom",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    customType: "summary-recap",
    data: { runEndLeafId, fallback },
  });
  const branch = [recap("fallback", "run-a", true), recap("success", "run-b")];

  assert.equal(hasSuccessfulRecap(branch, "run-a"), false);
  assert.equal(hasSuccessfulRecap(branch, "run-b"), true);
  assert.equal(hasSuccessfulRecap(branch, "missing"), false);
});
