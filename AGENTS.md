# Development guidance

- This repo contains personal Pi extensions, skills, and prompt templates—not Pi core.
- Components are symlinked into ~/.pi/agent/. Treat changes here as changes to the live setup.
- config/AGENTS.md supplies global agent instructions; this file is only for development in this repo.
- Consult the installed Pi documentation and relevant examples before changing integration behavior.
- Keep changes focused. Add or update tests when behavior changes.
- Prefer type inference where clear. Avoid `as any`; use proper types or narrowing, and explain unavoidable casts.
- Validate with npm run format:check, npm run check, and npm test.
- When adding or removing linked components, update scripts/link.sh and scripts/unlink.sh.
- Do not change credentials, settings, sessions, or other local Pi state unless requested.
