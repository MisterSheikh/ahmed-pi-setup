import * as fs from "node:fs";
import * as path from "node:path";
import {
  StringEnum,
  getSupportedThinkingLevels,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  ContextUsage,
  ExtensionFactory,
  InlineExtension,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  type ModelRuntime,
  CURRENT_SESSION_VERSION,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  ReportKind,
  SessionTranscriptItem,
  TranscriptPart,
  WorkerPresentationTool,
  WorkerQueuedMessage,
  WorkerRecord,
  WorkerSession,
  WorkerSessionCallbacks,
  WorkerSessionFactory,
} from "./types.ts";

const STOP_TIMEOUT_MS = 5_000;
const RESTRICTED_EXTENSION_TOOLS = new Set([
  "workflow",
  "ask_user",
  "request_user_input",
  "send_message",
  "message_peer",
]);

function isRestrictedExtensionTool(name: string) {
  return (
    name !== "subagent_report" &&
    (name.startsWith("subagent") || RESTRICTED_EXTENSION_TOOLS.has(name))
  );
}

const RESTRICTED_EXTENSION_NAMES = new Set([
  "subagents",
  "subagent",
  "ask-user",
  "ask_user",
  "workflow",
  "peer",
  "peer-messaging",
  "peer_messaging",
]);

function isRestrictedExtensionIdentity(extensionPath: string) {
  if (extensionPath.startsWith("<inline:") && extensionPath.endsWith(">")) {
    const name = extensionPath.slice("<inline:".length, -1);
    return RESTRICTED_EXTENSION_NAMES.has(name);
  }
  return extensionPath
    .split(/[\\/]/)
    .some((segment) => RESTRICTED_EXTENSION_NAMES.has(segment));
}

const WORKER_GUIDANCE = `You are a worker controlled by a parent Pi session.
Complete only the assignment in the user's task brief. You cannot delegate, contact peer workers, or ask the human directly.
Use subagent_report with kind fyi for useful progress that does not require an answer. If you need information, use kind question and stop. If work cannot continue, use kind blocked and stop.
Wait for background processes required by the task, inspect their final output, and only then give your final answer.`;

export interface PiWorkerSessionFactoryOptions {
  registry: ModelRegistry;
  agentDir?: string;
  parentCwd: string;
  projectTrusted: boolean;
  sessionRoot: string;
  modelRuntime?: ModelRuntime;
  extraExtensionFactories?: InlineExtension[];
}

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    4_096,
  );
}

async function bounded(
  operation: Promise<unknown>,
  label: string,
  timeoutMs = STOP_TIMEOUT_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assistantText(message: AssistantMessage) {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function messageText(message: unknown) {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const candidate = part as { type?: unknown; text?: unknown };
      if (candidate.type === "text" && typeof candidate.text === "string")
        return [candidate.text];
      return [];
    })
    .join("\n")
    .trim();
}

function stripTerminalControls(text: string) {
  return text
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-_]/g, "")
    .replace(/\t/g, " ")
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

/** Extract readable text from a tool result or partial result payload. */
function toolResultText(result: unknown): string {
  // Untyped tools can emit `undefined`/`null` progress or result payloads.
  if (result == null) return "";
  if (typeof result === "string") return stripTerminalControls(result).trim();
  return stripTerminalControls(messageText(result)).trim();
}

function assistantTranscriptParts(content: unknown): {
  parts: TranscriptPart[];
  text: string;
} {
  const parts: TranscriptPart[] = [];
  const textBlocks: string[] = [];
  if (Array.isArray(content)) {
    for (const value of content) {
      if (!value || typeof value !== "object") continue;
      const block = value as {
        type?: unknown;
        text?: unknown;
        thinking?: unknown;
        redacted?: unknown;
        id?: unknown;
        name?: unknown;
        arguments?: unknown;
      };
      if (block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text });
        textBlocks.push(block.text);
      } else if (
        block.type === "thinking" &&
        typeof block.thinking === "string"
      ) {
        parts.push({
          type: "thinking",
          text: block.thinking,
          ...(block.redacted === true ? { redacted: true } : {}),
        });
      } else if (
        block.type === "toolCall" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        parts.push({
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: block.arguments,
        });
      }
    }
  }
  return {
    parts,
    text: stripTerminalControls(textBlocks.join("\n")).trim(),
  };
}

