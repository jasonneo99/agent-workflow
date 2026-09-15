# Evaluation: Daemon model comparison (standard)

- Suite: daemon-model-comparison-standard
- Workflow: provider-smoke
- Generated: 2026-09-15T20:08:52.519Z
- Winner: openai-standard
- Scoring: shared default ranking

## Variant comparison

| Variant | Provider | Tier | Score | Pass rate | Quality | Avg latency | Fallbacks/run | Feedback |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| openai-standard | openai | standard | default | 1 | 1 | 3831ms | 0 | none |
| anthropic-standard | anthropic | standard | default | 0 | n/a | 743ms | 0 | none |

## Runs

- standard-safe-repository-task / openai-standard: PASS — quality=1, latency=3831ms, fallbacks=0, run=1ea6c628-bba3-4b51-8186-0bd69e2915c2
- standard-safe-repository-task / anthropic-standard: FAIL — quality=n/a, latency=743ms, fallbacks=0, run=a81ddac0-1bcd-4b7a-8034-8a376500f8e4
  - status failed did not match completed; quality n/a was below 0.7
