#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
agent_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}

resources='extensions/ask-user
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

while IFS= read -r relative; do
  [ -n "$relative" ] || continue
  expected="$repo_root/$relative"
  destination="$agent_dir/$relative"

  if [ -L "$destination" ]; then
    current=$(readlink "$destination")
    if [ "$current" != "$expected" ]; then
      printf 'Refusing unrelated link: %s -> %s\n' "$destination" "$current" >&2
      errors=1
    fi
  elif [ -e "$destination" ]; then
    printf 'Refusing non-link path: %s\n' "$destination" >&2
    errors=1
  fi
done <<EOF
$resources
EOF

if [ -L "$dependency_link" ]; then
  current=$(readlink "$dependency_link")
  if [ "$current" != "$dependency_source" ]; then
    printf 'Refusing unrelated dependency link: %s -> %s\n' "$dependency_link" "$current" >&2
    errors=1
  fi
elif [ -e "$dependency_link" ]; then
  printf 'Refusing non-link dependency path: %s\n' "$dependency_link" >&2
  errors=1
fi

[ "$errors" -eq 0 ] || exit "$errors"

while IFS= read -r relative; do
  [ -n "$relative" ] || continue
  destination="$agent_dir/$relative"
  if [ -L "$destination" ]; then
    rm "$destination"
    printf 'Unlinked: %s\n' "$destination"
  else
    printf 'Not linked: %s\n' "$destination"
  fi
done <<EOF
$resources
EOF

if [ -L "$dependency_link" ]; then
  rm "$dependency_link"
  printf 'Unlinked dependencies: %s\n' "$dependency_link"
fi