function transcriptFromMessages(
  messages: readonly unknown[],
): SessionTranscriptItem[] {
  const result: SessionTranscriptItem[] = [];
  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as {
      role?: unknown;
      content?: unknown;
      toolName?: unknown;
      toolCallId?: unknown;
      isError?: unknown;
      stopReason?: unknown;
    };
    if (message.role === "assistant") {
      // Pending messages stream through `presentation().streamingText` instead.
      if (message.stopReason === "pending") continue;
      const { parts, text } = assistantTranscriptParts(message.content);
      const hasStructured = parts.some((part) => part.type !== "text");
      if (!text && !hasStructured) continue;
      const item: SessionTranscriptItem = { role: "assistant", text };
      if (parts.length > 0) item.parts = parts;
      result.push(item);
      continue;
    }
    const text = stripTerminalControls(messageText(message));
    if (!text) continue;
    if (message.role === "user") result.push({ role: "user", text });
    else if (message.role === "toolResult") {
      const toolName =
        typeof message.toolName === "string" ? message.toolName : undefined;
      const prefix = toolName ? `${toolName}: ` : "";
      const item: SessionTranscriptItem = {
        role: "tool",
        text: `${prefix}${text}`,
      };
      if (typeof message.toolCallId === "string")
        item.toolCallId = message.toolCallId;
      if (toolName) item.toolName = toolName;
      if (typeof message.isError === "boolean") {
        item.isError = message.isError;
        item.status = message.isError ? "failed" : "completed";
      }
      result.push(item);
    } else result.push({ role: "custom", text });
  }
  return result;
}

function modelForWorker(
  registry: ModelRegistry,
  worker: WorkerRecord,
): Model<Api> {
  const slash = worker.model.indexOf("/");
  const model =
    slash > 0
      ? registry.find(
          worker.model.slice(0, slash),
          worker.model.slice(slash + 1),
        )
      : undefined;
  if (
    !model ||
    !registry
      .getAvailable()
      .some((item) => item.provider === model.provider && item.id === model.id)
  ) {
    throw new Error(
      `Configured model "${worker.model}" is no longer available.`,
    );
  }
  if (!getSupportedThinkingLevels(model).includes(worker.reasoning)) {
    throw new Error(
      `Configured reasoning level "${worker.reasoning}" is no longer supported by ${worker.model}.`,
    );
  }
  return model;
}

function reportExtension(
  callbacks: WorkerSessionCallbacks,
  stopForReport: (kind: ReportKind) => void,
): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "subagent_report",
      label: "Report to Parent",
      description:
        "Send an informational update, question, or blocker to the parent. Questions and blockers stop this task until the parent follows up.",
      parameters: Type.Object({
        kind: StringEnum(["fyi", "question", "blocked"] as const),
        message: Type.String({
          maxLength: 4_096,
          description: "Concise report for the parent.",
        }),
      }),
      async execute(_toolCallId, params) {
        const message = params.message.trim();
        if (!message) throw new Error("Report message cannot be empty.");
        if (params.kind !== "fyi") stopForReport(params.kind);
        callbacks.onReport(params.kind as ReportKind, message);
        return {
          content: [
            {
              type: "text",
              text:
                params.kind === "fyi"
                  ? "Update sent to the parent. Continue working."
                  : "Report sent to the parent. Stop now and wait for a follow-up.",
            },
          ],
          details: { kind: params.kind },
          terminate: params.kind !== "fyi",
        };
      },
    });
  };
}

function isPrivateSessionFile(file: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function hasDetails(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function toolDetails(value: unknown): Record<string, unknown> | undefined {
  if (!hasDetails(value) || !hasDetails(value.details)) return undefined;
  return value.details;
}

async function shutdownSession(session: AgentSession) {
  const failures: string[] = [];
  try {
    session.clearQueue();
  } catch (error) {
    failures.push(`clear queued work: ${errorText(error)}`);
  }
  try {
    await bounded(session.abort(), "Worker abort");
  } catch (error) {
    failures.push(`abort active work: ${errorText(error)}`);
  }
  try {
    if (session.extensionRunner.hasHandlers("session_shutdown")) {
      await bounded(
        session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        }),
        "Worker extension shutdown",
      );
    }
  } catch (error) {
    failures.push(`extension shutdown: ${errorText(error)}`);
  }
  try {
    session.dispose();
  } catch (error) {
    failures.push(`session dispose: ${errorText(error)}`);
  }
  if (failures.length > 0) throw new Error(failures.join("; "));
}

