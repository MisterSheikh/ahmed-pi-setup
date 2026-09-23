---
name: subagents
description: Delegate scoped work to reusable Pi workers and manage their results, questions, and lifecycle.
---

# Subagents V2

Workers are Pi sessions with separate conversations, not separate workspaces. They share the filesystem and normal host permissions. Use trusted working directories and partition edits to avoid collisions. Workers cannot delegate, contact peers, or ask the human directly.

## Configuration and selection

Delegation starts disabled. The user configures allowed models, each model's allowed reasoning levels and optional default, an optional default model, and the active-worker limit through the `/subagent-config` popup (`/subagents config` is an alias), then explicitly enables it. The popup supports type-to-search, Space to toggle, and Right to edit a model's reasoning levels; valid changes apply immediately. Do not edit configuration to enable delegation yourself.

- `subagent_spawn` takes `name`, `task`, and optional `model`, `reasoning`, and `working_dir`.
- Use an allowed, available `provider/model-id`. There is no harness selector: every worker runs through Pi.
- You, the parent agent, choose the model and reasoning level from the current allowed combinations supplied in your instructions. Workers do not choose their own settings.
- An omitted model uses only the configured default model. Omitted reasoning uses only the selected model's own configured default. If that default is absent, supply an explicit allowed level. Settings never inherit from the parent or another model and never silently fall back.
- For bounded economical work, consider `opencode-go/deepseek-v4.1-flash` at `high` (`max` is also supported), but only when allowed by the user's configuration. This recommendation is not a built-in default.

## Shape the task

Delegate when it helps, not merely to fill available slots. The initial limit is four active workers; the user may change it.

Give each worker an ordinary text brief containing the task, boundaries, relevant facts or file references, and expected output. Parent conversation history is not copied. State whether edits are allowed, keep scope narrow, and prefer a focused review over an unsolicited audit.

## Control and reuse

- Continue useful work after `subagent_spawn`; results arrive automatically.
- Use `subagent_followup` with `id` and `task` for a related assignment or an answer to an idle worker. Its conversation is retained. Use a fresh worker for unrelated work.
- Use `subagent_steer` with `id` and `message` to correct active work. Follow-ups reject busy workers; steering rejects idle workers.
- Use `subagent_interrupt` with `ids` to stop work while preserving conversations. Inspect reported stop failures.
- Use `subagent_list` for status. Supply `id` to inspect a worker, optional `task_id` for an earlier result, or `transcript: true` for a bounded transcript. Full-session references accompany long output.
- Use `subagent_wait` with `ids` and optional `mode: "any" | "all"` (default `all`) only when results block progress. It suspends without repeated model calls and selects the tasks current when the wait starts. Questions, blockers, failures, and unexpected interruptions return early. Cancelling a wait leaves workers running.

Workers use `subagent_report` to send FYI updates without waking the parent, or questions/blockers that pause until a follow-up. These are not completion results. Workers must finish required background processes and inspect their output before completing; they retain an active slot while waiting.

## Human controls and resume

`/subagents` opens the live dashboard. Enter inspects without taking control; **t** starts exclusive inline takeover. Home/End jump to the transcript start/bottom; End resumes following. In takeover, Enter sends, Ctrl+X interrupts, and Ctrl+T or Escape hands back and closes. Configuration is separate: `/subagent-config`. Do not assign or steer a worker during takeover.

Disabling delegation, reloading, changing parent sessions, or exiting Pi stops workers and preserves conversations. Parent resume restores workers without restarting tasks; use explicit follow-ups. Worker conversations stay outside normal resume lists. Cross-branch worker rewind/cloning is unsupported. Existing legacy subagent sessions are not migrated.
