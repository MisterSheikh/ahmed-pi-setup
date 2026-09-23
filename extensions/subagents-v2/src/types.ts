import type {
  Api,
  Model,
  ThinkingLevel as ModelThinkingLevel,
} from "@earendil-works/pi-ai";

export type ThinkingLevel = "off" | ModelThinkingLevel;

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type ReportKind = "fyi" | "question" | "blocked";
export type TaskStatus =
  | "starting"
  | "working"
  | "stopping"
  | "completed"
  | "question"
  | "blocked"
  | "failed"
  | "interrupted"
  | "unknown";

export interface WorkerReport {
  kind: ReportKind;
  message: string;
  at: number;
}

export interface WorkerTask {
  id: string;
  brief: string;
  status: TaskStatus;
  startedAt: number;
  settledAt?: number;
  result?: string;
  resultTruncated?: boolean;
  error?: string;
  report?: WorkerReport;
}

export interface WorkerRecord {
  id: string;
  name: string;
  cwd: string;
  model: string;
  reasoning: ThinkingLevel;
  createdAt: number;
  updatedAt: number;
  sessionFile?: string;
  unavailableReason?: string;
  takenOver: boolean;
  currentTaskId?: string;
  tasks: WorkerTask[];
}

export interface PersistedState {
  version: 1;
  ownerSessionId: string;
  workers: WorkerRecord[];
}

/** Per-model reasoning policy: explicit allowed levels and an optional default. */
export interface ModelReasoningConfig {
  allowed: ThinkingLevel[];
  default?: ThinkingLevel;
}

export interface SubagentsConfig {
  version: 2;
  enabled: boolean;
  allowedModels: string[];
  modelReasoning: Record<string, ModelReasoningConfig>;
  defaultModel?: string;
  maxActive: number;
}

export interface ResolvedSelection {
  modelKey: string;
  model: Model<Api>;
  reasoning: ThinkingLevel;
}

export type ToolExecutionStatus = "running" | "completed" | "failed";

/** One ordered assistant content block for display. */
export type TranscriptPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; redacted?: boolean }
  | { type: "toolCall"; id: string; name: string; arguments?: unknown };

export interface SessionTranscriptItem {
  role: "user" | "assistant" | "tool" | "custom";
  /**
   * Plain visible text. For assistant items this excludes thinking and tool
   * calls; `parts` carries those so model-facing formatting never leaks them.
   */
  text: string;
  /**
   * Provenance when it is actually known. The SDK factory leaves this unset
   * because start/steer only carry strings; callers that know the sender may
   * set it. Never infer it from role alone.
   */
  source?: "parent" | "human";
  /** Ordered assistant blocks (text, thinking, tool calls). */
  parts?: TranscriptPart[];
  /** Tool-result linkage for role "tool". */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  status?: ToolExecutionStatus;
}

/** Live tool state for the current worker run. */
export interface WorkerPresentationTool {
  id: string;
  name: string;
  arguments?: unknown;
  status: ToolExecutionStatus;
  result?: string;
}

export interface WorkerQueuedMessage {
  kind: "steer" | "followup";
  text: string;
}

/**
 * Transient live view of a worker session. Never persisted and never used for
 * lifecycle decisions.
 */
export interface WorkerPresentation {
  transcript: SessionTranscriptItem[];
  streamingText?: string;
  streamingThinking?: string;
  activeTools?: WorkerPresentationTool[];
  queuedMessages?: WorkerQueuedMessage[];
  contextTokens?: number;
  contextWindow?: number;
  activity?: string;
}

export interface WorkerSessionCallbacks {
  onStarted(): void;
  onReport(kind: ReportKind, message: string): void;
  onCleanupError?(message: string): void;
  /** Fires when the live presentation snapshot changes. */
  onPresentation?(): void;
  onSettled(outcome: {
    result: string;
    error?: string;
    interrupted?: boolean;
  }): void;
}

export interface WorkerSession {
  readonly sessionFile: string | undefined;
  start(brief: string): void;
  steer(message: string): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  transcript(): SessionTranscriptItem[];
  /**
   * Live snapshot. Returns undefined when a session has no live view, letting
   * callers fall back to `transcript()`.
   */
  presentation?(): WorkerPresentation | undefined;
}

export interface WorkerSessionFactory {
  create(
    worker: WorkerRecord,
    callbacks: WorkerSessionCallbacks,
  ): Promise<WorkerSession>;
  readTranscript(worker: WorkerRecord): SessionTranscriptItem[];
}

export const isActiveStatus = (status: TaskStatus) =>
  status === "starting" || status === "working" || status === "stopping";

export const isStoppedStatus = (status: TaskStatus) => !isActiveStatus(status);

export const modelKey = (model: Pick<Model<Api>, "provider" | "id">) =>
  `${model.provider}/${model.id}`;

export function cloneWorker(worker: WorkerRecord): WorkerRecord {
  return {
    ...worker,
    tasks: worker.tasks.map((task) => ({
      ...task,
      report: task.report ? { ...task.report } : undefined,
    })),
  };
}