export class PiWorkerSessionFactory implements WorkerSessionFactory {
  private readonly options: PiWorkerSessionFactoryOptions;
  private readonly agentDir: string;

  constructor(options: PiWorkerSessionFactoryOptions) {
    this.options = options;
    this.agentDir = options.agentDir ?? getAgentDir();
  }

  private validateSessionFile(worker: WorkerRecord) {
    if (!worker.sessionFile) return;
    if (!isPrivateSessionFile(worker.sessionFile, this.options.sessionRoot)) {
      throw new Error(
        "Worker session reference is outside its private session directory.",
      );
    }
    const root = fs.realpathSync(this.options.sessionRoot);
    const file = fs.realpathSync(worker.sessionFile);
    if (!isPrivateSessionFile(file, root)) {
      throw new Error(
        "Worker session resolves outside its private session directory.",
      );
    }
    const lines = fs
      .readFileSync(worker.sessionFile, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    if (lines.length === 0) {
      throw new Error("Worker session file is empty.");
    }
    const entries = lines.map((line) => {
      try {
        const entry: unknown = JSON.parse(line);
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error("Session entry must be an object.");
        }
        return entry as Record<string, unknown>;
      } catch (error) {
        throw new Error(`Invalid worker session entry: ${errorText(error)}`);
      }
    });
    const header = entries[0];
    if (
      header?.type !== "session" ||
      header.version !== CURRENT_SESSION_VERSION ||
      typeof header.id !== "string" ||
      typeof header.timestamp !== "string" ||
      typeof header.cwd !== "string"
    ) {
      throw new Error("Worker session has no valid current-version header.");
    }
    const manager = SessionManager.open(
      worker.sessionFile,
      this.options.sessionRoot,
      worker.cwd,
    );
    manager.buildSessionProjection();
  }

