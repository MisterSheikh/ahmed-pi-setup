export interface RoadmapTask {
  readonly text: string;
  readonly checked: boolean;
  readonly lineIndex: number;
}

export type RoadmapStageStatus =
  "complete" | "current" | "upcoming" | "untracked";

export interface RoadmapStage {
  readonly title: string;
  readonly lineIndex: number;
  readonly tasks: readonly RoadmapTask[];
  readonly status: RoadmapStageStatus;
}

export interface Roadmap {
  readonly markdown: string;
  readonly title: string;
  readonly currentFocus?: string;
  readonly stages: readonly RoadmapStage[];
  readonly totalTasks: number;
  readonly completedTasks: number;
  readonly currentStageIndex?: number;
  readonly nextOpenItem?: string;
  readonly complete: boolean;
}

interface MutableStage {
  title: string;
  lineIndex: number;
  tasks: RoadmapTask[];
}

interface Fence {
  readonly marker: "`" | "~";
  readonly length: number;
}

function headingText(raw: string) {
  return raw.replace(/[ \t]+#+[ \t]*$/, "").trim();
}

function plainText(raw: string) {
  return raw
    .replace(/<!--.*?-->/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function focusText(raw: string) {
  const withoutPrefix = raw
    .trim()
    .replace(/^>\s*/, "")
    .replace(/^[-*+]\s+/, "");
  if (!withoutPrefix || /^#{1,6}\s/.test(withoutPrefix)) return undefined;
  return plainText(withoutPrefix) || undefined;
}

function openingFence(line: string): Fence | undefined {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (!match) return undefined;
  const sequence = match[1];
  if (!sequence) return undefined;
  return {
    marker: sequence[0] as Fence["marker"],
    length: sequence.length,
  };
}

function closesFence(line: string, fence: Fence) {
  const marker = fence.marker === "`" ? "`" : "~";
  return new RegExp(`^ {0,3}${marker}{${fence.length},}\\s*$`).test(line);
}

export function parseRoadmap(markdown: string, fallbackTitle: string): Roadmap {
  const lines = markdown.split(/\r?\n/);
  let title: string | undefined;
  let currentFocus: string | undefined;
  let inCurrentFocus = false;
  let currentStage: MutableStage | undefined;
  let fence: Fence | undefined;
  const mutableStages: MutableStage[] = [];

  for (const [lineIndex, line] of lines.entries()) {
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }

    const nextFence = openingFence(line);
    if (nextFence) {
      fence = nextFence;
      continue;
    }

    const heading = line.match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/);
    if (heading) {
      const level = heading[1]?.length ?? 0;
      const text = headingText(heading[2] ?? "");
      if (level === 1 && !title && text) title = plainText(text);

      if (level === 2) {
        if (text.toLowerCase() === "current focus") {
          inCurrentFocus = true;
          currentStage = undefined;
        } else {
          inCurrentFocus = false;
          currentStage = { title: plainText(text), lineIndex, tasks: [] };
          mutableStages.push(currentStage);
        }
      }
      continue;
    }

    if (inCurrentFocus && !currentFocus) {
      currentFocus = focusText(line);
    }

    if (!currentStage) continue;
    const task = line.match(/^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (!task) continue;
    const text = plainText(task[2] ?? "");
    if (!text) continue;
    currentStage.tasks.push({
      text,
      checked: (task[1] ?? " ").toLowerCase() === "x",
      lineIndex,
    });
  }

  const currentStageIndex = mutableStages.findIndex((stage) =>
    stage.tasks.some((task) => !task.checked),
  );
  const stages: RoadmapStage[] = mutableStages.map((stage, index) => ({
    ...stage,
    status:
      stage.tasks.length === 0
        ? "untracked"
        : stage.tasks.every((task) => task.checked)
          ? "complete"
          : index === currentStageIndex
            ? "current"
            : "upcoming",
  }));
  const tasks = stages.flatMap((stage) => stage.tasks);
  const completedTasks = tasks.filter((task) => task.checked).length;
  const normalizedCurrentStageIndex =
    currentStageIndex === -1 ? undefined : currentStageIndex;
  const current =
    normalizedCurrentStageIndex === undefined
      ? undefined
      : stages[normalizedCurrentStageIndex];

  return {
    markdown,
    title: title || fallbackTitle,
    currentFocus,
    stages,
    totalTasks: tasks.length,
    completedTasks,
    currentStageIndex: normalizedCurrentStageIndex,
    nextOpenItem: current?.tasks.find((task) => !task.checked)?.text,
    complete: tasks.length > 0 && completedTasks === tasks.length,
  };
}

const STAGE_SYMBOL: Readonly<Record<RoadmapStageStatus, string>> = {
  complete: "✓",
  current: "◆",
  upcoming: "○",
  untracked: "–",
};

export function roadmapDisplayMarkdown(roadmap: Roadmap) {
  const lines = roadmap.markdown.split(/\r?\n/);
  for (const stage of roadmap.stages) {
    lines[stage.lineIndex] = `## ${STAGE_SYMBOL[stage.status]} ${stage.title}`;
  }
  return lines.join("\n");
}

function stageDisplayTitle(title: string) {
  return title.replace(/^\d+[.)]\s+/, "");
}

export function roadmapStageLabel(roadmap: Roadmap) {
  if (roadmap.complete) return "Complete";
  if (roadmap.currentStageIndex === undefined) return "No active stage";
  const stage = roadmap.stages[roadmap.currentStageIndex];
  return `Stage ${roadmap.currentStageIndex + 1}/${roadmap.stages.length}: ${stage ? stageDisplayTitle(stage.title) : "Untitled"}`;
}
