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
  expected="$repo_root/$relative"
  destination="$agent_dir/$relative"

  if [ ! -L "$destination" ]; then
    if [ -e "$destination" ]; then
      printf 'Refusing non-link path: %s\n' "$destination" >&2
      errors=1
    else
      printf 'Not linked: %s\n' "$destination"
    fi
    continue
  fi

  current=$(readlink "$destination")
  if [ "$current" != "$expected" ]; then
    printf 'Refusing unrelated link: %s -> %s\n' "$destination" "$current" >&2
    errors=1
    continue
  fi

  rm "$destination"
  printf 'Unlinked: %s\n' "$destination"
done <<EOF
$resources
EOF

exit "$errors"
