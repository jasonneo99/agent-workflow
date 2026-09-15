#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTFLOW_CLI=(node "$ROOT_DIR/dist/apps/cli/src/index.js")

WORKFLOW="provider-smoke"
TASK="${AGENTFLOW_PROVIDER_SMOKE_TASK:-Return a concise provider contract smoke result. Do not request commands. Do not request file writes.}"
PROJECT_DIR="$ROOT_DIR/templates/provider-smoke"

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
retry 10 2 "${AGENTFLOW_CLI[@]}" doctor

echo "==> Provider check"
"${AGENTFLOW_CLI[@]}" provider-check

echo "==> Bootstrap registry"
retry 10 2 "${AGENTFLOW_CLI[@]}" bootstrap-storage

echo "==> Validate definitions"
"${AGENTFLOW_CLI[@]}" validate

echo "==> Queue provider smoke run"
RUN_OUTPUT="$("${AGENTFLOW_CLI[@]}" run "$WORKFLOW" --project "$PROJECT_DIR" --task "$TASK" --no-brief)"
echo "$RUN_OUTPUT"
RUN_ID="$(printf '%s\n' "$RUN_OUTPUT" | awk '/Queued workflow run/ {print $4}')"

if [[ -z "$RUN_ID" ]]; then
  echo "Could not parse queued workflow run id." >&2
  exit 1
fi

echo "==> Execute one provider stage"
"${AGENTFLOW_CLI[@]}" worker --limit 1

echo "==> Inspect provider smoke run"
RUN_STATUS=""
for _ in $(seq 1 30); do
  RUN_STATUS="$("${AGENTFLOW_CLI[@]}" status --run "$RUN_ID" --artifacts)"
  if printf '%s\n' "$RUN_STATUS" | grep -Eq "^$RUN_ID (completed|failed) "; then
    break
  fi
  sleep 1
done
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
