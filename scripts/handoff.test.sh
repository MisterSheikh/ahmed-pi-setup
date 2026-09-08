#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/pi-handoff-test.XXXXXX")
tmp_root=$(CDPATH= cd -- "$tmp_root" && pwd)
agent_dir="$tmp_root/home/.pi/agent"
project_dir="$tmp_root/project"
link_log="$tmp_root/link.log"
unlink_log="$tmp_root/unlink.log"

cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$project_dir"

HOME="$tmp_root/home" PI_CODING_AGENT_DIR="$agent_dir" \
  "$repo_root/scripts/link.sh" >"$link_log"

prompt_link="$agent_dir/prompts/handoff.md"
if [ ! -L "$prompt_link" ]; then
  printf 'Expected prompt link was not created: %s\n' "$prompt_link" >&2
  exit 1
fi

linked_source=$(readlink "$prompt_link")
expected_source="$repo_root/prompts/handoff.md"
if [ "$linked_source" != "$expected_source" ]; then
  printf 'Prompt link points to %s, expected %s\n' "$linked_source" "$expected_source" >&2
  exit 1
fi

cd "$repo_root"
AGENT_DIR="$agent_dir" PROJECT_DIR="$project_dir" PROMPT_LINK="$prompt_link" node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const loader = new DefaultResourceLoader({
  cwd: process.env.PROJECT_DIR,
  agentDir: process.env.AGENT_DIR,
  noExtensions: true,
  noSkills: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();

const { prompts, diagnostics } = loader.getPrompts();
assert.deepEqual(diagnostics, []);
assert.equal(prompts.length, 1);

const handoff = prompts[0];
assert.equal(handoff.name, "handoff");
assert.equal(handoff.argumentHint, "[output-path]");
assert.equal(handoff.filePath, process.env.PROMPT_LINK);
assert.match(handoff.description, /evidence-based handoff/);

const promptModuleUrl = pathToFileURL(
  path.join(
    process.cwd(),
    "node_modules/@earendil-works/pi-coding-agent/dist/core/prompt-templates.js",
  ),
);
const { expandPromptTemplate } = await import(promptModuleUrl.href);

const defaultExpansion = expandPromptTemplate("/handoff", prompts);
assert.match(defaultExpansion, /<output-path>HANDOFF\.md<\/output-path>/);

const customExpansion = expandPromptTemplate(
  '/handoff "notes/next session.md"',
  prompts,
);
assert.match(
  customExpansion,
  /<output-path>notes\/next session\.md<\/output-path>/,
);
NODE

HOME="$tmp_root/home" PI_CODING_AGENT_DIR="$agent_dir" \
  "$repo_root/scripts/unlink.sh" >"$unlink_log"

if [ -e "$prompt_link" ] || [ -L "$prompt_link" ]; then
  printf 'Prompt link remains after unlink: %s\n' "$prompt_link" >&2
  exit 1
fi

printf 'handoff prompt discovery and link/unlink test passed\n'
