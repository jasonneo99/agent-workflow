#!/usr/bin/env bash
set -euo pipefail

WORKFLOW="provider-smoke"
TASK="${AGENTFLOW_PROVIDER_SMOKE_TASK:-Return a concise provider contract smoke result. Do not request commands. Do not request file writes.}"
PROJECT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentflow-provider-smoke.XXXXXX")"

cleanup() {
  rm -rf "$PROJECT_DIR"
}
trap cleanup EXIT

mkdir -p "$PROJECT_DIR/.agent-workflow"

cat >"$PROJECT_DIR/AGENTS.md" <<'EOF'
# AGENTS.md

This is an isolated provider smoke project. Do not request commands or file writes.
EOF

cat >"$PROJECT_DIR/.agent-workflow/context.md" <<'EOF'
# Project Context

This temporary project exists only to verify that the selected model provider can return valid structured workflow output.
EOF

cat >"$PROJECT_DIR/.agent-workflow/commands.md" <<'EOF'
# Commands

No commands are allowed for this provider smoke project.
EOF

cat >"$PROJECT_DIR/.agent-workflow/decisions.md" <<'EOF'
# Decisions

No durable decisions are recorded for provider smoke tests.
EOF

cat >"$PROJECT_DIR/.agent-workflow/project.yaml" <<'EOF'
project:
  name: Provider Smoke Project
  summary: Temporary project for provider contract validation.
  default_workflows:
    - provider-smoke
  autonomy: 1
context:
  include:
    - AGENTS.md
    - .agent-workflow/**
  exclude:
    - node_modules/**
    - .git/**
  max_project_tokens: 2000
storage:
  cache_summaries: false
  semantic_index: false
policies:
  allow_wide_open: false
  require_approval_for_external_actions: true
  require_receipts: true
actions:
  allowed_commands: []
  blocked_commands:
    - "*"
  command_timeout_ms: 30000
  max_output_chars: 4000
  allowed_write_paths: []
  blocked_write_paths:
    - "**"
  max_write_bytes: 1
EOF

retry() {
  local attempts="$1"
  local delay_seconds="$2"
  shift 2

  for attempt in $(seq 1 "$attempts"); do
    if "$@"; then
      return 0
    fi

    if [[ "$attempt" == "$attempts" ]]; then
      echo "Command failed after $attempts attempts: $*" >&2
      return 1
    fi

    echo "Command failed, retrying in ${delay_seconds}s ($attempt/$attempts): $*" >&2
    sleep "$delay_seconds"
  done
}

echo "==> Doctor"
retry 10 2 npm run doctor

echo "==> Provider check"
npm run provider-check

echo "==> Bootstrap registry"
retry 10 2 npm run bootstrap-storage

echo "==> Validate definitions"
npm run validate

echo "==> Queue provider smoke run"
RUN_OUTPUT="$(npm run agentflow -- run "$WORKFLOW" --project "$PROJECT_DIR" --task "$TASK" --no-brief)"
echo "$RUN_OUTPUT"
RUN_ID="$(printf '%s\n' "$RUN_OUTPUT" | awk '/Queued workflow run/ {print $4}')"

if [[ -z "$RUN_ID" ]]; then
  echo "Could not parse queued workflow run id." >&2
  exit 1
fi

echo "==> Execute one provider stage"
npm run worker -- --limit 1

echo "==> Inspect provider smoke run"
RUN_STATUS="$(npm run agentflow -- status --run "$RUN_ID" --artifacts)"
echo "$RUN_STATUS"

if ! printf '%s\n' "$RUN_STATUS" | grep -q "^$RUN_ID completed "; then
  echo "Provider smoke workflow did not complete: $RUN_ID" >&2
  exit 1
fi

if ! printf '%s\n' "$RUN_STATUS" | grep -q "stage_output:"; then
  echo "Provider smoke workflow did not produce a stage_output artifact: $RUN_ID" >&2
  exit 1
fi

echo "Provider smoke passed: $RUN_ID"
