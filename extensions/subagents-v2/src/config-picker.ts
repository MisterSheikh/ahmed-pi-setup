import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable } from "@earendil-works/pi-tui";
import {
  fuzzyFilter,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./format.ts";
import { modelKey, type ThinkingLevel } from "./types.ts";

/** Optional per-model reasoning policy used by the version 2 config shape. */
export interface ModelReasoningPolicy {
  allowed: ThinkingLevel[];
  default?: ThinkingLevel;
}

/**
 * The subset of the Subagents V2 configuration this picker edits.
 * The persisted config adds its own `version` field; the picker never writes
 * files, it only hands complete candidate configs to `onChange`.
 */
export interface ConfigPickerConfig {
  enabled: boolean;
  allowedModels: string[];
  modelReasoning: Record<string, ModelReasoningPolicy>;
  maxActive: number;
  defaultModel?: string;
}

/** Minimal theme surface so the picker stays testable without a real Theme. */
export interface ConfigPickerTheme {
  fg(color: ThemeColor, text: string): string;
  bold(text: string): string;
}

/** Minimal TUI surface; the real TUI satisfies this. */
export interface ConfigPickerTui {
  requestRender(): void;
  /** Optional so tests can simulate short terminals; the real TUI exposes it. */
  terminal?: { rows: number };
}

/** Minimal model registry surface; ModelRegistry satisfies this. */
export interface ConfigPickerRegistry {
  getAvailable(): Model<Api>[];
  find(provider: string, modelId: string): Model<Api> | undefined;
}

export interface ConfigPickerOptions<T extends ConfigPickerConfig> {
  tui: ConfigPickerTui;
  theme: ConfigPickerTheme;
  registry: ConfigPickerRegistry;
  /** Only real, provider-supported levels for the given model. */
  supportedReasoning(model: Model<Api>): readonly ThinkingLevel[];
  initial: T;
  /** Persist and apply a complete candidate config. Reject to signal failure. */
  onChange(config: T): Promise<void>;
  /** Called once when the popup closes. */
  done(): void;
}

type Screen = "settings" | "models" | "reasoning";
type ModelsMode = "manage" | "default";

interface ModelEntry {
  key: string;
  model?: Model<Api>;
  available: boolean;
  supported: ThinkingLevel[];
}

const SETTINGS_ROWS = 4;
const MAX_MODEL_ROWS = 12;
const MAX_REASONING_ROWS = 8;
const MAX_LINES = 24;
/** Columns consumed by the box's left and right border. */
const BORDER_WIDTH = 2;
/** Horizontal and vertical padding between the frame and its content. */
const PADDING_X = 1;
const PADDING_Y = 1;
/** Below this width the box frame is dropped so tiny terminals stay usable. */
const MIN_FRAME_WIDTH = 6;

/** Strip control sequences and collapse newlines so text cannot break layout. */
function safeText(text: string): string {
  return sanitizeTerminalText(text).replace(/\n+/g, " ");
}

/**
 * Pad or truncate a themed line to exactly `width` visible columns. ANSI
 * sequences, including the focused Input's zero-width cursor marker, are kept
 * intact when the line already fits so the TUI can still position the cursor.
 */
function padToWidth(text: string, width: number): string {
  const safeWidth = Math.max(0, Math.floor(width));
  const current = visibleWidth(text);
  if (current === safeWidth) return text;
  if (current > safeWidth) return truncateToWidth(text, safeWidth, "");
  return text + " ".repeat(safeWidth - current);
}

/** Pick the longest help hint that fits, so the Escape hint stays visible. */
function fitHint(
  width: number,
  full: string,
  compact: string,
  minimal: string,
): string {
  if (visibleWidth(full) <= width) return full;
  if (visibleWidth(compact) <= width) return compact;
  return minimal;
}

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: "No reasoning",
  minimal: "Very brief reasoning",
  low: "Light reasoning",
  medium: "Moderate reasoning",
  high: "Deep reasoning",
  xhigh: "Extra-high reasoning",
  max: "Maximum reasoning",
};

