#!/usr/bin/env bash
set -euo pipefail

log_file="${AGENTFLOW_MCP_LAUNCH_LOG_FILE:-$HOME/Projects/Agent Workflow/.agent-workflow/runtime/mcp/launcher.log}"
log_event() {
  mkdir -p "$(dirname "$log_file")" 2>/dev/null || true
  printf '{"ts":"%s","event":"%s","pid":%s,"detail":"%s"}\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$1" "$$" "${2//\"/\\\"}" >> "$log_file" 2>/dev/null || true
}

candidate_paths=()

if [[ -n "${AGENT_WORKFLOW_HOME:-}" ]]; then
  candidate_paths+=("$AGENT_WORKFLOW_HOME")
fi

candidate_paths+=(
  "$HOME/Projects/Agent Workflow"
  "$HOME/Documents/Agent Workflow"
  "$HOME/agent-workflow"
  "$HOME/Projects/agent-workflow"
)

log_event "launcher-start" "candidates=${candidate_paths[*]}"

for candidate in "${candidate_paths[@]}"; do
  if [[ -f "$candidate/package.json" && -f "$candidate/apps/mcp/src/index.ts" ]]; then
    cd "$candidate"
    export AGENTFLOW_MCP_LOG_FILE="${AGENTFLOW_MCP_LOG_FILE:-$candidate/.agent-workflow/runtime/mcp/stdio.log}"
    if [[ -f "$candidate/dist/apps/mcp/src/index.js" ]]; then
      log_event "launcher-resolved" "$candidate dist"
      exec node "$candidate/dist/apps/mcp/src/index.js"
    fi
    log_event "launcher-resolved" "$candidate tsx"
    exec npm run -s mcp
  fi
done

{
  echo "Agent Workflow MCP server could not start."
  echo "Set AGENT_WORKFLOW_HOME to the cloned agent-workflow repository."
  echo "Tried:"
  printf '  %s\n' "${candidate_paths[@]}"
} >&2

log_event "launcher-failed" "no repository found"
exit 1
