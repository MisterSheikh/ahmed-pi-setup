#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
agent_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}

resources='AGENTS.md
extensions/ask-user
extensions/background-terminals
extensions/context-share
extensions/file-search
extensions/subagents
extensions/summaries
extensions/web-search
skills/background-terminals
skills/subagents
prompts/handoff.md'

dependency_source="$repo_root/node_modules"
dependency_link="$agent_dir/extensions/node_modules"
errors=0

if [ ! -d "$dependency_source" ]; then
  printf 'Missing dependencies: run npm ci in %s\n' "$repo_root" >&2
  errors=1
fi

if [ -L "$dependency_link" ]; then
  current=$(readlink "$dependency_link")
  if [ "$current" != "$dependency_source" ]; then
    printf 'Refusing incorrect dependency link: %s -> %s\n' "$dependency_link" "$current" >&2
    errors=1
  fi
elif [ -e "$dependency_link" ]; then
  printf 'Refusing existing dependency path: %s\n' "$dependency_link" >&2
  errors=1
fi

while IFS= read -r relative; do
  [ -n "$relative" ] || continue
  source_relative="$relative"
  [ "$relative" != 'AGENTS.md' ] || source_relative='config/AGENTS.md'
  source_path="$repo_root/$source_relative"
  destination="$agent_dir/$relative"

  if [ ! -e "$source_path" ]; then
    printf 'Missing source: %s\n' "$source_path" >&2
    errors=1
    continue
  fi

  if [ -L "$destination" ]; then
    current=$(readlink "$destination")
    if [ "$current" != "$source_path" ]; then
      printf 'Refusing incorrect link: %s -> %s\n' "$destination" "$current" >&2
      errors=1
    fi
  elif [ -e "$destination" ]; then
    printf 'Refusing existing path: %s\n' "$destination" >&2
    errors=1
  fi
done <<EOF
$resources
EOF

[ "$errors" -eq 0 ] || exit "$errors"

mkdir -p "$agent_dir/extensions"
if [ -L "$dependency_link" ]; then
  printf 'Dependency link exists: %s\n' "$dependency_link"
else
  ln -s "$dependency_source" "$dependency_link"
  printf 'Linked dependencies: %s -> %s\n' "$dependency_link" "$dependency_source"
fi

while IFS= read -r relative; do
  [ -n "$relative" ] || continue
  source_relative="$relative"
  [ "$relative" != 'AGENTS.md' ] || source_relative='config/AGENTS.md'
  source_path="$repo_root/$source_relative"
  destination="$agent_dir/$relative"
  mkdir -p "$(dirname -- "$destination")"

  if [ -L "$destination" ]; then
    printf 'Already linked: %s\n' "$destination"
  else
    ln -s "$source_path" "$destination"
    printf 'Linked: %s -> %s\n' "$destination" "$source_path"
  fi
done <<EOF
$resources
EOF
