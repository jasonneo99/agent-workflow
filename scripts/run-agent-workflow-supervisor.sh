#!/bin/zsh
set -euo pipefail

repo_dir="${0:A:h:h}"
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

otel_keychain_service="${AGENTFLOW_OTEL_AUTHORIZATION_KEYCHAIN_SERVICE:-}"
if [[ -n "$otel_keychain_service" ]]; then
  security_bin="$(command -v security || true)"
  if [[ -z "$security_bin" ]]; then
    print -u2 "Agent Workflow supervisor: macOS Keychain access was requested, but the security command was not found."
    exit 78
  fi
  otel_keychain_account="${AGENTFLOW_OTEL_AUTHORIZATION_KEYCHAIN_ACCOUNT:-agent-workflow}"
  otel_authorization="$($security_bin find-generic-password -a "$otel_keychain_account" -s "$otel_keychain_service" -w)"
  if [[ -z "$otel_authorization" ]]; then
    print -u2 "Agent Workflow supervisor: the configured OpenTelemetry authorization value is empty."
    exit 78
  fi
  export OTEL_EXPORTER_OTLP_HEADERS="Authorization=$otel_authorization"
  unset otel_authorization
fi

node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  print -u2 "Agent Workflow supervisor: Node.js was not found on the stable developer PATH."
  exit 127
fi
cd "$repo_dir"
exec "$node_bin" "$repo_dir/scripts/dev-agentflow.mjs"
