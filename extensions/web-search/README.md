# Web search

One Pi tool, `web`, with four operations. It calls the Codex standalone search endpoint, not the hosted Responses web-search tool. It works independently of the parent model and sends no conversation history.

Requires Node 24+, TypeBox 1.3.7, and Pi 0.85.1 or newer with the ModelRuntime-backed auth API. Sign in once with Pi's `/login openai-codex`. No separate key or Codex CLI login is needed.

## Use

```json
{"search_query":[{"q":"Node.js AbortSignal.timeout","recency":30,"domains":["nodejs.org"]}],"response_length":"short"}
```

```json
{"open":[{"ref_id":"https://nodejs.org/api/globals.html"}]}
```

```json
{"find":[{"ref_id":"turn0view0","pattern":"AbortSignal.timeout"}]}
```

```json
{"open":[{"ref_id":"turn0view0","lineno":100}],"click":[{"ref_id":"turn0view0","id":12}]}
```

Use references and numbered links actually returned by the service, not these illustrative IDs. `recency` is in days. `lineno` and link `id` are nonnegative integers. Domains are server-side search filters, not a local network allowlist. `response_length` accepts `short`, `medium`, or `long` and defaults to the server's short response.

Each operation array allows 1 to 4 entries, with 1 to 8 operations total. Queries, references, patterns, and domain arrays also have schema limits. Unknown fields and unsupported operations fail before auth or network access. Calls that depend on a previous result must run after that result is available.

Final answers should cite actual source URLs using Markdown links near claims. Raw `turn...` references and backend citation tokens are not usable citations in Pi. The tool includes this guidance and tells the model to treat retrieved content as untrusted.

## Transport and credentials

The only search destination is:

```text
POST https://chatgpt.com/backend-api/codex/alpha/search
```

The fixed backend model is `gpt-5.6-sol`, with `originator: omp`, `version: 0.153.0`, and the experimental Responses beta header. The body contains `id`, `model`, `commands`, `settings` with `allowed_callers: ["direct"]` and `external_web_access: true`, and `max_output_tokens: 6000`. It omits history, reasoning, and result projections.

Each call resolves `openai-codex` through the host's `ctx.modelRegistry.getProviderAuth()`. In Pi 0.85.1 this delegates to `ModelRuntime.getAuth()`, which refreshes near-expiry OAuth tokens under the credential-store lock and persists rotated credentials. The extension does not read `auth.json`, retain tokens, construct another auth store, or implement refresh.

Only OAuth resolutions are accepted. Account and optional residency headers come from the resolved access token's claims. Data residency takes precedence over compute residency. Claims supply routing metadata; the official server verifies authentication. Provider base URLs, arbitrary headers, environment settings, and custom endpoint settings are not forwarded. Redirects are disabled. No request or auth-error payloads are logged or echoed in errors.

## Sessions and results

The request `id` is Pi's `sessionManager.getSessionId()`, read at execution time. It stays the same across reload, resume, compaction, and `/tree` navigation. No extra randomly generated ID or custom entry is needed.

New sessions, forks, and clones use their new Pi IDs. References copied from a parent transcript are **not transferred** to the new backend session. Repeat the search or open the source URL there. Server reference retention is unknown, so old references may also expire on resume. The server validates references; the extension does not invent or rewrite them.

Model-visible content is the response's `output` string, subject to the local output limit. Tool-result `details` store the backend name, originating Pi `sessionId`, truncation flag, and opaque `results` without changing their fields. Missing results stay absent and explicit null stays null. Pi persists details with the tool result, outside model context. `encrypted_output` is discarded, matching Codex's standalone executor. Queries and results still appear in the local Pi session and may contain sensitive information.

`session_shutdown` cancels active work. Reload and replacement sessions get a fresh lifetime signal. The current ModelRegistry auth facade does not accept a caller signal, so cancellation stops waiting for auth and prevents a later search POST, but an SDK-owned refresh already in progress may finish. Pi 0.85.1 bounds that refresh internally.

## Limits and failures

- A 60-second deadline covers auth, transport, and reading the response. Tool cancellation and session shutdown also abort work.
- The transport rejects responses over 2 MiB, checking both Content-Length and streamed bytes, including opaque results.
- Model output is bounded to 50 KiB and 2000 lines, including a truncation notice. UTF-8 characters remain intact. Full output is not saved to another file; request a narrower excerpt with `find` or `open` and `lineno`.
- There are no automatic retries, including for HTTP 429, and no hosted-search fallback. A 429 tells the model to stop web calls for the turn. This is guidance, not a persistent account-wide circuit breaker.
- Errors include safe status-specific advice, never raw response bodies, SDK exceptions, headers, or credentials.

This is an **internal, undocumented endpoint**. Access, the fixed model slug, headers, and wire format can change without notice. Search quota, billing, reset time, and its relationship to normal Codex usage are unknown. No usage or cost is fabricated for Pi's totals. Installing this extension does not disable hosted tools supplied by other extensions; avoid exposing competing search implementations.

No browser automation, page interaction beyond numbered links, screenshots, PDF-specific tools, images, finance, weather, or other Codex commands are included. `WebBackend` in `src/backend.ts` is the replacement boundary for a future service. The production Codex implementation intentionally has no configurable URL.

## Checks and integration

From the repository root:

```sh
node --experimental-strip-types --test extensions/web-search/test/*.test.ts
node_modules/.bin/tsc --noEmit -p extensions/web-search
```

Tests use synthetic tokens, mock fetch, and in-memory credentials. The runtime test verifies that concurrent requests refresh once through the real ModelRegistry/ModelRuntime API. It blocks live fetch and does not load real credentials. To exercise another installed Pi SDK instead of repository dev dependencies:

```sh
PI_WEB_TEST_SDK=/absolute/path/to/pi-coding-agent/dist/index.js \
  node --experimental-strip-types --test extensions/web-search/test/*.test.ts
```

The repository pins Pi 0.85.1 to match the installed host. A live Pi smoke test passed four sequential calls: search official Node.js documentation, open a search reference, find text by page reference, and click a numbered link. The model returned normal Markdown citations. Live smoke tests use account allowance and are not part of the automated suite.

Install and link from the repository root with `npm ci && ./scripts/link.sh`, then run `/reload` in Pi. The link/unlink scripts include this extension. `npm test` also checks discovery through an isolated linked installation, with no credentials or model calls.

For an isolated live test, load explicitly:

```sh
pi --no-extensions -e ./extensions/web-search/index.ts --no-session --tools web \
  -p 'Search official Node.js docs for AbortSignal.timeout, open the result, and cite the source.'
```
