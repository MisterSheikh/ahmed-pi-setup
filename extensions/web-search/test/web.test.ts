import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import webSearch, { executeWeb } from "../index.ts";
import {
  boundOutput,
  OUTPUT_BYTES,
  OUTPUT_LINES,
  type WebBackend,
} from "../src/backend.ts";
import {
  CodexBackend,
  codexHeaders,
  ENDPOINT,
  MAX_OUTPUT_TOKENS,
  RESPONSE_BYTES,
  SEARCH_MODEL,
  type PiAuthRegistry,
} from "../src/codex.ts";
import { validateCommands, webSchema } from "../src/schema.ts";

// Synthetic unsigned token, never a credential from disk or the environment.
const token = (auth: unknown = { chatgpt_account_id: "test-account" }) =>
  `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": auth })).toString("base64url")}.test`;
const registry = (access = token()): PiAuthRegistry => ({
  async getProviderAuth(provider) {
    assert.equal(provider, "openai-codex");
    return {
      source: "OAuth",
      auth: {
        apiKey: access,
        baseUrl: "https://evil.invalid",
        headers: { "x-secret": "do-not-forward" },
      },
    };
  },
});
const commands = { search_query: [{ q: "test" }] };
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
const fetchMock = (
  handler: (
    url: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch => handler as typeof fetch;
const backend = (response: Response) =>
  new CodexBackend(
    registry(),
    fetchMock(async () => response),
  );
const run = (b: WebBackend) => executeWeb(commands, "session-a", b);

test("small strict schema and runtime validation", () => {
  assert.deepEqual(Object.keys(webSchema.properties), [
    "search_query",
    "open",
    "click",
    "find",
    "response_length",
  ]);
  for (const input of [
    null,
    {},
    { response_length: "long" },
    { search_query: [] },
    { search_query: [{ q: " " }] },
    { search_query: [{ q: "x", extra: true }] },
    { search_query: [{ q: "x", recency: -1 }] },
    { open: [{ ref_id: "x", lineno: 0.5 }] },
    { click: [{ ref_id: "x", id: -1 }] },
    { find: [{ ref_id: "x", pattern: "" }] },
    { ...commands, response_length: "huge" },
    { ...commands, finance: [] },
    { search_query: Array.from({ length: 5 }, () => ({ q: "x" })) },
    { search_query: [{ q: "x".repeat(2049) }] },
    { search_query: [{ q: "x", domains: Array(11).fill("example.com") }] },
    {
      open: Array(4).fill({ ref_id: "x" }),
      find: Array(4).fill({ ref_id: "x", pattern: "y" }),
      ...commands,
    },
  ])
    assert.throws(() => validateCommands(input), /web:/);
  const input = {
    search_query: [{ q: "x", recency: 0, domains: ["example.com"] }],
    open: [{ ref_id: "turn0search0", lineno: 0 }],
    click: [{ ref_id: "turn0view0", id: 0 }],
    find: [{ ref_id: "https://example.com", pattern: "word" }],
    response_length: "long",
  };
  assert.deepEqual(validateCommands(input), input);
  const copy = validateCommands(input);
  input.search_query[0]!.q = "changed";
  assert.equal(copy.search_query?.[0]?.q, "x");
});

test("exact fixed transport, no history, opaque results only in details", async () => {
  let calls = 0;
  const results = [{ future_field: { a: [1, "opaque"] } }];
  const b = new CodexBackend(
    registry(),
    fetchMock(async (url, init) => {
      calls++;
      assert.equal(url, ENDPOINT);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      assert.ok(init?.signal);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${token()}`);
      assert.equal(headers.get("chatgpt-account-id"), "test-account");
      assert.equal(headers.get("originator"), "omp");
      assert.equal(headers.get("version"), "0.153.0");
      assert.equal(headers.get("x-secret"), null);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        id: "session-a",
        model: SEARCH_MODEL,
        commands,
        settings: { allowed_callers: ["direct"], external_web_access: true },
        max_output_tokens: MAX_OUTPUT_TOKENS,
      });
      return json({
        output: "Source (https://example.com) 【turn0search0】",
        results,
        encrypted_output: "unused",
      });
    }),
  );
  const result = await run(b);
  assert.equal(calls, 1);
  assert.equal(
    result.content[0]?.text,
    "Source (https://example.com) 【turn0search0】",
  );
  assert.deepEqual(result.details.results, results);
  assert.equal(result.details.sessionId, "session-a");
  assert.ok(!JSON.stringify(result).includes("unused"));
});

test("auth is resolved per call, including refreshed routing claims", async () => {
  let count = 0;
  const r: PiAuthRegistry = {
    async getProviderAuth() {
      count++;
      return {
        source: "OAuth",
        auth: {
          apiKey: token({
            chatgpt_account_id: `account-${count}`,
            chatgpt_data_residency: "eu",
            chatgpt_compute_residency: "us",
          }),
        },
      };
    },
  };
  const signal = new AbortController().signal;
  const noResidency = await codexHeaders(
    registry(
      token({
        chatgpt_account_id: "a",
        chatgpt_data_residency: null,
        chatgpt_compute_residency: null,
      }),
    ),
    signal,
  );
  assert.equal(noResidency["x-openai-internal-codex-residency"], undefined);
  assert.equal(
    (await codexHeaders(r, signal))["chatgpt-account-id"],
    "account-1",
  );
  const next = await codexHeaders(r, signal);
  assert.equal(next["chatgpt-account-id"], "account-2");
  assert.equal(next["x-openai-internal-codex-residency"], "eu");
  assert.equal(
    (
      await codexHeaders(
        registry(
          token({ chatgpt_account_id: "a", chatgpt_compute_residency: "us" }),
        ),
        signal,
      )
    )["x-openai-internal-codex-residency"],
    "us",
  );
});

test("missing or failed OAuth and malformed claims never reach fetch or leak errors", async () => {
  const sources: PiAuthRegistry[] = [
    {
      async getProviderAuth() {
        return undefined;
      },
    },
    {
      async getProviderAuth() {
        throw new Error("secret-token raw-auth-error");
      },
    },
    {
      async getProviderAuth() {
        return { source: "API key", auth: { apiKey: token() } };
      },
    },
    registry("malformed"),
    registry(token({})),
    registry(token({ chatgpt_account_id: "bad\r\nheader" })),
    registry(
      token({ chatgpt_account_id: "a", chatgpt_data_residency: { bad: true } }),
    ),
  ];
  for (const r of sources) {
    await assert.rejects(
      run(
        new CodexBackend(
          r,
          fetchMock(async () => {
            assert.fail("must not fetch");
          }),
        ),
      ),
      (e: Error) => {
        assert.match(e.message, /web:.*OAuth/);
        assert.doesNotMatch(e.message, /secret-token|raw-auth-error|bad\r/);
        return true;
      },
    );
  }
});

test("safe HTTP failures, no retries or error body disclosure", async () => {
  for (const status of [400, 401, 403, 404, 422, 429, 500, 503, 302]) {
    let calls = 0;
    let cancelled = false;
    const b = new CodexBackend(
      registry(),
      fetchMock(async () => {
        calls++;
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status },
        );
      }),
    );
    await assert.rejects(run(b), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  }
  await assert.rejects(
    run(
      new CodexBackend(
        registry(),
        fetchMock(async () => {
          throw new Error("secret-token redirect details");
        }),
      ),
    ),
    /transport failed/,
  );
});

test("strict response envelope, optional opaque results and ignored encryption", async () => {
  for (const data of [null, {}, { output: 1 }, { output: "x", results: {} }])
    await assert.rejects(
      run(backend(json(data))),
      /unsupported response shape/,
    );
  await assert.rejects(
    run(backend(new Response("not JSON secret-token"))),
    /invalid JSON/,
  );
  await assert.rejects(
    run(backend(new Response(new Uint8Array([0xff])))),
    /invalid JSON or text encoding/,
  );
  const absent = await run(backend(json({ output: "" })));
  assert.equal(Object.hasOwn(absent.details, "results"), false);
  assert.equal(
    (await run(backend(json({ output: "x", results: null })))).details.results,
    null,
  );
});

test("response limit checks declared and streamed bytes and cancels readers", async () => {
  await assert.rejects(
    run(
      backend(
        new Response("x", {
          headers: { "content-length": String(RESPONSE_BYTES + 1) },
        }),
      ),
    ),
    /2 MiB limit/,
  );
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(RESPONSE_BYTES));
        c.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(run(backend(response)), /2 MiB limit/);
  assert.equal(cancelled, true);
});

test("output bound includes notice and preserves UTF-8", () => {
  for (const text of [
    "😀".repeat(20_000),
    "a\n".repeat(4000),
    "界".repeat(20_000),
  ]) {
    const output = boundOutput(text);
    assert.equal(output.truncated, true);
    assert.ok(Buffer.byteLength(output.text) <= OUTPUT_BYTES);
    assert.ok(output.text.split("\n").length <= OUTPUT_LINES);
    assert.ok(!output.text.includes("�"));
    assert.match(output.text, /truncated/);
  }
  assert.deepEqual(boundOutput("x".repeat(OUTPUT_BYTES)), {
    text: "x".repeat(OUTPUT_BYTES),
    truncated: false,
  });
});

test("pre-cancellation prevents auth and transport", async () => {
  const controller = new AbortController();
  controller.abort("secret-reason");
  await assert.rejects(
    executeWeb(
      commands,
      "a",
      {
        async run() {
          assert.fail("must not run");
        },
      },
      [controller.signal],
    ),
    /^Error: web: cancelled\.$/,
  );
});

test("cancellation during auth stops waiting and prevents a late POST", async () => {
  let resolveAuth!: (
    value: Awaited<ReturnType<PiAuthRegistry["getProviderAuth"]>>,
  ) => void;
  const pending: PiAuthRegistry = {
    getProviderAuth: () =>
      new Promise((resolve) => {
        resolveAuth = resolve;
      }),
  };
  const controller = new AbortController();
  const work = executeWeb(
    commands,
    "a",
    new CodexBackend(
      pending,
      fetchMock(async () => {
        assert.fail("late POST");
      }),
    ),
    [controller.signal],
  );
  controller.abort();
  await assert.rejects(work, /cancelled/);
  resolveAuth({ source: "OAuth", auth: { apiKey: token() } });
  await new Promise((resolve) => setImmediate(resolve));
});

test("deadline covers stalled fetch and response stream", async () => {
  let transportSignal: AbortSignal | null | undefined;
  const b = new CodexBackend(
    registry(),
    fetchMock(async (_url, init) => {
      transportSignal = init?.signal;
      return new Promise(() => {});
    }),
  );
  await assert.rejects(executeWeb(commands, "a", b, [], 10), /timed out/);
  assert.equal(transportSignal?.aborted, true);
  let cancelled = false;
  await assert.rejects(
    executeWeb(
      commands,
      "a",
      backend(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      ),
      [],
      10,
    ),
    /timed out/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test("reference operations preserve exact refs, line and link zero", async () => {
  const input = {
    open: [{ ref_id: "turn0search0", lineno: 0 }],
    click: [{ ref_id: "turn0view0", id: 0 }],
    find: [{ ref_id: "turn0view0", pattern: "example" }],
  };
  const b = new CodexBackend(
    registry(),
    fetchMock(async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)).commands, input);
      return json({ output: "found" });
    }),
  );
  await executeWeb(input, "same-pi-session-id", b);
});

test("one registered tool; lifecycle identities survive reload/resume and isolate forks", async () => {
  // Capture the real registration, but all credentials and network stay mocked.
  let definition: any;
  const handlers = new Map<string, (...args: any[]) => any>();
  webSearch({
    on: (name: string, handler: (...args: any[]) => any) =>
      handlers.set(name, handler),
    registerTool: (tool: unknown) => {
      assert.equal(definition, undefined);
      definition = tool;
    },
  } as unknown as ExtensionAPI);
  assert.equal(definition.name, "web");
  assert.match(definition.description, /Markdown links/);
  const original = globalThis.fetch;
  const ids: string[] = [];
  globalThis.fetch = fetchMock(async (_url, init) => {
    ids.push(JSON.parse(String(init?.body)).id);
    return json({ output: "ok" });
  });
  try {
    const ctx = (id: string) => ({
      sessionManager: { getSessionId: () => id },
      modelRegistry: registry(),
      model: { id: "not-the-search-model" },
    });
    for (const [reason, id] of [
      ["startup", "a"],
      ["reload", "a"],
      ["resume", "a"],
      ["fork", "b"],
      ["new", "c"],
    ]) {
      handlers.get("session_start")!({ reason }, ctx(id!));
      const result = await definition.execute(
        "call",
        commands,
        undefined,
        undefined,
        ctx(id!),
      );
      assert.equal(result.details.sessionId, id);
      handlers.get("session_shutdown")!({ reason });
      await assert.rejects(
        definition.execute("call", commands, undefined, undefined, ctx(id!)),
        /cancelled/,
      );
    }
    assert.deepEqual(ids, ["a", "a", "a", "b", "c"]);
  } finally {
    globalThis.fetch = original;
  }
});
