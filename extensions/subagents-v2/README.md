# Subagents V2

Pi-only, reusable workers controlled by the parent session. This is the extension selected by `scripts/link.sh`. It must not be loaded alongside the legacy subagents extension: their tool and command names overlap.

## Configuration and controls

- `/subagent-config`: open the configuration popup (`/subagents config` remains an alias). Type to search models, use **Space** to toggle models, and **Right** to edit the highlighted model's reasoning levels. Only levels supported by that model appear; **Space** toggles levels and **d** sets/clears its optional default. Changes apply immediately; **Escape** returns or closes, rather than cancelling applied changes.
- New models become allowed only after selecting at least one reasoning level. There are no preselected levels. The popup also controls delegation enablement, the optional default model, and the active-worker limit (initially four).
- `/subagents`: open the live dashboard with worker/task status, elapsed time, activity, and available context usage. **Enter** opens a read-only live transcript; **t** takes over; **i** interrupts the selected worker.
- In a worker view, **Home** jumps to the start; **End** jumps to the bottom and follows new output. Scrolling back stops following. Thinking, tool calls/arguments/results, and queued instructions have distinct labels.
- **t** enters inline takeover. **Enter** sends, **Ctrl+X** interrupts, and **Ctrl+T** hands back and closes. **Escape** closes either view and releases any takeover. The ownership banner marks when parent control is excluded.
- Chat communications show explicit sender/receiver labels, worker/task identities, and expandable bodies. Outgoing actions use accent colour; results green; questions/blockers amber; failures red; FYI muted. Historical task results are labelled separately from the worker's current status.
- Disabling delegation stops workers and preserves their conversations. Enabling does not restart tasks.

The parent agent sees the allowed model/reasoning combinations and chooses both for each task. Omitting reasoning uses only the selected model's optional default; it never inherits a different model's default or the parent's settings. There is no built-in model selection or fallback.

Configuration lives at `<agent-dir>/subagents-v2/config.json`. Version 2 stores reasoning policies per model. Previous version-1 selections are migrated in memory by intersecting their selected levels with each model's supported levels; unsupported selections are not carried forward. The next explicit configuration change saves the new format. Headless/RPC model tools use the same persisted configuration; the popup requires interactive TUI mode.

## Tools

| Tool | Purpose |
| --- | --- |
| `subagent_spawn` | Start a named worker with `task`, optional `model`, `reasoning`, and `working_dir`. Returns immediately. |
| `subagent_followup` | Send `task` to an idle worker identified by `id`, retaining its conversation. |
| `subagent_steer` | Queue `message` for an active worker identified by `id`. |
| `subagent_interrupt` | Stop selected `ids`, preserving conversations and reporting stop failures. |
| `subagent_wait` | Wait for selected current tasks; `mode` is `all` (default) or `any`. Cancelling the wait leaves workers running. |
| `subagent_list` | List workers, or inspect `id` with optional `task_id` (an earlier result) and `transcript`. |

Workers receive workspace instructions and the parent's ordinary text brief, not parent conversation history. They cannot delegate, contact peers, or ask the human directly. Their `subagent_report` tool sends `fyi` without waking the parent, or sends a `question`/`blocked` report and pauses until a follow-up.

Automatic notifications use short excerpts with an action label and a task-specific inspection hint. Questions, blockers, failures, and interruptions come before routine completions. Expand a notification or inspect its task for detail. Successful inspection and waiting acknowledge the result revision returned; roster lookups do not. New results or changed errors can still notify.

While the parent is busy, FYIs coalesce to the latest per task and are dropped if that task stops before delivery. They flush at the next model-turn boundary, so useful progress can still reach an ongoing parent run. Earlier reports remain in the worker's saved Pi transcript. FYIs never wake the parent. Idle-worker steering returns current status and suggests an explicit follow-up; it never starts one automatically.

Starting, working, and stopping workers consume capacity. Idle workers do not. A worker retains its slot while required background processes finish; the independent background-terminal extension is unchanged.

## Persistence and boundaries

Worker metadata is saved in the owning parent session. Worker conversations use Pi's session APIs under `<agent-dir>/subagents-v2/sessions/<parent-id>/`, outside normal resume discovery. Resuming the parent restores access without restarting work. Missing or unreadable workers are shown as unavailable. Tree rewind and fork control of existing workers are rejected; cloning and migration of old-extension sessions are unsupported.

Shutdown, reload, parent-session changes, and disabling delegation stop active work. Long results have bounded model-facing excerpts and references to the saved Pi transcript.

## Development and validation

V2 has workspace-local Pi **0.87.1** dependencies. Existing extensions retain their original root dependencies. From the repository root:

```sh
npm run format:check
npm run check
npm test
```

Automated tests use fake workers/providers and temporary sessions. Live validation is separate and opt-in:

```sh
# Isolation and configured-model availability only; no inference.
SUBAGENTS_V2_LIVE_DRY_RUN=1 node --test --experimental-transform-types extensions/subagents-v2/live-validation.ts

# Real Pi model calls. Copies configuration/auth into temporary storage.
SUBAGENTS_V2_LIVE=1 node --test --experimental-transform-types extensions/subagents-v2/live-validation.ts
```

The live harness defaults to the configured `opencode-go/deepseek-v4.1-flash` at `high`. Override with `SUBAGENTS_V2_LIVE_MODEL` and `SUBAGENTS_V2_LIVE_REASONING`. These are **test-only defaults**, not delegation defaults. Temporary credentials and sessions are removed after testing unless `SUBAGENTS_V2_LIVE_KEEP_TEMP=1` is explicitly set.

## Adoption and rollback

After stopping active workers, run `scripts/link.sh`, then `/reload` in Pi. The script removes only the exact repo-owned legacy subagents link and links V2. Configure and enable delegation through `/subagent-config`; linking does not enable it.

The legacy extension and sessions remain untouched. To roll back, stop V2 workers, remove only the V2 symlink, restore `~/.pi/agent/extensions/subagents` to `extensions/subagents/`, restore the active skill from `extensions/subagents/SKILL.legacy.md`, and reload. Select the legacy extension in the link scripts if keeping that rollback. Root dependencies already retain the legacy versions. No session migration is needed in either direction.