  async create(
    worker: WorkerRecord,
    callbacks: WorkerSessionCallbacks,
  ): Promise<WorkerSession> {
    const model = modelForWorker(this.options.registry, worker);
    let stopForReport = (_kind: ReportKind) => {};
    const agentDir = this.agentDir;
    const settingsManager = SettingsManager.create(worker.cwd, agentDir, {
      projectTrusted:
        path.resolve(worker.cwd) === path.resolve(this.options.parentCwd)
          ? this.options.projectTrusted
          : false,
    });
    const reportName = "subagent-report";
    const deniedExtensionTools = new Set([
      "subagent_spawn",
      "subagent_followup",
      "subagent_steer",
      "subagent_interrupt",
      "subagent_wait",
      "subagent_list",
      "subagent_cancel",
      "subagent_check",
      "subagent",
      ...RESTRICTED_EXTENSION_TOOLS,
    ]);
    const loader = new DefaultResourceLoader({
      cwd: worker.cwd,
      agentDir,
      settingsManager,
      appendSystemPrompt: [WORKER_GUIDANCE],
      extensionFactories: [
        {
          name: reportName,
          factory: reportExtension(callbacks, (kind) => stopForReport(kind)),
        },
        ...(this.options.extraExtensionFactories ?? []),
      ],
      extensionsOverride: (loaded) => ({
        ...loaded,
        // Keep ordinary workspace resources (including their hooks) unless
        // they expose delegation, peer, or human-question tools. The inline
        // reporter is the one explicit subagent_* exception.
        extensions: loaded.extensions.filter((extension) => {
          if (extension.path === `<inline:${reportName}>`) return true;
          const toolNames = [...extension.tools.keys()];
          const restricted =
            isRestrictedExtensionIdentity(extension.path) ||
            isRestrictedExtensionIdentity(extension.resolvedPath) ||
            toolNames.some(isRestrictedExtensionTool);
          if (!restricted) return true;
          for (const name of toolNames) deniedExtensionTools.add(name);
          return false;
        }),
      }),
    });
    await loader.reload();
    fs.mkdirSync(this.options.sessionRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.options.sessionRoot, 0o700);
    if (worker.sessionFile) this.validateSessionFile(worker);
    const sessionManager = worker.sessionFile
      ? SessionManager.open(
          worker.sessionFile,
          this.options.sessionRoot,
          worker.cwd,
        )
      : SessionManager.create(worker.cwd, this.options.sessionRoot);
    const created = await createAgentSession({
      cwd: worker.cwd,
      model,
      modelRuntime: this.options.modelRuntime,
      thinkingLevel: worker.reasoning,
      sessionManager,
      settingsManager,
      resourceLoader: loader,
      excludeTools: [...deniedExtensionTools],
    });
    const session = created.session;
    if (created.modelFallbackMessage) {
      await shutdownSession(session);
      throw new Error(
        `Refusing model fallback: ${created.modelFallbackMessage}`,
      );
    }
    try {
      await session.bindExtensions({ mode: "print" });
    } catch (error) {
      await shutdownSession(session);
      throw error;
    }
    session.sessionManager.appendSessionInfo(`subagent: ${worker.name}`);

    let closed = false;
    let runSerial = 0;
    let currentSerial = 0;
    let settledSerial = 0;
    let runText = "";
    let runError: string | undefined;
    let interrupted = false;
    let paused = false;
    let reportStopRequested = false;
    let waitingForBackground = false;
    let cleanupPending = false;
    let cleanupInProgress: Promise<void> | undefined;
    let promptStartExpected = false;
    const backgroundIds = new Set<string>();

    // Transient presentation state. It is never persisted and never consulted
    // by lifecycle or settle decisions.
    let streamingText = "";
    let streamingThinking = "";
    let activity: string | undefined;
    let contextUsage: ContextUsage | undefined;
    let queuedMessages: WorkerQueuedMessage[] = [];
    const activeTools = new Map<string, WorkerPresentationTool>();

    const notifyPresentation = () => {
      if (closed) return;
      try {
        callbacks.onPresentation?.();
      } catch {
        // Presentation observers must not break worker lifecycle transitions.
      }
    };

    const refreshContextUsage = () => {
      try {
        contextUsage = session.getContextUsage();
      } catch {
        contextUsage = undefined;
      }
    };

    const consumeBackgroundResult = (id: unknown) => {
      if (typeof id === "string") backgroundIds.delete(id);
    };

    const trackBackgroundTool = (
      event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
    ) => {
      const details = toolDetails(event.result);
      if (!details) return;
      if (event.toolName === "bg_start" && typeof details.id === "string") {
        backgroundIds.add(details.id);
      } else if (
        event.toolName === "bg_status" &&
        details.status !== "running"
      ) {
        consumeBackgroundResult(details.id);
      } else if (
        event.toolName === "bg_kill" &&
        Array.isArray(details.results)
      ) {
        for (const item of details.results) {
          if (hasDetails(item)) consumeBackgroundResult(item.id);
        }
      }
    };

    const killOwnedBackgroundProcesses = async () => {
      while (backgroundIds.size > 0) {
        const ids = [...backgroundIds];
        const tool = session.getToolDefinition("bg_kill");
        if (!tool) {
          throw new Error(
            "Cannot stop worker-owned background processes: bg_kill is unavailable.",
          );
        }
        await bounded(
          tool.execute(
            "subagent-cleanup",
            { ids },
            undefined,
            undefined,
            session.extensionRunner.createContext(),
          ),
          "Worker background-process cleanup",
          3_500,
        );
        for (const id of ids) backgroundIds.delete(id);
      }
    };

    const stopAndCleanup = () => {
      if (cleanupInProgress) return cleanupInProgress;
      cleanupPending = true;
      const cleanup = (async () => {
        const failures: string[] = [];
        try {
          session.clearQueue();
        } catch (error) {
          failures.push(`clear queued work: ${errorText(error)}`);
        }
        const [abortResult, killResult] = await Promise.allSettled([
          bounded(session.abort(), "Worker abort", 1_500),
          killOwnedBackgroundProcesses(),
        ]);
        if (abortResult.status === "rejected")
          failures.push(`abort active work: ${errorText(abortResult.reason)}`);
        if (killResult.status === "rejected")
          failures.push(
            `stop background processes: ${errorText(killResult.reason)}`,
          );
        try {
          // Abort may finish a sibling bg_start after the first kill snapshot.
          await killOwnedBackgroundProcesses();
        } catch (error) {
          failures.push(`stop late background processes: ${errorText(error)}`);
        }
        try {
          // A terminal result can queue a follow-up while abort and kill run.
          session.clearQueue();
        } catch (error) {
          failures.push(`clear late queued work: ${errorText(error)}`);
        }
        if (failures.length > 0) throw new Error(failures.join("; "));
        cleanupPending = false;
        activity = undefined;
        notifyPresentation();
        if (session.isIdle) settle(currentSerial);
      })();
      cleanupInProgress = cleanup;
      void cleanup.then(
        () => {
          if (cleanupInProgress === cleanup) cleanupInProgress = undefined;
        },
        (error: unknown) => {
          if (cleanupInProgress === cleanup) cleanupInProgress = undefined;
          try {
            callbacks.onCleanupError?.(errorText(error));
          } catch {
            // A diagnostic callback must not create an unhandled rejection.
          }
        },
      );
      return cleanup;
    };

    stopForReport = () => {
      paused = true;
      reportStopRequested = true;
      cleanupPending = true;
    };

    const settle = (serial: number) => {
      if (closed || serial !== currentSerial || settledSerial === serial)
        return;
      if (cleanupPending) return;
      if (backgroundIds.size > 0) {
        if (runError) {
          paused = true;
          cleanupPending = true;
          void stopAndCleanup().catch(() => {});
        } else if (!paused) {
          waitingForBackground = true;
        }
        return;
      }
      settledSerial = serial;
      promptStartExpected = false;
      callbacks.onSettled({ result: runText, error: runError, interrupted });
    };

    const handlePresentationEvent = (event: AgentSessionEvent) => {
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent;
        if (update.type === "start") {
          streamingText = "";
          streamingThinking = "";
        } else if (update.type === "text_delta") {
          streamingText += update.delta;
          activity = "responding";
        } else if (update.type === "thinking_delta") {
          streamingThinking += update.delta;
          activity = "thinking";
        } else {
          return;
        }
        notifyPresentation();
      } else if (event.type === "tool_execution_start") {
        activeTools.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolName,
          arguments: event.args,
          status: "running",
        });
        activity = `using ${event.toolName}`;
        notifyPresentation();
      } else if (event.type === "tool_execution_update") {
        const tool = activeTools.get(event.toolCallId);
        if (tool) {
          const preview = toolResultText(event.partialResult);
          if (preview) tool.result = preview;
          notifyPresentation();
        }
      } else if (event.type === "tool_execution_end") {
        const tool = activeTools.get(event.toolCallId) ?? {
          id: event.toolCallId,
          name: event.toolName,
          status: "running" as const,
        };
        tool.status = event.isError ? "failed" : "completed";
        const result = toolResultText(event.result);
        if (result) tool.result = result;
        activeTools.set(event.toolCallId, tool);
        activity = "working";
        refreshContextUsage();
        notifyPresentation();
      } else if (event.type === "queue_update") {
        queuedMessages = [
          ...event.steering.map((text) => ({ kind: "steer" as const, text })),
          ...event.followUp.map((text) => ({
            kind: "followup" as const,
            text,
          })),
        ];
        notifyPresentation();
      }
    };

    const handleEvent = (event: AgentSessionEvent) => {
      if (closed) return;
      handlePresentationEvent(event);
      if (event.type === "agent_start") {
        // Retries and queued continuations can emit agent_start again within
        // one task. Only reject starts after that task has actually settled.
        if (paused || settledSerial === currentSerial) {
          // Do not await inside the event; abort is requested synchronously
          // before an unsolicited continuation can make another model request.
          void stopAndCleanup().catch(() => {});
          return;
        }
        promptStartExpected = false;
        if (waitingForBackground) {
          waitingForBackground = false;
          runText = "";
          runError = undefined;
          interrupted = false;
        }
        activity = "working";
        notifyPresentation();
        callbacks.onStarted();
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        runText = assistantText(event.message);
        runError =
          event.message.stopReason === "error"
            ? (event.message.errorMessage ?? "Worker run failed.")
            : undefined;
        interrupted = event.message.stopReason === "aborted";
        streamingText = "";
        streamingThinking = "";
        refreshContextUsage();
        notifyPresentation();
      }
      if (event.type === "turn_end" && reportStopRequested) {
        reportStopRequested = false;
        // turn_end follows persistence of every result in the tool batch. Start
        // abort asynchronously so Pi can finish the event and settle.
        void stopAndCleanup().catch(() => {});
      }
      if (event.type === "tool_execution_end") trackBackgroundTool(event);
      if (event.type === "message_end" && event.message.role === "custom") {
        if (
          event.message.customType === "background-terminal-result" &&
          hasDetails(event.message.details)
        ) {
          consumeBackgroundResult(event.message.details.id);
        }
      }
      if (
        event.type === "entry_appended" &&
        event.entry.type === "custom_message"
      ) {
        if (
          event.entry.customType === "background-terminal-result" &&
          hasDetails(event.entry.details)
        ) {
          consumeBackgroundResult(event.entry.details.id);
        }
      }
      if (event.type === "agent_settled") {
        settle(currentSerial);
        activity = waitingForBackground ? "waiting for background" : undefined;
        refreshContextUsage();
        notifyPresentation();
      }
    };
    const unsubscribe = session.subscribe(handleEvent);

    const start = (brief: string) => {
      if (closed) throw new Error("Worker session is closed.");
      if (!session.isIdle) throw new Error("Worker is already active.");
      session.clearQueue();
      currentSerial = ++runSerial;
      runText = "";
      runError = undefined;
      interrupted = false;
      paused = false;
      reportStopRequested = false;
      waitingForBackground = false;
      cleanupPending = false;
      promptStartExpected = true;
      streamingText = "";
      streamingThinking = "";
      activeTools.clear();
      queuedMessages = [];
      activity = "starting";
      refreshContextUsage();
      notifyPresentation();
      const serial = currentSerial;
      void session
        .prompt(brief, {
          expandPromptTemplates: false,
          source: "extension",
        })
        .then(
          () => {
            if (
              serial === currentSerial &&
              promptStartExpected &&
              session.isIdle
            ) {
              // An input handler may consume extension input without starting
              // a model run. Treat that as a settled task, not a held slot.
              promptStartExpected = false;
              settle(serial);
            }
          },
          (error: unknown) => {
            runError = errorText(error);
            promptStartExpected = false;
            if (serial === currentSerial && session.isIdle) settle(serial);
          },
        );
    };

    return {
      get sessionFile() {
        return session.sessionFile;
      },
      start,
      steer: async (message) => {
        if (closed) throw new Error("Worker session is closed.");
        if (session.isIdle && !waitingForBackground)
          throw new Error("Worker is idle.");
        await session.steer(message, undefined, { source: "extension" });
      },
      interrupt: async () => {
        if (closed) return;
        paused = true;
        interrupted = true;
        reportStopRequested = false;
        cleanupPending = true;
        await bounded(
          stopAndCleanup(),
          "Worker interrupt cleanup",
          STOP_TIMEOUT_MS,
        );
        activity = undefined;
        notifyPresentation();
        if (session.isIdle) settle(currentSerial);
      },
      close: async () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        await shutdownSession(session);
      },
      transcript: () => transcriptFromMessages(session.messages),
      presentation: () => ({
        transcript: transcriptFromMessages(session.messages),
        streamingText: streamingText || undefined,
        streamingThinking: streamingThinking || undefined,
        activeTools:
          activeTools.size > 0
            ? [...activeTools.values()].map((tool) => ({ ...tool }))
            : undefined,
        queuedMessages:
          queuedMessages.length > 0
            ? queuedMessages.map((message) => ({ ...message }))
            : undefined,
        contextTokens: contextUsage?.tokens ?? undefined,
        contextWindow: contextUsage?.contextWindow ?? model.contextWindow,
        activity,
      }),
    };
  }

  readTranscript(worker: WorkerRecord): SessionTranscriptItem[] {
    if (!worker.sessionFile) return [];
    this.validateSessionFile(worker);
    const manager = SessionManager.open(
      worker.sessionFile,
      this.options.sessionRoot,
      worker.cwd,
    );
    return transcriptFromMessages(manager.buildSessionProjection().messages);
  }
}
