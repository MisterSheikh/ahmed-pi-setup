# ahmed-pi-setup

Personal extensions and skills for Pi.

## Components

Extensions:

- `ask-user`
- `background-terminals`
- `context-share`, with `/excerpt [count] [--skip number]` for copying or saving selected user and agent messages
- `file-search`
- `progress-tracker`
- `subagents`
- `summaries`

Skills:

- `background-terminals`
- `subagents`

## Context sharing

Run `/excerpt` to select a contiguous range of user and agent messages from the current session branch. Each message is counted separately. The selector excludes thinking, tool calls, tool results, shell executions, summaries, and extension messages.

`/excerpt 6 --skip 2` starts with six messages selected and the newest two excluded. Use the arrows or `j`/`k` to move the range endpoint, `v` or Space to reset the anchor, Enter or `c` to copy, and `s` to save a Markdown file.

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

The script refuses to replace existing files, directories, or unrelated links. Move any existing copies of these components out of `~/.pi/agent/extensions` and `~/.pi/agent/skills` before running it.

Remove links created by this repository with:

```sh
./scripts/unlink.sh
```

Set `PI_CODING_AGENT_DIR` before running either script when Pi uses a configuration directory other than `~/.pi/agent`.
