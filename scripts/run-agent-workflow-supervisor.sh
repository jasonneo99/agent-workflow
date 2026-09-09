#!/bin/zsh
set -euo pipefail

repo_dir="${0:A:h:h}"
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  print -u2 "Agent Workflow supervisor: Node.js was not found on the stable developer PATH."
  exit 127
fi
cd "$repo_dir"
exec "$node_bin" "$repo_dir/scripts/dev-agentflow.mjs"
