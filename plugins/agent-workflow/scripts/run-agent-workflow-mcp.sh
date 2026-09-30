#!/usr/bin/env bash
set -euo pipefail

candidate_paths=()

plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bundled_entrypoint="$plugin_root/runtime/node_modules/@jasonneo99/agent-workflow/dist/apps/mcp/src/index.js"
runtime_archive="$plugin_root/runtime-bundle.tgz"
runtime_checksum_file="$plugin_root/runtime-bundle.tgz.sha256"

if [[ "${AGENTFLOW_PLUGIN_FORCE_ARCHIVE:-0}" != "1" && -f "$bundled_entrypoint" ]]; then
  export AGENT_WORKFLOW_HOME="${AGENT_WORKFLOW_HOME:-$plugin_root/runtime/node_modules/@jasonneo99/agent-workflow}"
  exec node "$bundled_entrypoint"
fi

if [[ -f "$runtime_archive" && -f "$runtime_checksum_file" ]]; then
  expected_checksum="$(awk '{print $1}' "$runtime_checksum_file")"
  if command -v shasum >/dev/null 2>&1; then
    actual_checksum="$(shasum -a 256 "$runtime_archive" | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    actual_checksum="$(sha256sum "$runtime_archive" | awk '{print $1}')"
  else
    echo "Cannot verify bundled runtime: shasum or sha256sum is required." >&2
    exit 1
  fi
  if [[ "$actual_checksum" != "$expected_checksum" ]]; then
    echo "Bundled Agent Workflow runtime checksum mismatch." >&2
    exit 1
  fi

  cache_base="${XDG_CACHE_HOME:-$HOME/.cache}/agent-workflow-plugin"
  extracted_root="$cache_base/$actual_checksum"
  extracted_entrypoint="$extracted_root/node_modules/@jasonneo99/agent-workflow/dist/apps/mcp/src/index.js"
  if [[ ! -f "$extracted_entrypoint" ]]; then
    mkdir -p "$extracted_root"
    tar -xzf "$runtime_archive" -C "$extracted_root"
  fi
  if [[ ! -f "$extracted_entrypoint" ]]; then
    echo "Bundled Agent Workflow runtime extraction did not produce the MCP entrypoint." >&2
    exit 1
  fi
  export AGENT_WORKFLOW_HOME="${AGENT_WORKFLOW_HOME:-$extracted_root/node_modules/@jasonneo99/agent-workflow}"
  exec node "$extracted_entrypoint"
fi

if [[ -n "${AGENT_WORKFLOW_HOME:-}" ]]; then
  candidate_paths+=("$AGENT_WORKFLOW_HOME")
fi

candidate_paths+=("$plugin_root/../..")

for candidate in "${candidate_paths[@]}"; do
  if [[ -f "$candidate/package.json" && -f "$candidate/apps/mcp/src/index.ts" ]]; then
    cd "$candidate"
    if [[ -f "$candidate/dist/apps/mcp/src/index.js" ]]; then
      exec node "$candidate/dist/apps/mcp/src/index.js"
    fi
    exec npm run -s mcp
  fi
done

if command -v agentflow-mcp >/dev/null 2>&1; then
  exec agentflow-mcp
fi

cat >&2 <<'EOF'
Agent Workflow MCP server could not start.
The bundled runtime is missing. Rebuild the plugin, set AGENT_WORKFLOW_HOME to
an Agent Workflow checkout, or install the package:
  npm install --global @jasonneo99/agent-workflow
EOF
exit 1
