import { basename, relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  findProjectRoot,
  loadRoadmapFile,
  setTrackedRoadmap,
  type RoadmapFileResult,
} from "./src/project.ts";
import { parseRoadmap, type Roadmap } from "./src/roadmap.ts";
import { setRoadmapWidget, showRoadmapOverlay } from "./src/ui.ts";

interface TrackerState {
  readonly projectRoot: string;
  readonly roadmapPath: string;
  readonly roadmap: Roadmap;
}

type RefreshResult =
  | { readonly status: "loaded"; readonly state: TrackerState }
  | Exclude<RoadmapFileResult, { readonly status: "loaded" }>;

export default function progressTracker(pi: ExtensionAPI) {
  let state: TrackerState | undefined;
  let active = false;
  let refreshGeneration = 0;

  const clearWidget = (ctx: ExtensionContext) => {
    state = undefined;
    setRoadmapWidget(ctx, undefined);
  };

  const refresh = async (ctx: ExtensionContext): Promise<RefreshResult> => {
    const generation = ++refreshGeneration;
    const projectRoot = findProjectRoot(ctx.cwd);
    if (state && state.projectRoot !== projectRoot) clearWidget(ctx);

    const result = await loadRoadmapFile(ctx.cwd, {
      allowProjectConfig: ctx.isProjectTrusted(),
    });
    if (!active || generation !== refreshGeneration) {
      return {
        status: "error",
        projectRoot: result.projectRoot,
        roadmapPath: result.roadmapPath,
        message: "Roadmap refresh was cancelled because the session changed.",
      };
    }

    if (result.status === "missing") {
      clearWidget(ctx);
      return result;
    }
    if (result.status === "error") {
      clearWidget(ctx);
      return result;
    }

    const nextState: TrackerState = {
      projectRoot: result.projectRoot,
      roadmapPath: result.roadmapPath,
      roadmap: parseRoadmap(result.markdown, basename(result.projectRoot)),
    };
    state = nextState;
    setRoadmapWidget(ctx, state.roadmap);
    return { status: "loaded", state: nextState };
  };

  pi.on("session_start", async (_event, ctx) => {
    active = ctx.mode === "tui";
    if (!active) return;
    await refresh(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!active || ctx.mode !== "tui") return;
    await refresh(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    active = false;
    refreshGeneration += 1;
    clearWidget(ctx);
  });

  pi.registerCommand("progress", {
    description: "Show, refresh, or select the project roadmap",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Project progress is only available in the TUI.",
            "error",
          );
        }
        return;
      }

      const command = args.trim();
      const trackMatch = command.match(/^track(?:\s+(.+))?$/i);
      const action = command.toLowerCase();
      if (trackMatch) {
        if (!ctx.isProjectTrusted()) {
          ctx.ui.notify(
            "Trust this project before changing its progress configuration.",
            "error",
          );
          return;
        }

        let requestedPath = trackMatch[1]?.trim() ?? "";
        const quote = requestedPath[0];
        if (
          requestedPath.length >= 2 &&
          (quote === '"' || quote === "'") &&
          requestedPath.at(-1) === quote
        ) {
          requestedPath = requestedPath.slice(1, -1).trim();
        }
        if (!requestedPath) {
          ctx.ui.notify(
            "Usage: /progress track <project-relative-path>",
            "warning",
          );
          return;
        }

        try {
          const configured = await setTrackedRoadmap(ctx.cwd, requestedPath);
          const result = await refresh(ctx);
          if (result.status !== "loaded") {
            ctx.ui.notify(
              result.status === "error"
                ? result.message
                : `No roadmap found at ${relative(result.projectRoot, result.roadmapPath)}.`,
              "error",
            );
            return;
          }
          ctx.ui.notify(`Now tracking ${configured.configuredPath}.`, "info");
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error
              ? error.message
              : "Could not update the progress configuration.",
            "error",
          );
        }
        return;
      }

      if (action && action !== "refresh") {
        ctx.ui.notify(
          "Usage: /progress [refresh | track <project-relative-path>]",
          "warning",
        );
        return;
      }

      const result = await refresh(ctx);
      if (result.status === "error") {
        ctx.ui.notify(result.message, "error");
        return;
      }
      if (result.status === "missing") {
        ctx.ui.notify(
          `No roadmap found at ${relative(result.projectRoot, result.roadmapPath)}.`,
          "warning",
        );
        return;
      }

      if (action === "refresh") {
        ctx.ui.notify(
          `Roadmap refreshed from ${relative(result.state.projectRoot, result.state.roadmapPath)}.`,
          "info",
        );
        return;
      }

      await showRoadmapOverlay(ctx, result.state.roadmap);
    },
  });
}
