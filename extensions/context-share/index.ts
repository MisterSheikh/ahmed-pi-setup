import { basename } from "node:path";
import {
  copyToClipboard,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { formatSharedContext } from "./src/format.ts";
import { extractShareMessages } from "./src/messages.ts";
import {
  defaultExportPath,
  resolveExportPath,
  saveSharedContext,
} from "./src/save.ts";
import {
  createInitialSelection,
  parseShareArguments,
  type SelectionState,
  type ShareArguments,
} from "./src/selection.ts";
import { openSharePicker, selectedMessages } from "./src/ui.ts";

function isAlreadyExists(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("excerpt", {
    description:
      "Select user and agent messages to copy or save as a Markdown transcript",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Context sharing is only available in the TUI.",
            "error",
          );
        }
        return;
      }

      let options: ShareArguments;
      try {
        options = parseShareArguments(args);
      } catch (error) {
        ctx.ui.notify(
          `${error instanceof Error ? error.message : "Invalid arguments"}. Usage: /excerpt [count] [--skip number]`,
          "warning",
        );
        return;
      }

      await ctx.waitForIdle();
      const messages = extractShareMessages(ctx.sessionManager.getBranch());
      if (messages.length === 0) {
        ctx.ui.notify(
          "This branch has no user or agent messages to share.",
          "warning",
        );
        return;
      }

      const initialSelection = createInitialSelection(
        messages.length,
        options.count,
        options.skip,
      );
      if (!initialSelection) {
        ctx.ui.notify(
          `Cannot skip ${options.skip} messages; this branch has ${messages.length}.`,
          "warning",
        );
        return;
      }

      let selection: SelectionState = initialSelection;
      for (;;) {
        const result = await openSharePicker(ctx, messages, selection);
        if (!result) return;
        selection = result.selection;

        const transcript = formatSharedContext(
          selectedMessages(messages, selection),
        );
        if (result.action === "copy") {
          try {
            await copyToClipboard(transcript);
            ctx.ui.notify(
              `Copied ${selectedMessages(messages, selection).length} messages.`,
              "info",
            );
          } catch (error) {
            ctx.ui.notify(
              `Could not copy the selected messages: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          }
          return;
        }

        const suggestedPath = defaultExportPath(ctx.cwd);
        const suggestedName = basename(suggestedPath);
        const enteredPath = await ctx.ui.input(
          `Save path (blank uses ${suggestedName})`,
          suggestedName,
        );
        if (enteredPath === undefined) continue;

        let outputPath: string;
        try {
          outputPath = resolveExportPath(
            enteredPath.trim() || suggestedPath,
            ctx.cwd,
          );
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
          continue;
        }

        try {
          await saveSharedContext(outputPath, transcript);
        } catch (error) {
          if (!isAlreadyExists(error)) {
            ctx.ui.notify(
              `Could not save context: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
            continue;
          }
          const overwrite = await ctx.ui.confirm(
            "Overwrite context file?",
            `${outputPath} already exists.`,
          );
          if (!overwrite) continue;
          try {
            await saveSharedContext(outputPath, transcript, true);
          } catch (overwriteError) {
            ctx.ui.notify(
              `Could not save context: ${overwriteError instanceof Error ? overwriteError.message : String(overwriteError)}`,
              "error",
            );
            continue;
          }
        }

        ctx.ui.notify(
          `Saved ${selectedMessages(messages, selection).length} messages to ${outputPath}.`,
          "info",
        );
        return;
      }
    },
  });
}
