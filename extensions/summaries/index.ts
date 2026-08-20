import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { loadSummaryConfig, saveSummaryConfig } from "./src/config.ts";
import { summarizeRun } from "./src/summarizer.ts";
import {
  buildFallbackRecap,
  createRunBoundary,
  findLatestCompletedRun,
  getCompletedRunEntries,
  getRunEntries,
  RUN_MARKER_ENTRY_TYPE,
  serializeRunTranscript,
  type CompletedRun,
} from "./src/transcript.ts";
import {
  openModelPicker,
  openReasoningPicker,
  renderRecap,
  type RecapEntryData,
} from "./src/ui.ts";

const RECAP_ENTRY_TYPE = "summary-recap";
const STATUS_KEY = "summaries";
const SHUTDOWN_WAIT_MS = 1_000;

type SummaryOrigin = "automatic" | "manual";
type SummaryStartResult = "started" | "active" | "complete" | "missing";

interface ActiveSummary {
  readonly origin: SummaryOrigin;
  readonly runEndLeafId: string;
  readonly task: Promise<void>;
}

async function waitForCancellation(
  tasks: readonly Promise<void>[],
  timeoutMs: number,
) {
  if (tasks.length === 0) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function recapData(entry: SessionEntry) {
  if (entry.type !== "custom" || entry.customType !== RECAP_ENTRY_TYPE) {
    return undefined;
  }
  if (typeof entry.data !== "object" || entry.data === null) return undefined;
  return entry.data as Partial<RecapEntryData>;
}

export function hasSuccessfulRecap(
  branch: readonly SessionEntry[],
  runEndLeafId: string,
) {
  return branch.some((entry) => {
    const data = recapData(entry);
    return data?.runEndLeafId === runEndLeafId && data.fallback !== true;
  });
}

export default function (pi: ExtensionAPI) {
  const runBoundary = createRunBoundary();
  const activeSummaries = new Map<AbortController, ActiveSummary>();
  let sessionActive = false;
  let statusContext: ExtensionContext | undefined;

  const updateStatus = () => {
    statusContext?.ui.setStatus(
      STATUS_KEY,
      activeSummaries.size > 0
        ? statusContext.ui.theme.fg("muted", "✦ summarizing run…")
        : undefined,
    );
  };

  const activeForRun = (runEndLeafId: string) =>
    [...activeSummaries.values()].some(
      (summary) => summary.runEndLeafId === runEndLeafId,
    );

  function startSummary(
    ctx: ExtensionContext,
    run: CompletedRun,
    origin: SummaryOrigin,
  ): SummaryStartResult {
    const branch = ctx.sessionManager.getBranch();
    if (activeForRun(run.endLeafId)) return "active";
    if (hasSuccessfulRecap(branch, run.endLeafId)) return "complete";

    const entries = getCompletedRunEntries(branch, run);
    if (entries.length === 0) return "missing";

    const config = loadSummaryConfig();
    const controller = new AbortController();
    statusContext = ctx;
    const task = (async () => {
      let recap: RecapEntryData;
      try {
        const generated = await summarizeRun({
          modelRegistry: ctx.modelRegistry,
          config,
          transcript: serializeRunTranscript(entries),
          signal: controller.signal,
        });
        recap = {
          ...generated,
          provider: config.provider,
          model: config.model,
          reasoning: config.reasoning,
          runEndLeafId: run.endLeafId,
        };
      } catch (error) {
        if (controller.signal.aborted || !sessionActive) return;
        recap = {
          ...buildFallbackRecap(entries),
          provider: config.provider,
          model: config.model,
          reasoning: config.reasoning,
          runEndLeafId: run.endLeafId,
          fallback: true,
        };
        const detail = error instanceof Error ? ` ${error.message}` : "";
        ctx.ui.notify(
          `The summary model failed; showing a concise local fallback.${detail}`,
          "warning",
        );
      }

      if (!sessionActive || controller.signal.aborted) return;
      pi.appendEntry(RECAP_ENTRY_TYPE, recap);
    })().finally(() => {
      activeSummaries.delete(controller);
      updateStatus();
    });

    activeSummaries.set(controller, {
      origin,
      runEndLeafId: run.endLeafId,
      task,
    });
    updateStatus();
    void task;
    return "started";
  }

  pi.registerEntryRenderer<RecapEntryData>(
    RECAP_ENTRY_TYPE,
    (entry, { expanded }, theme) => renderRecap(entry.data, expanded, theme),
  );

  pi.on("session_start", (_event, ctx) => {
    sessionActive = ctx.mode === "tui";
    statusContext = ctx;
    runBoundary.reset();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    runBoundary.begin(ctx.sessionManager.getLeafId());
  });

  pi.on("agent_settled", (_event, ctx) => {
    const run = runBoundary.settle();
    if (!run || ctx.mode !== "tui" || !sessionActive) return;

    const branch = ctx.sessionManager.getBranch();
    const entries = getRunEntries(branch, run.baselineLeafId);
    const endLeafId = ctx.sessionManager.getLeafId();
    if (entries.length === 0 || endLeafId === null) return;

    const completedRun = { ...run, endLeafId };
    pi.appendEntry(RUN_MARKER_ENTRY_TYPE, completedRun);

    if (loadSummaryConfig().enabled) {
      startSummary(ctx, completedRun, "automatic");
    }
  });

  pi.on("session_shutdown", async () => {
    sessionActive = false;
    runBoundary.reset();
    const summaries = [...activeSummaries.entries()];
    for (const [controller] of summaries) controller.abort();
    await waitForCancellation(
      summaries.map(([, summary]) => summary.task),
      SHUTDOWN_WAIT_MS,
    );
    activeSummaries.clear();
    statusContext?.ui.setStatus(STATUS_KEY, undefined);
    statusContext = undefined;
  });

  pi.registerCommand("recap", {
    description:
      "Generate a recap, or manage automatic recaps with on/off/status",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify("Run recaps are only available in the TUI.", "error");
        }
        return;
      }

      const action = args.trim().toLowerCase();
      if (action === "status") {
        ctx.ui.notify(
          `Automatic run recaps are ${loadSummaryConfig().enabled ? "enabled" : "disabled"}.`,
          "info",
        );
        return;
      }

      if (action === "on" || action === "off") {
        const enabled = action === "on";
        const current = loadSummaryConfig();
        try {
          await saveSummaryConfig({ ...current, enabled });
        } catch {
          ctx.ui.notify("Could not save the private recap config.", "error");
          return;
        }

        if (!enabled) {
          const automatic = [...activeSummaries.entries()].filter(
            ([, summary]) => summary.origin === "automatic",
          );
          for (const [controller] of automatic) controller.abort();
          await waitForCancellation(
            automatic.map(([, summary]) => summary.task),
            SHUTDOWN_WAIT_MS,
          );
        }

        ctx.ui.notify(
          `Automatic run recaps ${enabled ? "enabled" : "disabled"}.`,
          "info",
        );
        return;
      }

      if (action) {
        ctx.ui.notify("Usage: /recap [on|off|status]", "warning");
        return;
      }

      const latestRun = findLatestCompletedRun(ctx.sessionManager.getBranch());
      if (!latestRun) {
        ctx.ui.notify("No completed run is available to recap.", "warning");
        return;
      }

      const result = startSummary(ctx, latestRun, "manual");
      if (result === "started") {
        ctx.ui.notify(
          "Generating a recap for the latest completed run.",
          "info",
        );
      } else if (result === "active") {
        ctx.ui.notify(
          "A recap for the latest run is already generating.",
          "info",
        );
      } else if (result === "complete") {
        ctx.ui.notify("The latest run already has a successful recap.", "info");
      } else {
        ctx.ui.notify(
          "The latest run is no longer available on this session branch.",
          "warning",
        );
      }
    },
  });

  pi.registerCommand("summary-model", {
    description: "Choose the model and reasoning level used for run recaps",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Summary model selection is only available in the TUI.",
            "error",
          );
        }
        return;
      }

      const current = loadSummaryConfig();
      const model = await openModelPicker(ctx, current);
      if (!model) return;

      const reasoning = await openReasoningPicker(
        ctx,
        model,
        current.reasoning,
      );
      if (!reasoning) return;

      const config = {
        ...current,
        provider: model.provider,
        model: model.id,
        reasoning,
      };
      try {
        await saveSummaryConfig(config);
      } catch {
        ctx.ui.notify(
          "Could not save the private summary model config.",
          "error",
        );
        return;
      }

      ctx.ui.notify(
        `Summary model: ${config.provider}/${config.model} · ${config.reasoning}`,
        "info",
      );
    },
  });
}
