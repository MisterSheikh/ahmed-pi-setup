#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/pi-web-test.XXXXXX")
tmp_root=$(CDPATH= cd -- "$tmp_root" && pwd)
agent_dir="$tmp_root/agent"
cleanup() { rm -rf "$tmp_root"; }
trap cleanup EXIT HUP INT TERM

PI_CODING_AGENT_DIR="$agent_dir" "$repo_root/scripts/link.sh" >"$tmp_root/link.log"
web_link="$agent_dir/extensions/web-search"
[ -L "$web_link" ]
[ "$(readlink "$web_link")" = "$repo_root/extensions/web-search" ]

cd "$repo_root"
AGENT_DIR="$agent_dir" WEB_LINK="$web_link" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

// Discover through the isolated installation, with no user credentials or model calls.
const loader = new DefaultResourceLoader({
  cwd: process.env.AGENT_DIR,
  agentDir: process.env.AGENT_DIR,
  settingsManager: SettingsManager.inMemory(),
  noSkills: true,
  noThemes: true,
  noContextFiles: true,
  noPromptTemplates: true,
});
await loader.reload();
const { extensions, errors } = loader.getExtensions();
assert.deepEqual(errors, []);
const matches = extensions.filter(extension => extension.tools.has('web'));
assert.equal(matches.length, 1, 'exactly one web tool discovered');
assert.equal(matches[0].tools.get('web').definition.name, 'web');
console.log('web extension discovery passed');
NODE

PI_CODING_AGENT_DIR="$agent_dir" "$repo_root/scripts/unlink.sh" >"$tmp_root/unlink.log"
[ ! -e "$web_link" ] && [ ! -L "$web_link" ]
printf 'web extension link/unlink passed\n'
