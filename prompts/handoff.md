---
description: Write a bounded, evidence-based handoff for a fresh Pi session
argument-hint: "[output-path]"
---
Create a handoff at the path inside these tags:

<output-path>${1:-HANDOFF.md}</output-path>

The handoff is for a fresh Pi session that has no access to this conversation.

## Safety gate

Before writing anything:

1. Resolve the requested path from the current working directory. Do not create it yet.
2. Check whether that exact path already exists, including as a symlink or broken symlink.
3. If the path is inside a Git worktree, check whether Git tracks it. A tracked path still counts when its working-tree file is missing.
4. If the path exists or is tracked, do not modify it. State what you found, ask for explicit overwrite approval, and wait. Invoking `/handoff` does not count as approval.
5. Do not run `git add`, `git commit`, or any command that changes the index or repository history. The handoff must remain unstaged unless it was already staged before this task.

## Inspect the current state

Build the handoff from current files and command results. Treat conversation history only as a lead to evidence, not as evidence itself.

- Establish the working directory, project root, and Git root when present.
- Inspect the current branch, HEAD, upstream, worktree status, staged changes, unstaged changes, untracked files, and recent relevant commits.
- Use bounded Git summaries first. Read full diffs only for relevant files and only when their size is reasonable.
- Read current project instructions, plans, roadmaps, manifests, and the files needed to understand the active work.
- Inspect generated files or running state only when they matter to the next session.
- Run focused, non-destructive verification when it is safe and reasonably quick. Never report a check as passing unless you ran it and saw it pass.
- If the directory is not a Git repository, say so and inspect the available project state without inventing Git details.

Do not read obvious credential stores or secret files such as `.env`, key files, auth files, or password stores. If relevant output contains a secret, omit the value and mention only that sensitive data was redacted. Do not include internal reasoning, abandoned discussion, raw transcripts, or large command output.

## Evidence rules

Outside the assumptions section, include only claims supported by the state you inspected. Cite concise evidence with file paths, commit IDs, or commands where useful. If a claim came only from conversation history or cannot be confirmed, move it to `Assumptions and unverified context`. Keep facts and assumptions separate.

## Required file format

Write Markdown with these headings in this order:

1. `# Handoff`
2. `## Objective`
3. `## State`
4. `## Decisions`
5. `## Constraints`
6. `## Completed work`
7. `## Verification`
8. `## Remaining work`
9. `## Risks`
10. `## Assumptions and unverified context`
11. `## Exact next action`

Use the sections as follows:

- `Objective` states the concrete current goal and completion condition.
- `State` includes the project path, branch and HEAD when present, dirty state, and the files or components that matter now.
- `Decisions` records choices that current files, diffs, commits, or project instructions support, with their reason when evidence shows it.
- `Constraints` records active technical and process limits.
- `Completed work` names the result and affected paths, not a chronological transcript.
- `Verification` lists exact commands with pass, fail, or not-run status and a short result. Do not paste logs.
- `Remaining work` is an ordered checklist.
- `Risks` ties each observed condition to its possible effect. Keep speculation out of the observed condition.
- `Assumptions and unverified context` contains every useful claim that current state did not confirm. Write `None` when empty.
- `Exact next action` contains one specific action. Include the exact command or edit target and the expected successful result.

Keep the entire file at or below 120 lines and 12 KiB. Use at most eight bullets per section. Prefer paths, commands, commit IDs, and short results over prose. Omit sections' details rather than exceeding either limit, but keep every required heading.

## Finish

After writing, re-read the file and confirm the limits, required headings, fact and assumption split, and absence of secrets or large output. Check Git status again. Do not stage or commit the handoff.

Then print:

- the absolute path written;
- whether Git sees it as untracked, modified, ignored, or outside the repository;
- one exact POSIX shell command that starts a fresh interactive Pi session in the project directory with the handoff as its initial file input.

Use the form `cd -- '<project-root>' && pi -- '@/absolute/path/to/handoff.md'`, with both arguments shell-quoted correctly for their actual values. Print the command in the response, not only inside the handoff file.
