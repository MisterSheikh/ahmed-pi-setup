---
name: background-terminals
description: Run and manage servers, watchers, long builds, and other commands that should continue while the agent works.
---

# Background terminals

Use `bg_start` for long-running commands. Use regular `bash` for quick commands.

Background commands receive no stdin. Do not use them for interactive prompts. Give each terminal a clear title and avoid starting duplicate servers or watchers.

After starting a command, continue useful work instead of polling. Use `bg_status` when current output matters, `bg_list` to list terminals, and `bg_kill` when a process is stuck or no longer needed.

The user can open `/ps` to inspect output and stop terminals. Pi stops all background terminals during shutdown or reload.
