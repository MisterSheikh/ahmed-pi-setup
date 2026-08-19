---
name: subagents
description: Choose and manage Pi, Claude Code, and Codex subagents. Use when delegating work or when the user asks for subagents.
---

# Subagents

Every child has a separate context. Give it all needed paths, constraints, and expected output.

## Defaults

- Pi: `opencode-go/deepseek-v4-flash` at `high`.
- Claude Code: `claude-opus-5` at `high`.
- Codex: `gpt-5.6-sol` at `high`.

The parent may change reasoning when the task calls for it. DeepSeek V4 Flash must always use `high` or `max`. Never select Fable unless the user explicitly requests it.

## Useful roles

- Scout: DeepSeek at `high`. Read and report.
- Worker: DeepSeek at `max`. Carry out a defined task.
- Verifier: DeepSeek at `high`. Check behavior, tests, or correctness.
- Expert: Claude Opus or Codex Sol at `high`, chosen by the parent.

These are guidelines, not tool modes.

## Running children

At most four subagents run at once. Results return automatically, so continue useful work after spawning. Use `subagent_wait` only when the result blocks progress. Use `subagent_check`, `subagent_list`, and `subagent_cancel` as needed. Use `/subagents` to inspect or take over a run.
