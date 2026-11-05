# Related attempts in the queue

One task can need several fresh attempts, including attempts in separate Git
worktrees. Explicitly link the new attempt to an earlier run to keep its queue
card and history together:

```sh
agentflow run build-feature --project ./checkout --task "Implement the bounded change" \
  --related-to <earlier-run-id> --related-reason "Fresh attempt against the newer baseline"
```

`run-and-watch` supports the same options. The workflow MCP tools expose
`relatedRunId` and `relatedRunReason`; programmatic admission accepts those fields
on `queueWorkflow` and `createWorkflowRun`. Supply a requester actor when calling
storage directly. Both relation fields are required together.

The referenced run must exist in the same registered logical project. Separate
worktrees keep separate execution locations. Similar task text, a shared chat,
or matching project names do not establish a relationship. Without an explicit
relation, a new task stays independent.

The link is recorded atomically with the fresh run and a receipt. It is used for
queue grouping only. Each attempt retains its own run set, task IDs, policy,
grants, approval decisions, side-effect receipts, tests, and acceptance evidence.
Linking does not replay a run, copy a checkpoint, accept an earlier failure, or
grant permission to execute anything. Recovery uses its existing governed paths.

The card shows the latest unfinished attempt and retains the other attempts in
history. A completed attempt does not silently hide an older unresolved attempt.
Dismissal or acceptance of that remaining work requires its own evidence and
authority. Existing historical runs are not rewritten or automatically grouped
by this change.
