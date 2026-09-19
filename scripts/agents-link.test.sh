#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp_root=$(mktemp -d "${TMPDIR:-/tmp}/pi-agents-test.XXXXXX")
tmp_root=$(CDPATH= cd -- "$tmp_root" && pwd)
agent_dir="$tmp_root/agent"
cleanup() { rm -rf "$tmp_root"; }
trap cleanup EXIT HUP INT TERM

link() { PI_CODING_AGENT_DIR="$agent_dir" "$repo_root/scripts/link.sh" >"$tmp_root/link.log" 2>&1; }
unlink() { PI_CODING_AGENT_DIR="$agent_dir" "$repo_root/scripts/unlink.sh" >"$tmp_root/unlink.log" 2>&1; }

# Create the global link, accept it on repeated runs, and remove it safely.
link
[ "$(readlink "$agent_dir/AGENTS.md")" = "$repo_root/config/AGENTS.md" ]
link
unlink
[ ! -e "$agent_dir/AGENTS.md" ] && [ ! -L "$agent_dir/AGENTS.md" ]
[ -f "$repo_root/config/AGENTS.md" ]
unlink

# Both scripts must refuse existing files, directories, and unrelated links.
for kind in file directory symlink; do
  case "$kind" in
    file) printf 'keep me\n' >"$agent_dir/AGENTS.md" ;;
    directory) mkdir "$agent_dir/AGENTS.md" ;;
    symlink) ln -s "$repo_root/AGENTS.md" "$agent_dir/AGENTS.md" ;;
  esac
  if link; then
    printf 'link unexpectedly accepted %s\n' "$kind" >&2
    exit 1
  fi
  [ ! -e "$agent_dir/extensions/ask-user" ]
  if unlink; then
    printf 'unlink unexpectedly accepted %s\n' "$kind" >&2
    exit 1
  fi
  case "$kind" in
    file) [ "$(head -n 1 "$agent_dir/AGENTS.md")" = 'keep me' ]; rm "$agent_dir/AGENTS.md" ;;
    directory) rmdir "$agent_dir/AGENTS.md" ;;
    symlink) [ "$(readlink "$agent_dir/AGENTS.md")" = "$repo_root/AGENTS.md" ]; rm "$agent_dir/AGENTS.md" ;;
  esac
done

printf 'global AGENTS.md link/unlink safety passed\n'
