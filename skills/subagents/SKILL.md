---
name: subagents
description: Choose and manage Pi, Claude Code, and Codex subagents. Use when delegating work or when the user asks for subagents.
---

# Subagents

Children have isolated context, so give each a self-contained prompt with all needed paths, constraints, and expected output. They have normal host permissions; use only trusted working directories.

## Defaults and selection

- Pi: `opencode-go/deepseek-v4-flash` at `high`. Prefer `provider/model-id`; a bare model ID must be unambiguous.
- Claude Code: `claude-opus-5` at `high`. Claude Code must be installed and authenticated. Never select Fable unless the user explicitly requests it.
- Codex: `gpt-5.6-sol` at `high`. The Codex CLI must be installed and authenticated. Sol is the default, not the only valid model.

DeepSeek V4 Flash must use only `high` or `max`. For Codex, Luna may suit clearly bounded work where lower cost or speed matters. Terra remains available, but has no default recommendation because its current value proposition is unclear. The parent may choose another model or reasoning level for a concrete reason.

## Shape the task

- Delegate according to the actual task rather than fixed roles, and do not delegate when the parent can finish faster.
- Keep the scope narrow. State explicitly whether the child may edit files.
- Bound reviews to the relevant files or diff and specify the desired findings. Prefer a quick bounded review unless the user requests a deep audit.

## Running children

At most four subagents run at once. Results return automatically, so continue useful work after spawning. Use `subagent_wait` only when the result blocks progress. Use `subagent_check`, `subagent_list`, and `subagent_cancel` as needed. Use `/subagents` to inspect or take over a run.
