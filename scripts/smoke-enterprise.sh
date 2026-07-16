#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="${AGENTFLOW_SMOKE_PROJECT:-templates/project}"
WORKFLOW="${AGENTFLOW_SMOKE_WORKFLOW:-build-feature}"
TASK="${AGENTFLOW_SMOKE_TASK:-Smoke test portable agent workflow}"
PROVIDER="${AGENTFLOW_SMOKE_PROVIDER:-mock}"

echo "==> Doctor"
npm run doctor

echo "==> Bootstrap registry"
npm run bootstrap-storage

echo "==> Validate definitions"
npm run validate

echo "==> Index smoke project"
npm run index-project -- --project "$PROJECT_DIR"

echo "==> Compile workflow brief"
npm run compile -- --workflow "$WORKFLOW" --project "$PROJECT_DIR" --task "$TASK" >/tmp/agentflow-smoke-compiled-brief.md

echo "==> Queue workflow run"
RUN_OUTPUT="$(npm run agentflow -- run "$WORKFLOW" --project "$PROJECT_DIR" --task "$TASK" --no-brief)"
echo "$RUN_OUTPUT"
RUN_ID="$(printf '%s\n' "$RUN_OUTPUT" | awk '/Queued workflow run/ {print $4}')"

if [[ -z "$RUN_ID" ]]; then
  echo "Could not parse queued workflow run id." >&2
  exit 1
fi

echo "==> Execute worker with provider: $PROVIDER"
DEFAULT_MODEL_PROVIDER="$PROVIDER" npm run worker -- --limit 12

echo "==> Inspect workflow run"
RUN_STATUS="$(npm run agentflow -- status --run "$RUN_ID" --artifacts)"
echo "$RUN_STATUS"

if ! printf '%s\n' "$RUN_STATUS" | grep -q "^$RUN_ID completed "; then
  echo "Smoke workflow did not complete: $RUN_ID" >&2
  exit 1
fi

echo "==> Template project checks"
npm test --prefix "$PROJECT_DIR"
npm run typecheck --prefix "$PROJECT_DIR"
npm run lint --prefix "$PROJECT_DIR"

echo "Smoke passed: $RUN_ID"
