import {
  FooterComponent,
  readStoredCredential,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface UsageWindow {
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface SubscriptionUsage {
  provider: string;
  primary?: UsageWindow;
  secondary?: UsageWindow;
}

function finiteNumber(value: string | undefined) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function windowFromHeaders(
  headers: Record<string, string>,
  prefix: string,
): UsageWindow | undefined {
  const usedPercent = finiteNumber(headers[`${prefix}-used-percent`]);
  if (usedPercent === undefined) return undefined;
  return {
    usedPercent,
    windowMinutes: finiteNumber(headers[`${prefix}-window-minutes`]),
    resetsAt: finiteNumber(headers[`${prefix}-reset-at`]),
  };
}

interface CodexUsageResponse {
  rate_limit?: {
    primary_window?: CodexUsageApiWindow | null;
    secondary_window?: CodexUsageApiWindow | null;
  };
}

interface CodexUsageApiWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
}

function apiWindow(window: CodexUsageApiWindow | null | undefined) {
  if (!window || !Number.isFinite(window.used_percent)) return undefined;
  return {
    usedPercent: window.used_percent!,
    windowMinutes: Number.isFinite(window.limit_window_seconds)
      ? window.limit_window_seconds! / 60
      : undefined,
    resetsAt: Number.isFinite(window.reset_at) ? window.reset_at : undefined,
  };
}

export function parseCodexUsageResponse(
  value: CodexUsageResponse,
): SubscriptionUsage | undefined {
  const primary = apiWindow(value.rate_limit?.primary_window);
  const secondary = apiWindow(value.rate_limit?.secondary_window);
  if (!primary && !secondary) return undefined;
  return { provider: "OpenAI", primary, secondary };
}

async function fetchCodexUsage(signal?: AbortSignal) {
  const credential = readStoredCredential("openai-codex");
  if (
    !credential ||
    credential.type !== "oauth" ||
    typeof credential.accountId !== "string"
  )
    return undefined;
  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${credential.access}`,
      "chatgpt-account-id": credential.accountId,
    },
    signal,
  });
  if (!response.ok) return undefined;
  return parseCodexUsageResponse((await response.json()) as CodexUsageResponse);
}

/** Parse quota headers when Codex includes them on a model response. */
export function parseCodexUsage(
  responseHeaders: Record<string, string>,
): SubscriptionUsage | undefined {
  const headers = Object.fromEntries(
    Object.entries(responseHeaders).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]),
  );
  const primary = windowFromHeaders(headers, "x-codex-primary");
  const secondary = windowFromHeaders(headers, "x-codex-secondary");
  if (!primary && !secondary) return undefined;
  return { provider: "OpenAI", primary, secondary };
}

function windowLabel(window: UsageWindow, position: "primary" | "secondary") {
  if (window.windowMinutes === 300) return "5h";
  if (window.windowMinutes === 10_080) return "week";
  if (window.windowMinutes && window.windowMinutes % 1_440 === 0)
    return `${window.windowMinutes / 1_440}d`;
  if (window.windowMinutes && window.windowMinutes % 60 === 0)
    return `${window.windowMinutes / 60}h`;
  return position;
}

export function formatSubscriptionUsage(usage: SubscriptionUsage) {
  const windows = (["primary", "secondary"] as const).flatMap((position) => {
    const window = usage[position];
    if (!window) return [];
    const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
    return `${windowLabel(window, position)} ${remaining.toFixed(remaining % 1 ? 1 : 0)}% left`;
  });
  return `${usage.provider} · ${windows.join(" · ")}`;
}

export default function subscriptionUsage(pi: ExtensionAPI) {
  let usage: SubscriptionUsage | undefined;
  let activeContext: ExtensionContext | undefined;

  const render = () => {
    if (!activeContext || activeContext.mode !== "tui") return;
    const ctx = activeContext;
    ctx.ui.setFooter((_tui, theme, footerData) => {
      // FooterComponent requires its private AgentSession, but its renderer only
      // reads this public subset. Keep the built-in footer rather than adding a row.
      const sessionAdapter = {
        get state() {
          return {
            model: ctx.model,
            thinkingLevel: ctx.thinkingLevel,
          };
        },
        sessionManager: ctx.sessionManager,
        getContextUsage: () => ctx.getContextUsage(),
        modelRuntime: {
          isUsingSubscription: (provider: string) =>
            provider === "openai-codex" || provider === "kimi-coding",
        },
      } as unknown as ConstructorParameters<typeof FooterComponent>[0];
      const footer = new FooterComponent(sessionAdapter, footerData);
      return {
        dispose: () => footer.dispose(),
        invalidate: () => footer.invalidate(),
        render(width: number) {
          const lines = footer.render(width);
          const status = lines.length > 2 ? lines.slice(2).join(" ") : "";
          const firstLine = status
            ? `${lines[0] ?? ""}  ${status}`
            : (lines[0] ?? "");
          const right = usage
            ? theme.fg("dim", formatSubscriptionUsage(usage))
            : "";
          const rightWidth = visibleWidth(right);
          const gap = right ? 2 : 0;
          const availableLeft = Math.max(0, width - rightWidth - gap);
          const left = truncateToWidth(firstLine, availableLeft, "…");
          const padding = " ".repeat(
            Math.max(0, width - visibleWidth(left) - rightWidth),
          );
          lines[0] = truncateToWidth(`${left}${padding}${right}`, width);
          return lines.slice(0, 2);
        },
      };
    });
  };

  const refresh = async (ctx: ExtensionContext) => {
    if (ctx.model?.provider !== "openai-codex") return;
    try {
      const next = await fetchCodexUsage(ctx.signal);
      if (next) usage = next;
    } catch {
      // Quota is supplementary UI; authentication and network failures stay silent.
    }
    render();
  };

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    usage = undefined;
    render();
    await refresh(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    activeContext = ctx;
    usage = undefined;
    render();
    if (event.model.provider === "openai-codex") await refresh(ctx);
  });

  pi.on("after_provider_response", async (event, ctx) => {
    activeContext = ctx;
    if (ctx.model?.provider !== "openai-codex") return;
    const next = parseCodexUsage(event.headers);
    if (next) {
      usage = next;
      render();
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    activeContext = ctx;
    await refresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setFooter(undefined);
    activeContext = undefined;
  });
}
