import {
  getMarkdownTheme,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  matchesKey,
  truncateToWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  roadmapDisplayMarkdown,
  roadmapStageLabel,
  type Roadmap,
} from "./roadmap.ts";

export const PROGRESS_WIDGET_KEY = "progress-tracker";

function completionLabel(roadmap: Roadmap) {
  if (roadmap.totalTasks === 0) return "No tracked items";
  return `${roadmap.completedTasks}/${roadmap.totalTasks} done`;
}

export function widgetText(roadmap: Roadmap) {
  const first = `◆ Roadmap · ${roadmap.title} · ${completionLabel(roadmap)}`;
  if (roadmap.complete) {
    return [first, "✓ All tracked items complete"];
  }

  const details = [roadmapStageLabel(roadmap)];
  if (roadmap.currentFocus) details.push(`Focus: ${roadmap.currentFocus}`);
  if (roadmap.nextOpenItem) details.push(`Next open: ${roadmap.nextOpenItem}`);
  return [first, details.join(" · ")];
}

class RoadmapWidget {
  private readonly roadmap: Roadmap;
  private readonly theme: Theme;

  constructor(roadmap: Roadmap, theme: Theme) {
    this.roadmap = roadmap;
    this.theme = theme;
  }

  render(width: number) {
    const [first, second] = widgetText(this.roadmap);
    return [
      truncateToWidth(this.theme.fg("accent", first ?? "Roadmap"), width),
      truncateToWidth(this.theme.fg("muted", `  ${second ?? ""}`), width),
    ];
  }

  invalidate() {}
}

export function setRoadmapWidget(
  ctx: Pick<ExtensionCommandContext, "ui">,
  roadmap: Roadmap | undefined,
) {
  if (!roadmap) {
    ctx.ui.setWidget(PROGRESS_WIDGET_KEY, undefined);
    return;
  }
  ctx.ui.setWidget(
    PROGRESS_WIDGET_KEY,
    (_tui, theme) => new RoadmapWidget(roadmap, theme),
    { placement: "belowEditor" },
  );
}

const OVERLAY_HEIGHT_RATIO = 0.85;
const OVERLAY_MARGIN_ROWS = 2;
const OVERLAY_FIXED_ROWS = 5;

class RoadmapOverlay {
  private readonly content: Markdown;
  private readonly summary: string;
  private readonly theme: Theme;
  private readonly title: string;
  private readonly tui: TUI;
  private readonly close: () => void;
  private scrollTop = 0;
  private contentHeight = 0;
  private pageSize = 1;

  constructor(tui: TUI, theme: Theme, roadmap: Roadmap, close: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.close = close;
    this.title = `Roadmap · ${roadmap.title}`;
    this.summary = `${roadmapStageLabel(roadmap)} · ${completionLabel(roadmap)}`;
    this.content = new Markdown(
      roadmapDisplayMarkdown(roadmap),
      1,
      1,
      getMarkdownTheme(),
    );
  }

  private maxScrollTop() {
    return Math.max(0, this.contentHeight - this.pageSize);
  }

  private moveTo(next: number) {
    const clamped = Math.max(0, Math.min(this.maxScrollTop(), next));
    if (clamped === this.scrollTop) return;
    this.scrollTop = clamped;
    this.tui.requestRender();
  }

  render(width: number) {
    const availableRows = Math.max(
      OVERLAY_FIXED_ROWS + 1,
      this.tui.terminal.rows - OVERLAY_MARGIN_ROWS,
    );
    const maxHeight = Math.min(
      availableRows,
      Math.max(
        OVERLAY_FIXED_ROWS + 1,
        Math.floor(this.tui.terminal.rows * OVERLAY_HEIGHT_RATIO),
      ),
    );
    this.pageSize = Math.max(1, maxHeight - OVERLAY_FIXED_ROWS);

    const contentLines = this.content.render(width);
    this.contentHeight = contentLines.length;
    this.scrollTop = Math.min(this.scrollTop, this.maxScrollTop());
    const visible = contentLines.slice(
      this.scrollTop,
      this.scrollTop + this.pageSize,
    );
    const firstVisible = this.contentHeight === 0 ? 0 : this.scrollTop + 1;
    const lastVisible = Math.min(
      this.contentHeight,
      this.scrollTop + this.pageSize,
    );
    const range =
      this.contentHeight > this.pageSize
        ? ` · ${firstVisible}-${lastVisible}/${this.contentHeight}`
        : "";
    const border = this.theme.fg("accent", "─".repeat(Math.max(1, width)));

    return [
      border,
      truncateToWidth(
        ` ${this.theme.fg("accent", this.theme.bold(this.title))}`,
        width,
      ),
      truncateToWidth(` ${this.theme.fg("muted", this.summary)}`, width),
      ...visible,
      truncateToWidth(
        ` ${this.theme.fg("dim", `↑/↓ or j/k scroll · PgUp/PgDn page · Home/End jump · Esc closes${range}`)}`,
        width,
      ),
      border,
    ];
  }

  invalidate() {
    this.content.invalidate();
  }

  handleInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.close();
      return;
    }

    if (matchesKey(data, "up") || data === "k") {
      this.moveTo(this.scrollTop - 1);
    } else if (matchesKey(data, "down") || data === "j") {
      this.moveTo(this.scrollTop + 1);
    } else if (matchesKey(data, "pageUp")) {
      this.moveTo(this.scrollTop - Math.max(1, this.pageSize - 2));
    } else if (matchesKey(data, "pageDown")) {
      this.moveTo(this.scrollTop + Math.max(1, this.pageSize - 2));
    } else if (matchesKey(data, "home")) {
      this.moveTo(0);
    } else if (matchesKey(data, "end")) {
      this.moveTo(this.maxScrollTop());
    }
  }
}

export async function showRoadmapOverlay(
  ctx: ExtensionCommandContext,
  roadmap: Roadmap,
) {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new RoadmapOverlay(tui, theme, roadmap, () => done()),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "85%",
        maxHeight: "85%",
        margin: 1,
      },
    },
  );
}
