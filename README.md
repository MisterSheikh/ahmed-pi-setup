# ahmed-pi-setup

Personal extensions and skills for Pi.

## Components

Extensions:

- `ask-user`
- `background-terminals`
- `file-search`
- `progress-tracker`
- `subagents`
- `summaries`

Skills:

- `background-terminals`
- `subagents`

## Development

```sh
npm ci
npm run format:check
npm run check
npm test
```

## Link into Pi

The link script refuses to replace existing files, directories, or unrelated links. Move any existing copies of these components out of `~/.pi/agent/extensions` and `~/.pi/agent/skills` before running it.

```sh
./scripts/link.sh
```

Remove links created by this repository with:

```sh
./scripts/unlink.sh
```

Set `PI_CODING_AGENT_DIR` before running either script when Pi uses a configuration directory other than `~/.pi/agent`.
