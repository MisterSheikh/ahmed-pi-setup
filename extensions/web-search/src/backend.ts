import type { WebInput } from "./schema.ts";

export interface WebResponse {
  output: string;
  results?: unknown[] | null;
}

/** Replace this interface's implementation to use a different search service. */
export interface WebBackend {
  run(
    commands: WebInput,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<WebResponse>;
}

export class WebError extends Error {}

/** Stop waiting even when an SDK method or mock does not accept cancellation. */
export function abortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new WebError("web: cancelled."));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export const OUTPUT_BYTES = 50 * 1024;
export const OUTPUT_LINES = 2000;
const TRUNCATION_NOTICE =
  "\n\n[web output truncated. Use find or open with lineno to request a narrower excerpt; the full output was not saved.]";

export function boundOutput(output: string): {
  text: string;
  truncated: boolean;
} {
  const lines = output.split("\n");
  if (
    lines.length <= OUTPUT_LINES &&
    Buffer.byteLength(output) <= OUTPUT_BYTES
  ) {
    return { text: output, truncated: false };
  }
  const bytes = Buffer.from(lines.slice(0, OUTPUT_LINES - 2).join("\n"));
  const budget = OUTPUT_BYTES - Buffer.byteLength(TRUNCATION_NOTICE);
  let end = Math.min(bytes.length, budget);
  // Do not split a UTF-8 sequence at the byte boundary.
  if (end < bytes.length)
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return {
    text: bytes.subarray(0, end).toString("utf8") + TRUNCATION_NOTICE,
    truncated: true,
  };
}
