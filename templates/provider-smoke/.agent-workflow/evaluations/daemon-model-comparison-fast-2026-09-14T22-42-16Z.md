# Evaluation: Daemon model comparison (fast)

- Suite: daemon-model-comparison-fast
- Workflow: provider-smoke
- Generated: 2026-09-14T22:42:16.978Z
- Winner: anthropic-fast
- Scoring: shared default ranking

## Variant comparison

| Variant | Provider | Tier | Score | Pass rate | Quality | Avg latency | Fallbacks/run | Feedback |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| anthropic-fast | anthropic | fast | default | 1 | 1 | 4025ms | 0 | none |
| openai-fast | openai | fast | default | 1 | 1 | 6436ms | 0 | none |

## Runs

- fast-safe-repository-task / openai-fast: PASS — quality=1, latency=6436ms, fallbacks=0, run=c821d233-3d16-42a7-8716-d8cd9e4d7bdf
- fast-safe-repository-task / anthropic-fast: PASS — quality=1, latency=4025ms, fallbacks=0, run=62108c91-e0fd-48c9-a424-32f7350203b8
