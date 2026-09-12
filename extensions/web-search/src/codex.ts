import {
  abortable,
  WebError,
  type WebBackend,
  type WebResponse,
} from "./backend.ts";
import type { WebInput } from "./schema.ts";

export const ENDPOINT = "https://chatgpt.com/backend-api/codex/alpha/search";
export const SEARCH_MODEL = "gpt-5.6-sol";
export const RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_OUTPUT_TOKENS = 6000;

/** Structural subset of Pi 0.85.1 ModelRegistry, not an AuthStorage adapter. */
export interface PiAuthRegistry {
  getProviderAuth(provider: string): Promise<
    | {
        source?: string;
        auth: {
          apiKey?: string;
          headers?: Record<string, string | null | undefined>;
          baseUrl?: string;
        };
      }
    | undefined
  >;
}

function headerValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

export async function codexHeaders(
  registry: PiAuthRegistry,
  signal: AbortSignal,
): Promise<Record<string, string>> {
  signal.throwIfAborted();
  if (typeof registry.getProviderAuth !== "function") {
    throw new WebError(
      "web: this extension requires Pi's ModelRuntime-backed getProviderAuth API. Update Pi.",
    );
  }
  let resolved;
  try {
    // This facade calls the host ModelRuntime.getAuth, including refresh under the
    // credential-store lock. Never read auth.json or implement token refresh here.
    resolved = await abortable(
      registry.getProviderAuth("openai-codex"),
      signal,
    );
  } catch {
    throw new WebError(
      "web: could not resolve Codex OAuth. Use /login openai-codex in Pi and try again.",
    );
  }
  signal.throwIfAborted();
  const token = resolved?.auth.apiKey;
  if (
    resolved?.source !== "OAuth" ||
    !token ||
    token.length > 32768 ||
    !/^[A-Za-z0-9_.-]+$/.test(token)
  ) {
    throw new WebError(
      "web: existing Pi Codex OAuth is required. Use /login openai-codex.",
    );
  }
  let claims;
  try {
    claims = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
  } catch {
    throw new WebError(
      "web: Codex OAuth token has invalid account claims. Sign in again with Pi.",
    );
  }
  // Claims supply routing metadata only. The official server verifies the token.
  const auth = claims?.["https://api.openai.com/auth"];
  const account = auth?.chatgpt_account_id;
  const residency =
    auth?.chatgpt_data_residency ??
    auth?.chatgpt_compute_residency ??
    undefined;
  if (
    !headerValue(account) ||
    (residency !== undefined && !headerValue(residency))
  ) {
    throw new WebError(
      "web: Codex OAuth account or residency claims are missing or invalid. Sign in again with Pi.",
    );
  }
  // Do not forward arbitrary provider headers, baseUrl, or environment settings.
  return {
    Authorization: `Bearer ${token}`,
    "chatgpt-account-id": account,
    "Content-Type": "application/json",
    Accept: "application/json",
    "OpenAI-Beta": "responses=experimental",
    originator: "omp",
    version: "0.153.0",
    ...(residency === undefined
      ? {}
      : { "x-openai-internal-codex-residency": residency }),
  };
}

export function httpError(status: number): WebError {
  if (status === 429)
    return new WebError(
      "web: Codex search is rate-limited or its quota is exhausted (HTTP 429). No retry was made. Stop web calls for this turn; quota and reset time are unknown.",
    );
  if (status === 401 || status === 403)
    return new WebError(
      `web: Codex search access denied (HTTP ${status}). Check your Pi Codex login and account access.`,
    );
  if (status === 400 || status === 422)
    return new WebError(
      `web: Codex search rejected the request (HTTP ${status}). Check operations; stale references may require a new search or URL.`,
    );
  return new WebError(
    `web: Codex search failed (HTTP ${status}). No retry or fallback was made.`,
  );
}

async function readResponse(
  response: Response,
  signal: AbortSignal,
): Promise<WebResponse> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new WebError(
      "web: response exceeded the 2 MiB limit. Request fewer operations or a shorter response.",
    );
  }
  if (!response.body)
    throw new WebError("web: Codex search returned an empty response.");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) {
        complete = true;
        break;
      }
      size += value.byteLength;
      if (size > RESPONSE_BYTES)
        throw new WebError(
          "web: response exceeded the 2 MiB limit. Request fewer operations or a shorter response.",
        );
      chunks.push(value);
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  let data;
  try {
    data = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, size),
      ),
    );
  } catch {
    throw new WebError(
      "web: Codex search returned invalid JSON or text encoding.",
    );
  }
  if (
    !data ||
    typeof data.output !== "string" ||
    (data.results !== undefined &&
      data.results !== null &&
      !Array.isArray(data.results))
  ) {
    throw new WebError(
      "web: Codex search returned an unsupported response shape.",
    );
  }
  // Opaque results remain out of model context. encrypted_output is unused and
  // deliberately discarded, as in the Codex standalone executor.
  return {
    output: data.output,
    ...(data.results === undefined ? {} : { results: data.results }),
  };
}

export class CodexBackend implements WebBackend {
  private readonly registry: PiAuthRegistry;
  private readonly fetcher: typeof fetch;

  constructor(registry: PiAuthRegistry, fetcher: typeof fetch = fetch) {
    this.registry = registry;
    this.fetcher = fetcher;
  }

  async run(
    commands: WebInput,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<WebResponse> {
    try {
      const headers = await codexHeaders(this.registry, signal);
      signal.throwIfAborted();
      const response = await abortable(
        this.fetcher(ENDPOINT, {
          method: "POST",
          headers,
          redirect: "error",
          credentials: "omit",
          signal,
          body: JSON.stringify({
            id: sessionId,
            model: SEARCH_MODEL,
            commands,
            settings: {
              allowed_callers: ["direct"],
              external_web_access: true,
            },
            max_output_tokens: MAX_OUTPUT_TOKENS,
          }),
        }),
        signal,
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw httpError(response.status);
      }
      return await readResponse(response, signal);
    } catch (error) {
      if (signal.aborted) throw new WebError("web: cancelled.");
      if (error instanceof WebError) throw error;
      // Never expose fetch/SDK exceptions, response bodies, headers, or tokens.
      throw new WebError(
        "web: Codex search transport failed. No retry or fallback was made.",
      );
    }
  }
}
