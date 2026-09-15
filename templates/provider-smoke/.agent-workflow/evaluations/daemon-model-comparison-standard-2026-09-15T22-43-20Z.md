# Evaluation: Daemon model comparison (standard)

- Suite: daemon-model-comparison-standard
- Workflow: provider-smoke
- Generated: 2026-09-15T22:43:20.556Z
- Winner: openai-standard
- Scoring: shared default ranking

## Variant comparison

| Variant | Provider | Tier | Score | Pass rate | Quality | Avg latency | Fallbacks/run | Feedback |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| openai-standard | openai | standard | default | 1 | 1 | 5012ms | 0 | none |
| anthropic-standard | anthropic | standard | default | 0 | n/a | 645ms | 0 | none |

## Runs

- standard-safe-repository-task / openai-standard: PASS — quality=1, latency=5012ms, fallbacks=0, run=e0344d44-7bd0-4717-9786-cc04a0f217a9
- standard-safe-repository-task / anthropic-standard: FAIL — quality=n/a, latency=645ms, fallbacks=0, run=e7c75b42-5dcf-4e59-a298-1a79e2f0677a
  - status failed did not match completed; quality n/a was below 0.7
