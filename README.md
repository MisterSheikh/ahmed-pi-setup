# ahmed-pi-setup

Personal extensions, skills, and prompt templates for Pi.

## Components

Extensions:

- `ask-user`
- `background-terminals`
- `context-share`, with `/excerpt [count] [--skip number]` for copying or saving selected user and agent messages
- `file-search`
- `subagents`
- `summaries`
- `web-search`, providing the `web` tool for search, page reading, links, and text lookup through your existing Pi OpenAI login

Skills:

- `background-terminals`
- `subagents`

Prompt templates:

- `/handoff [output-path]`, which writes `HANDOFF.md` by default

## Subagents

Subagents can run through Pi or the Codex CLI, with at most four running at once. Pi children inherit the parent's model and reasoning level unless explicitly overridden. Codex defaults to `gpt-5.6-sol` at `high`.

For bounded economical work, the skill and tool instructions recommend `opencode-go/deepseek-v4.1-flash` at `high` (`max` is also supported). This recommendation does not change Pi's inheritance behavior.

Claude Code is disabled: it is excluded from the spawn tool's choices and the runtime backend registry, so Claude spawn requests are rejected. Its backend, dependency, routing defaults, and tests are retained for possible re-enablement. This does not restrict models available through Pi itself.

Guidance lives in `skills/subagents/SKILL.md` and `extensions/subagents/src/prompt.ts`. Enabled backends are declared in `extensions/subagents/src/domain.ts` and registered in `extensions/subagents/src/runtime.ts`.

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

The script refuses to replace existing files, directories, or unrelated links. Move any existing copies of these components out of `~/.pi/agent/extensions`, `~/.pi/agent/skills`, and `~/.pi/agent/prompts`, and back up any existing `~/.pi/agent/AGENTS.md`, before running it. Links already pointing to the expected repo files are left unchanged.

Remove links created by this repository with:

```sh
./scripts/unlink.sh
```

Unlinking removes only the expected links, including the global `AGENTS.md` link; it leaves the repository files intact and refuses unrelated paths.

Set `PI_CODING_AGENT_DIR` before running either script when Pi uses a configuration directory other than `~/.pi/agent`.
