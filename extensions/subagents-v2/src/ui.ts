import type {
  ModelRegistry,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { supportedReasoning } from "./config.ts";
import { ConfigPicker } from "./config-picker.ts";
import { openDashboard } from "./live-ui.ts";
import type { SubagentManager } from "./manager.ts";
import type { SubagentsConfig } from "./types.ts";

export async function configureSubagents(
  ctx: ExtensionCommandContext,
  registry: ModelRegistry,
  initial: SubagentsConfig,
  apply: (config: SubagentsConfig) => Promise<void>,
) {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI)
      ctx.ui.notify(
        "Subagents V2 configuration is available in the TUI.",
        "warning",
      );
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new ConfigPicker<SubagentsConfig>({
        tui,
        theme,
        registry,
        supportedReasoning,
        initial,
        onChange: apply,
        done: () => done(),
      }),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "90%",
        minWidth: 44,
        // The picker itself budgets rows from the terminal height; keep the
        // overlay limit above that so the frame and help line are never cut.
        maxHeight: 28,
        margin: 1,
      },
    },
  );
}

/**
 * Dashboard entrypoint used by the parent extension. The options shape is kept
 * for parent integration even though the dashboard only needs the manager;
 * configuration is registered separately as `/subagent-config`.
 */
export async function openSubagentsMenu(options: {
  ctx: ExtensionCommandContext;
  registry: ModelRegistry;
  config: SubagentsConfig;
  manager?: SubagentManager;
  applyConfig(config: SubagentsConfig): Promise<void>;
}) {
  await openDashboard({ ctx: options.ctx, manager: options.manager });
}
