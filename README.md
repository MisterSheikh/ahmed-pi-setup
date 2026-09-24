# ahmed-pi-setup

Personal extensions, skills, and prompt templates for Pi.

## Components

Extensions:

- `ask-user`
- `background-terminals`
- `context-share`, with `/excerpt [count] [--skip number]` for copying or saving selected user and agent messages
- `file-search`
- `subagents-v2`
- `subscription-usage`, integrating subscription quota and extension statuses into Pi's compact footer
- `summaries`
- `web-search`, providing the `web` tool for search, page reading, links, and text lookup through your existing Pi OpenAI login

Skills:

- `background-terminals`
- `subagents`

Prompt templates:

- `/handoff [output-path]`, which writes `HANDOFF.md` by default

Themes:

- `lovelace`, matching Ghostty's built-in Lovelace palette with higher-contrast faded text

## Subagents

Subagents V2 uses reusable Pi workers with separate conversations in the shared workspace. Delegation starts disabled. Run `/subagent-config` for a searchable popup (`/subagents config` remains an alias): Space toggles models; Right opens that model's supported reasoning levels and optional default. Changes apply immediately. Choose an optional default model and the active-worker limit (initially four), then explicitly enable delegation. There is no parent-model inheritance or silent fallback.

The parent can spawn, follow up, steer, interrupt, inspect, and wait for workers. Workers report progress, questions, and blockers to the parent. `/subagents` opens a live dashboard: Enter inspects a worker, Home/End navigate its transcript, and **t** starts exclusive inline takeover. Chat communications label sender, receiver, action, and task, with semantic colours and expandable bodies. Parent resume restores workers without restarting their tasks; worker conversations stay outside normal resume discovery.

For economical work, the skill suggests `opencode-go/deepseek-v4.1-flash` at `high` (`max` is also supported), only when permitted by user configuration. Every worker runs through Pi, including models supplied by the `openai-codex` provider; the Codex CLI is not used.

See [`skills/subagents/SKILL.md`](skills/subagents/SKILL.md) and [`extensions/subagents-v2/README.md`](extensions/subagents-v2/README.md). The old `extensions/subagents/` implementation and sessions are retained for rollback, not loaded or migrated. V2 uses workspace-local Pi 0.87.1 dependencies; existing root dependencies are unchanged.

## Context sharing

Run `/excerpt` to select a contiguous range of user and agent messages from the current session branch. Each message is counted separately. The selector excludes thinking, tool calls, tool results, shell executions, summaries, and extension messages.

`/excerpt 6 --skip 2` starts with six messages selected and the newest two excluded. Use the arrows or `j`/`k` to move the range endpoint, `v` or Space to reset the anchor, Enter or `c` to copy, and `s` to save a Markdown file.

## Web search

The `web` tool uses Codex's standalone search service independently of your conversation model. Sign in to `openai-codex` through Pi's `/login`, then ask Pi to search or read a public webpage. No separate search API key is required.

Search results and pages have references for follow-up `open`, `click`, and `find` calls. The extension sends queries and requested URLs, not your conversation history. Web content is untrusted; final answers should cite normal source links.

This is an internal OpenAI endpoint, so availability can change. Exact search billing and quota impact are not documented; do not assume free or unlimited use. See [`extensions/web-search/README.md`](extensions/web-search/README.md) for limits and configuration.

## Development

```sh
npm ci
npm run format:check
npm run check
npm test
```

## Link into Pi

Install the locked dependencies first. The link script exposes the hoisted packages to each extension, then links the adopted components into Pi.

```sh
npm ci
./scripts/link.sh
```

The script also links `~/.pi/agent/AGENTS.md` to this repository's `config/AGENTS.md`, which supplies global instructions for Pi across projects. The repository-root `AGENTS.md` is separate: it guides development in this repo and is not linked globally.

The script switches an exact repo-owned legacy `extensions/subagents` link to `extensions/subagents-v2`, so only one subagents extension is discovered. Stop active workers first and run `/reload` afterward.

The script refuses to replace existing files, directories, or unrelated links. Move any existing copies of these components out of `~/.pi/agent/extensions`, `~/.pi/agent/skills`, `~/.pi/agent/prompts`, and `~/.pi/agent/themes`, and back up any existing `~/.pi/agent/AGENTS.md`, before running it. Links already pointing to the expected repo files are left unchanged.

Remove links created by this repository with:

```sh
./scripts/unlink.sh
```

Unlinking removes only the expected links, including the global `AGENTS.md` link; it leaves the repository files intact and refuses unrelated paths.

Set `PI_CODING_AGENT_DIR` before running either script when Pi uses a configuration directory other than `~/.pi/agent`.
