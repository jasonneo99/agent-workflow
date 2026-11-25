# Dashboard SLA Report — 2026-09-25

## Scope

The isolated dashboard canary measured all 25 top-level routes once from a cold
process and five times after a persisted-process restart. Every response
returned HTTP 200. The warm-route budget was p95 at or below 800 ms.

## Result

Status: **failed** — 22 of 25 routes passed the warm p95 budget.

| Route | Warm median | Warm p95 | Result |
| --- | ---: | ---: | --- |
| activity | 1,455.8 ms | 1,551.2 ms | over budget |
| evaluations | 4.0 ms | 982.4 ms | over budget |
| model-catalog | 3.8 ms | 2,011.0 ms | over budget |
| approval-rules | 477.4 ms | 557.9 ms | pass |
| artifact-lifecycle | 34.1 ms | 490.2 ms | pass |
| candidate-comparisons | 26.5 ms | 398.6 ms | pass |
| providers | 3.8 ms | 376.2 ms | pass |
| all other routes | 4.4–150.4 ms | 5.6–268.8 ms | pass |

The result is deliberately not marked green merely because most median values
are fast. `activity` is consistently slow, while `evaluations` and
`model-catalog` show expensive intermittent refreshes that dominate a small
five-sample p95.

## Next performance work

1. Bound the activity query and aggregate or paginate historical receipt data.
2. Keep evaluation and model-catalog discovery out of the request path; serve a
   cached snapshot and refresh it asynchronously.
3. Re-run the same 25-route, five-sample canary after each repair. Do not narrow
   the route list or relax the 800 ms budget to manufacture a pass.

## Reproduction

```bash
npm run dashboard:sla -- --project . --samples 5 --warm-budget-ms 800
```

The detailed machine-readable evidence remains project-local under
`.agent-workflow/runtime/dashboard-sla/latest.json`.
