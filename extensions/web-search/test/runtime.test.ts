import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { codexHeaders } from "../src/codex.ts";

// Optional path selects the installed host SDK rather than repository dev deps.
// All auth and catalog stores below are in memory; no real tokens are read.
const sdkUrl = process.env.PI_WEB_TEST_SDK
  ? pathToFileURL(process.env.PI_WEB_TEST_SDK).href
  : import.meta.resolve("@earendil-works/pi-coding-agent");

test("real Pi ModelRegistry delegates concurrent OAuth refresh to ModelRuntime", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Live network forbidden in this test");
  };
  try {
    const { ModelRuntime, ModelRegistry } = await import(sdkUrl);
    const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
    const store = new InMemoryCredentialStore();
    const access = (account: string) =>
      `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.test`;
    const runtime = await ModelRuntime.create({
      credentials: store,
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const provider = runtime.getProvider("openai-codex");
    let refreshes = 0;
    runtime.registerNativeProvider({
      ...provider,
      auth: {
        oauth: {
          name: "Mock OAuth",
          async login() {
            throw new Error("Must not login");
          },
          async refresh(credential: { refresh: string }, signal: AbortSignal) {
            assert.equal(credential.refresh, "synthetic-old-refresh");
            assert.equal(signal.aborted, false);
            refreshes++;
            await new Promise((resolve) => setImmediate(resolve));
            return {
              type: "oauth",
              access: access("refreshed-account"),
              refresh: "synthetic-rotated-refresh",
              expires: Date.now() + 3600_000,
            };
          },
          async toAuth(credential: { access: string }) {
            return { apiKey: credential.access };
          },
        },
      },
    });
    await store.modify("openai-codex", async () => ({
      type: "oauth",
      access: access("old-account"),
      refresh: "synthetic-old-refresh",
      expires: 0,
    }));
    const registry = new ModelRegistry(runtime);
    const signal = new AbortController().signal;
    const responses = await Promise.all([
      codexHeaders(registry, signal),
      codexHeaders(registry, signal),
    ]);
    assert.equal(refreshes, 1);
    assert.equal(responses[0]!["chatgpt-account-id"], "refreshed-account");
    assert.deepEqual(responses[0], responses[1]);
    const saved = await store.read("openai-codex");
    assert.ok(saved?.type === "oauth");
    assert.equal(saved.refresh, "synthetic-rotated-refresh");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
