#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
agent_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}

resources='extensions/ask-user
extensions/background-terminals
extensions/file-search
extensions/progress-tracker
extensions/subagents
extensions/summaries
skills/background-terminals
skills/subagents'

errors=0
while IFS= read -r relative; do
  [ -n "$relative" ] || continue
  source_path="$repo_root/$relative"
  destination="$agent_dir/$relative"

  if [ ! -e "$source_path" ]; then
    printf 'Missing source: %s\n' "$source_path" >&2
    errors=1
    continue
  fi

  mkdir -p "$(dirname -- "$destination")"
  if [ -L "$destination" ]; then
    current=$(readlink "$destination")
    if [ "$current" = "$source_path" ]; then
      printf 'Already linked: %s\n' "$destination"
    else
      printf 'Refusing incorrect link: %s -> %s\n' "$destination" "$current" >&2
      errors=1
    fi
    continue
  fi

  if [ -e "$destination" ]; then
    printf 'Refusing existing path: %s\n' "$destination" >&2
    errors=1
    continue
  fi

  ln -s "$source_path" "$destination"
  printf 'Linked: %s -> %s\n' "$destination" "$source_path"
done <<EOF
$resources
EOF

exit "$errors"