function cloneConfig<T>(config: T): T {
  return structuredClone(config);
}

function windowRange(
  total: number,
  selected: number,
  maxVisible: number,
): [number, number] {
  if (total <= maxVisible) return [0, total];
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(maxVisible / 2), total - maxVisible),
  );
  return [start, start + maxVisible];
}

/**
 * Dedicated popup configuration for Subagents V2.
 *
 * Screens:
 * - settings: enabled, maxActive, optional default model, models entry point
 * - models: searchable, fuzzy-filtered model list; Space toggles allowed
 * - reasoning: only real supported levels; Space toggles; `d` sets/clears default
 *
 * Every valid edit is applied immediately through `onChange`. A rejected write
 * reverts the local draft and shows the error; it is never reported as applied.
 * New models stay pending until at least one reasoning level is selected.
 */
export class ConfigPicker<T extends ConfigPickerConfig = ConfigPickerConfig>
  implements Component, Focusable
{
  private readonly tui: ConfigPickerTui;
  private readonly theme: ConfigPickerTheme;
  private readonly registry: ConfigPickerRegistry;
  private readonly supported: (model: Model<Api>) => readonly ThinkingLevel[];
  private readonly onChange: (config: T) => Promise<void>;
  private readonly done: () => void;
  private readonly search: Input;

  private draft: T;
  private persisted: T;
  private view: Screen = "settings";
  private modelsMode: ModelsMode = "manage";
  private settingsIndex = 0;
  private selectedModelKey?: string;
  private reasoningKey?: string;
  private reasoningIndex = 0;
  private pendingModel?: string;
  private allEntries: ModelEntry[] = [];
  private filteredEntries: ModelEntry[] = [];
  private error?: string;
  private saving = false;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  private cached?: { key: string; lines: string[] };
  private focusedValue = false;

  constructor(options: ConfigPickerOptions<T>) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.registry = options.registry;
    this.supported = options.supportedReasoning;
    this.onChange = options.onChange;
    this.done = options.done;
    this.draft = cloneConfig(options.initial);
    this.persisted = cloneConfig(options.initial);
    // Match Pi's default model selector: a plain "> " prompt and no placeholder.
    this.search = new Input();
    this.refreshEntries();
  }

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.search.focused = value;
    this.invalidate();
  }

  get screen(): Screen {
    return this.view;
  }

  get config(): T {
    return this.draft;
  }

  get query(): string {
    return this.search.getValue();
  }

  get pending(): string | undefined {
    return this.pendingModel;
  }

  /** Resolves once every queued write has settled. */
  flush(): Promise<void> {
    return this.queue;
  }

  invalidate(): void {
    this.cached = undefined;
  }

  handleInput(data: string): void {
    // Serialize writes: ignore input while a write is in flight so a rejected
    // change cannot be followed by a change computed from stale state.
    if (this.saving || this.closed) return;
    if (this.view === "settings") this.handleSettingsInput(data);
    else if (this.view === "models") this.handleModelsInput(data);
    else this.handleReasoningInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width));
    const key = `${safeWidth}:${this.rowBudget()}`;
    if (this.cached?.key === key) return this.cached.lines;
    const framed = safeWidth >= MIN_FRAME_WIDTH;
    // Borders and padding are columns the content cannot use.
    const contentWidth = framed
      ? Math.max(1, safeWidth - BORDER_WIDTH - PADDING_X * 2)
      : safeWidth;
    // The frame and its vertical inset consume rows from the height budget.
    const budget = framed
      ? Math.max(1, this.rowBudget() - BORDER_WIDTH - PADDING_Y * 2)
      : this.rowBudget();
    const content = this.renderScreen(contentWidth, budget);
    const rendered = (framed ? this.frame(safeWidth, content) : content).map(
      (line) => truncateToWidth(line, safeWidth),
    );
    this.cached = { key, lines: rendered };
    return rendered;
  }

  /**
   * Wrap content lines in a box whose left/right borders join the top and
   * bottom edges. Every content line is padded to the inner content width so
   * the borders line up regardless of theme ANSI codes or wide characters.
   */
  private frame(width: number, lines: string[]): string[] {
    const t = this.theme;
    const inner = Math.max(1, width - BORDER_WIDTH);
    const contentWidth = Math.max(1, inner - PADDING_X * 2);
    const pad = " ".repeat(PADDING_X);
    const side = t.fg("accent", "│");
    const top = t.fg("accent", `┌${"─".repeat(inner)}┐`);
    const bottom = t.fg("accent", `└${"─".repeat(inner)}┘`);
    const framedLine = (line: string) =>
      `${side}${pad}${padToWidth(line, contentWidth)}${pad}${side}`;
    const inset = Array.from({ length: PADDING_Y }, () => framedLine(""));
    const body = lines.map(framedLine);
    return [top, ...inset, ...body, ...inset, bottom];
  }

  /** Total lines the popup may occupy, derived from the terminal height. */
  private rowBudget(): number {
    const rows = this.tui.terminal?.rows;
    if (!rows || rows <= 0) return MAX_LINES;
    return Math.max(6, Math.min(MAX_LINES, Math.floor(rows) - 2));
  }

  /**
   * Trim decorative header/footer lines until the focused body plus the help
   * and status lines fit the budget. Body and help are never dropped.
   */
  private fitChrome(
    header: string[],
    footer: string[],
    budget: number,
    minBody: number,
  ): { header: string[]; footer: string[] } {
    const head = [...header];
    const foot = [...footer];
    const isBlank = (line: string) => visibleWidth(line) === 0;
    while (head.length + foot.length + minBody > budget) {
      const hi = head.findIndex(isBlank);
      if (hi >= 0) {
        head.splice(hi, 1);
        continue;
      }
      const fi = foot.findIndex(isBlank);
      if (fi >= 0) {
        foot.splice(fi, 1);
        continue;
      }
      break;
    }
    while (head.length + foot.length + minBody > budget && head.length > 0) {
      head.shift();
    }
    return { header: head, footer: foot };
  }

  private renderScreen(width: number, budget: number): string[] {
    if (this.view === "settings") return this.renderSettings(width, budget);
    if (this.view === "models") return this.renderModels(width, budget);
    return this.renderReasoning(width, budget);
  }

  private renderSettings(width: number, budget: number): string[] {
    const t = this.theme;
    const header = [t.fg("accent", t.bold("Subagents V2 configuration")), ""];
    const footer = [
      "",
      this.statusLine(),
      t.fg(
        "dim",
        fitHint(
          width,
          "↑↓ move · Space toggle/clear · ←→ adjust · Enter open · Esc close",
          "↑↓ · Space · ←→ · Enter · Esc close",
          "Esc close",
        ),
      ),
    ];
    const rows: Array<{ label: string; value: string }> = [
      {
        label: "Enabled",
        value: this.draft.enabled
          ? t.fg("success", "yes")
          : t.fg("muted", "no"),
      },
      { label: "Max active", value: String(this.draft.maxActive) },
      {
        label: "Default model",
        value: this.draft.defaultModel
          ? safeText(this.draft.defaultModel)
          : t.fg("muted", "none"),
      },
      {
        label: "Models",
        value: `${this.draft.allowedModels.length} allowed${
          this.pendingModel ? ` · ${t.fg("warning", "1 pending")}` : ""
        }`,
      },
    ];
    const { header: head, footer: foot } = this.fitChrome(
      header,
      footer,
      budget,
      rows.length,
    );
    const body: string[] = [];
    const [start, end] = windowRange(
      rows.length,
      this.settingsIndex,
      Math.max(1, budget - head.length - foot.length),
    );
    for (let index = start; index < end; index++) {
      const selected = index === this.settingsIndex;
      const cursor = selected ? t.fg("accent", "→ ") : "  ";
      const label = selected
        ? t.fg("accent", rows[index].label.padEnd(16))
        : rows[index].label.padEnd(16);
      body.push(`${cursor}${label}${rows[index].value}`);
    }
    return [...head, ...body, ...foot];
  }

  private renderModels(width: number, budget: number): string[] {
    const t = this.theme;
    const title =
      this.modelsMode === "default" ? "Default model" : "Allowed models";
    const header = [
      t.fg("accent", t.bold(title)),
      "",
      ...this.search.render(Math.max(1, width)),
      "",
    ];
    const hint =
      this.modelsMode === "default"
        ? fitHint(
            width,
            "↑↓ move · Enter set default · Space toggle · → reasoning · Esc back",
            "↑↓ · Enter default · Space · → · Esc back",
            "Esc back",
          )
        : fitHint(
            width,
            "↑↓ move · Space toggle · → reasoning · Esc back",
            "↑↓ · Space · → · Esc back",
            "Esc back",
          );
    const footer = ["", this.statusLine(), t.fg("dim", hint)];
    const { header: head, footer: foot } = this.fitChrome(
      header,
      footer,
      budget,
      1,
    );
    const maxBody = Math.max(1, budget - head.length - foot.length);
    return [...head, ...this.renderModelsBody(width, maxBody), ...foot];
  }

  private renderModelsBody(width: number, maxBody: number): string[] {
    const t = this.theme;
    if (this.filteredEntries.length === 0) {
      return [` ${t.fg("muted", "No matching models")}`];
    }
    const total = this.filteredEntries.length;
    const selected = this.selectedModelIndex();
    const rowCap = Math.min(maxBody, MAX_MODEL_ROWS);
    const needsScroll = total > rowCap;
    const visible = needsScroll ? Math.max(1, rowCap - 1) : rowCap;
    const [start, end] = windowRange(total, selected, visible);
    const body: string[] = [];
    for (let index = start; index < end; index++) {
      body.push(
        this.renderModelRow(
          this.filteredEntries[index],
          index === selected,
          width,
        ),
      );
    }
    if (needsScroll && body.length < maxBody) {
      body.push(` ${t.fg("dim", `(${selected + 1}/${total})`)}`);
    }
    return body;
  }

  private renderModelRow(
    entry: ModelEntry,
    selected: boolean,
    _width: number,
  ): string {
    const t = this.theme;
    const allowed = this.draft.allowedModels.includes(entry.key);
    const pending = this.pendingModel === entry.key;
    const box = allowed
      ? t.fg("success", "[x]")
      : pending
        ? t.fg("warning", "[~]")
        : t.fg("dim", "[ ]");
    const displayKey = safeText(entry.key);
    const cursor = selected ? t.fg("accent", "→ ") : "  ";
    const label = selected
      ? t.fg("accent", displayKey)
      : allowed
        ? t.fg("text", displayKey)
        : t.fg("muted", displayKey);
    const unavailable = entry.available
      ? ""
      : t.fg("warning", " (unavailable)");
    const policy = this.draft.modelReasoning[entry.key];
    const levels = policy
      ? policy.allowed.filter((level) => entry.supported.includes(level))
      : [];
    let summary: string;
    if (pending && levels.length === 0) {
      summary = t.fg("warning", "needs reasoning");
    } else if (levels.length === 0) {
      summary = t.fg("dim", "no reasoning");
    } else {
      summary = t.fg(
        "muted",
        `${levels.join(", ")}${
          policy?.default ? ` · default ${safeText(policy.default)}` : ""
        }`,
      );
    }
    return `${cursor}${box} ${label}${unavailable}  ${summary}`;
  }

  private renderReasoning(width: number, budget: number): string[] {
    const t = this.theme;
    const header = [
      t.fg(
        "accent",
        t.bold(`Reasoning · ${safeText(this.reasoningKey ?? "")}`),
      ),
      "",
    ];
    const footer = [
      "",
      this.statusLine(),
      t.fg(
        "dim",
        fitHint(
          width,
          "↑↓ move · Space toggle · d default · Esc back",
          "↑↓ · Space · d · Esc back",
          "Esc back",
        ),
      ),
    ];
    const { header: head, footer: foot } = this.fitChrome(
      header,
      footer,
      budget,
      1,
    );
    const maxBody = Math.max(1, budget - head.length - foot.length);
    return [...head, ...this.renderReasoningBody(width, maxBody), ...foot];
  }

  private renderReasoningBody(width: number, maxBody: number): string[] {
    const t = this.theme;
    const entry = this.reasoningEntry();
    if (!entry || !entry.model) {
      return [
        ` ${t.fg("warning", "No model definition available; supported levels are unknown.")}`,
      ];
    }
    if (entry.supported.length === 0) {
      return [` ${t.fg("muted", "This model supports no reasoning levels.")}`];
    }
    const total = entry.supported.length;
    const rowCap = Math.min(maxBody, MAX_REASONING_ROWS);
    const needsScroll = total > rowCap;
    const visible = needsScroll ? Math.max(1, rowCap - 1) : rowCap;
    const [start, end] = windowRange(total, this.reasoningIndex, visible);
    const policy = this.reasoningKey
      ? this.draft.modelReasoning[this.reasoningKey]
      : undefined;
    const body: string[] = [];
    for (let index = start; index < end; index++) {
      const level = entry.supported[index];
      const selected = index === this.reasoningIndex;
      const allowed = policy?.allowed.includes(level) ?? false;
      const isDefault = policy?.default === level;
      const box = allowed ? t.fg("success", "[x]") : t.fg("dim", "[ ]");
      const cursor = selected ? t.fg("accent", "→ ") : "  ";
      const name = selected ? t.fg("accent", level.padEnd(9)) : level.padEnd(9);
      const description = t.fg("muted", LEVEL_DESCRIPTIONS[level] ?? "");
      const badge = isDefault ? ` ${t.fg("success", "default")}` : "";
      body.push(`${cursor}${box} ${name}${description}${badge}`);
    }
    if (needsScroll && body.length < maxBody) {
      body.push(` ${t.fg("dim", `(${this.reasoningIndex + 1}/${total})`)}`);
    }
    return body;
  }

  private handleSettingsInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.settingsIndex =
        (this.settingsIndex - 1 + SETTINGS_ROWS) % SETTINGS_ROWS;
      this.refreshRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.settingsIndex = (this.settingsIndex + 1) % SETTINGS_ROWS;
      this.refreshRender();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      void this.close();
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.activateSettingsRow(false);
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.activateSettingsRow(true, -1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.activateSettingsRow(true, 1);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.settingsIndex === 2) this.openModels("default");
      else if (this.settingsIndex === 3) this.openModels("manage");
      else this.activateSettingsRow(false);
    }
  }

  private activateSettingsRow(adjust: boolean, delta = 0): void {
    if (this.settingsIndex === 0) {
      this.mutate((config) => {
        config.enabled = !config.enabled;
      });
      return;
    }
    if (this.settingsIndex === 1) {
      if (!adjust) return;
      this.mutate((config) => {
        config.maxActive = Math.max(1, Math.min(32, config.maxActive + delta));
      });
      return;
    }
    if (this.settingsIndex === 2) {
      if (adjust) return;
      if (this.draft.defaultModel) {
        this.mutate((config) => {
          delete config.defaultModel;
        });
      } else {
        this.openModels("default");
      }
      return;
    }
    if (this.settingsIndex === 3 && !adjust) this.openModels("manage");
  }

  private handleModelsInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.view = "settings";
      this.error = undefined;
      this.refreshRender();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveModel(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveModel(1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      const entry = this.selectedEntry();
      if (entry) this.openReasoning(entry);
      return;
    }
    if (matchesKey(data, Key.space)) {
      const entry = this.selectedEntry();
      if (entry) this.toggleModel(entry);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (this.modelsMode === "default") {
        this.chooseDefault();
        return;
      }
      const entry = this.selectedEntry();
      if (entry) this.openReasoning(entry);
      return;
    }
    const before = this.search.getValue();
    this.search.handleInput(data);
    if (this.search.getValue() !== before) {
      this.selectedModelKey = undefined;
      this.applyFilter();
    }
    this.refreshRender();
  }

  private handleReasoningInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
      this.view = "models";
      this.error = undefined;
      this.refreshEntries();
      this.refreshRender();
      return;
    }
    const entry = this.reasoningEntry();
    if (!entry) {
      this.view = "models";
      this.refreshRender();
      return;
    }
    const total = entry.supported.length;
    if (total === 0) return;
    if (matchesKey(data, Key.up)) {
      this.reasoningIndex = (this.reasoningIndex - 1 + total) % total;
      this.refreshRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.reasoningIndex = (this.reasoningIndex + 1) % total;
      this.refreshRender();
      return;
    }
    const level = entry.supported[this.reasoningIndex];
    if (matchesKey(data, Key.space)) {
      this.toggleLevel(entry.key, level);
      return;
    }
    if (matchesKey(data, "d") || data === "D") {
      this.setDefaultLevel(entry.key, level);
    }
  }

  private moveModel(delta: number): void {
    const total = this.filteredEntries.length;
    if (total === 0) return;
    const index = (this.selectedModelIndex() + delta + total) % total;
    this.selectedModelKey = this.filteredEntries[index].key;
    this.refreshRender();
  }

  private toggleModel(entry: ModelEntry): void {
    const allowed = this.draft.allowedModels.includes(entry.key);
    if (allowed) {
      this.mutate((config) => {
        config.allowedModels = config.allowedModels.filter(
          (key) => key !== entry.key,
        );
        delete config.modelReasoning[entry.key];
        if (config.defaultModel === entry.key) delete config.defaultModel;
      });
      if (this.pendingModel === entry.key) this.pendingModel = undefined;
      return;
    }
    if (this.pendingModel === entry.key) {
      this.pendingModel = undefined;
      this.error = undefined;
      this.refreshRender();
      return;
    }
    if (!entry.model) {
      this.error =
        "This model is unavailable; its reasoning levels are unknown.";
      this.refreshRender();
      return;
    }
    const policy = this.draft.modelReasoning[entry.key];
    if (policy && policy.allowed.length > 0) {
      this.mutate((config) => {
        config.allowedModels = [...config.allowedModels, entry.key];
      });
      return;
    }
    // New model: stay pending until at least one reasoning level is selected.
    this.pendingModel = entry.key;
    this.error = undefined;
    this.refreshRender();
  }

  private toggleLevel(key: string, level: ThinkingLevel): void {
    const policy = this.draft.modelReasoning[key];
    const has = policy?.allowed.includes(level) ?? false;
    const nextAllowed = has
      ? (policy?.allowed ?? []).filter((item) => item !== level)
      : [...(policy?.allowed ?? []), level];
    const wasAllowed = this.draft.allowedModels.includes(key);
    const becomesAllowed = !wasAllowed && nextAllowed.length > 0;
    const becomesDisallowed = wasAllowed && nextAllowed.length === 0;
    this.mutate((config) => {
      const current = config.modelReasoning[key] ?? { allowed: [] };
      current.allowed = nextAllowed;
      if (current.default && !nextAllowed.includes(current.default)) {
        delete current.default;
      }
      config.modelReasoning[key] = current;
      if (becomesAllowed) {
        config.allowedModels = [...config.allowedModels, key];
      }
      if (becomesDisallowed) {
        config.allowedModels = config.allowedModels.filter(
          (item) => item !== key,
        );
        delete config.modelReasoning[key];
        if (config.defaultModel === key) delete config.defaultModel;
      }
    });
    if (becomesAllowed) this.pendingModel = undefined;
  }

  private setDefaultLevel(key: string, level: ThinkingLevel): void {
    const policy = this.draft.modelReasoning[key];
    const alreadyDefault = policy?.default === level;
    const wasAllowed = this.draft.allowedModels.includes(key);
    this.mutate((config) => {
      const current = config.modelReasoning[key] ?? { allowed: [] };
      if (alreadyDefault) {
        delete current.default;
      } else {
        if (!current.allowed.includes(level)) {
          current.allowed = [...current.allowed, level];
        }
        current.default = level;
      }
      config.modelReasoning[key] = current;
      if (!wasAllowed && current.allowed.length > 0) {
        config.allowedModels = [...config.allowedModels, key];
      }
    });
    if (!wasAllowed) this.pendingModel = undefined;
  }

  private chooseDefault(): void {
    const entry = this.selectedEntry();
    if (!entry) return;
    if (!this.draft.allowedModels.includes(entry.key)) {
      this.error =
        "Enable this model with at least one reasoning level before setting it as default.";
      this.refreshRender();
      return;
    }
    this.mutate((config) => {
      config.defaultModel = entry.key;
    });
    this.view = "settings";
    this.error = undefined;
    this.refreshRender();
  }

  private openModels(mode: ModelsMode): void {
    this.modelsMode = mode;
    this.view = "models";
    this.error = undefined;
    this.search.setValue("");
    this.selectedModelKey = undefined;
    this.refreshEntries();
    this.refreshRender();
  }

  private openReasoning(entry: ModelEntry): void {
    if (!entry.model) {
      this.error =
        "This model is unavailable; its reasoning levels are unknown.";
      this.refreshRender();
      return;
    }
    this.reasoningKey = entry.key;
    this.reasoningIndex = 0;
    const policy = this.draft.modelReasoning[entry.key];
    if (policy?.default) {
      const index = entry.supported.indexOf(policy.default);
      if (index >= 0) this.reasoningIndex = index;
    }
    this.view = "reasoning";
    this.error = undefined;
    this.refreshRender();
  }

  private selectedModelIndex(): number {
    const index = this.filteredEntries.findIndex(
      (entry) => entry.key === this.selectedModelKey,
    );
    return index >= 0 ? index : 0;
  }

  private selectedEntry(): ModelEntry | undefined {
    return this.filteredEntries[this.selectedModelIndex()];
  }

  private reasoningEntry(): ModelEntry | undefined {
    if (!this.reasoningKey) return undefined;
    return this.allEntries.find((entry) => entry.key === this.reasoningKey);
  }

  private refreshEntries(): void {
    const available = new Map<string, Model<Api>>();
    for (const model of this.registry.getAvailable()) {
      available.set(modelKey(model), model);
    }
    const keys = new Set<string>([
      ...this.draft.allowedModels,
      ...available.keys(),
    ]);
    const entries: ModelEntry[] = [...keys].map((key) => {
      const model = this.resolveModel(key);
      return {
        key,
        model,
        available: available.has(key),
        supported: model ? [...this.supported(model)] : [],
      };
    });
    const previousOrder = new Map(
      this.allEntries.map((entry, index) => [entry.key, index]),
    );
    entries.sort((a, b) => {
      const aPrevious = previousOrder.get(a.key);
      const bPrevious = previousOrder.get(b.key);
      if (aPrevious !== undefined && bPrevious !== undefined) {
        return aPrevious - bPrevious;
      }
      if (aPrevious !== undefined) return -1;
      if (bPrevious !== undefined) return 1;
      const aAllowed = this.draft.allowedModels.includes(a.key) ? 0 : 1;
      const bAllowed = this.draft.allowedModels.includes(b.key) ? 0 : 1;
      if (aAllowed !== bAllowed) return aAllowed - bAllowed;
      return a.key.localeCompare(b.key);
    });
    this.allEntries = entries;
    this.applyFilter();
  }

  private applyFilter(): void {
    const query = this.search.getValue();
    this.filteredEntries = query.trim()
      ? fuzzyFilter(this.allEntries, query, (entry) =>
          entry.model?.name ? `${entry.key} ${entry.model.name}` : entry.key,
        )
      : this.allEntries;
    if (
      !this.filteredEntries.some((entry) => entry.key === this.selectedModelKey)
    ) {
      this.selectedModelKey = this.filteredEntries[0]?.key;
    }
  }

  private resolveModel(key: string): Model<Api> | undefined {
    const slash = key.indexOf("/");
    if (slash <= 0 || slash === key.length - 1) return undefined;
    return this.registry.find(key.slice(0, slash), key.slice(slash + 1));
  }

  private mutate(change: (config: T) => void): void {
    const next = cloneConfig(this.draft);
    change(next);
    this.draft = next;
    this.error = undefined;
    this.refreshEntries();
    this.enqueue(this.persistable(next));
    this.refreshRender();
  }

  /**
   * Canonicalize a candidate config before persisting:
   * - filter each model's levels to its real supported set unconditionally
   * - clear a default that is no longer among the surviving levels
   * - drop models/policies with zero valid levels and any dangling default model
   * - if capability pruning removed the last previously-selected model, disable
   *   delegation so an unrelated edit can still persist; enabling an initially
   *   empty config is left alone so validation reports the user error
   */
  private persistable(config: T): T {
    const next = cloneConfig(config);
    const previouslyAllowed = next.allowedModels.length > 0;
    for (const key of [...next.allowedModels]) {
      const policy = next.modelReasoning[key];
      const model = this.resolveModel(key);
      const levels =
        model && policy
          ? policy.allowed.filter((level) =>
              this.supported(model).includes(level),
            )
          : (policy?.allowed ?? []);
      if (levels.length === 0) {
        next.allowedModels = next.allowedModels.filter((item) => item !== key);
        delete next.modelReasoning[key];
        continue;
      }
      const canonical = policy ?? { allowed: [] };
      canonical.allowed = levels;
      if (canonical.default && !levels.includes(canonical.default)) {
        delete canonical.default;
      }
      next.modelReasoning[key] = canonical;
    }
    for (const key of Object.keys(next.modelReasoning)) {
      if (!next.allowedModels.includes(key)) delete next.modelReasoning[key];
    }
    if (next.defaultModel && !next.allowedModels.includes(next.defaultModel)) {
      delete next.defaultModel;
    }
    if (previouslyAllowed && next.allowedModels.length === 0) {
      next.enabled = false;
    }
    return next;
  }

  private enqueue(config: T): void {
    this.saving = true;
    const payload = cloneConfig(config);
    this.queue = this.queue.then(async () => {
      try {
        await this.onChange(cloneConfig(payload));
        this.persisted = cloneConfig(payload);
        this.draft = cloneConfig(payload);
        this.error = undefined;
      } catch (error) {
        this.draft = cloneConfig(this.persisted);
        this.error = safeText(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        this.saving = false;
        this.refreshEntries();
        this.refreshRender();
      }
    });
  }

  private async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
    this.done();
  }

  /** A permanent footer slot prevents centered overlays moving during writes. */
  private statusLine(): string {
    if (this.error) return this.theme.fg("error", safeText(this.error));
    if (this.saving) return this.theme.fg("dim", "Saving…");
    return "";
  }

  private refreshRender(): void {
    this.invalidate();
    this.tui.requestRender();
  }
}
