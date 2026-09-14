# Daemon Control Plane

Agent Workflow exposes eight logical daemon lanes under one supervised local
runtime. Keeping one supervisor avoids duplicate scheduling and competing
writes, while lane-specific trust ceilings keep authority independently
controllable.

| Lane | Autonomous responsibility |
| --- | --- |
| Evidence Collector | Ingest local run, feedback, evaluation, provider, cost, and context evidence; detect anomalies and staleness; write scrubbed digests. |
| Workflow & Model Optimizer | Continuously compare completed provider/model evaluations by job tier, quality, fallback rate, latency, and evidence coverage; update project-local routing preferences only after gates pass. |
| Action Executor | Apply eligible changes, validate outcomes, roll back regressions, escalate blocked work, and write receipts. |
| Runtime Maintenance | Reconcile stale runs, clean stale MCP sessions, maintain offline sync and caches, and surface capacity problems. |
| Repository Steward | Inspect dependencies and source hygiene, find missing tests/docs, apply eligible maintenance, and create validated local commits when enabled. |
| Release & CI Guardian | Triage CI failures and prepare release-readiness evidence. It does not publish releases automatically. |
| Security Sentinel | Inspect dependencies, configuration, secret exposure, and trust-boundary regressions; apply only policy-eligible remediations. |
| Backup & Recovery Verifier | Check backup freshness, artifact integrity, and restore readiness; use non-destructive restore drills and receipts. |

The Learning dashboard stores a `low`, `medium`, or `high` maximum autonomous
risk for every lane in project-local `.agent-workflow/learning/settings.json`.
The Action Executor ceiling also caps the existing autonomous learning apply and
approval-autopilot thresholds.

Trust is one gate, not blanket permission. An action runs only when its risk is
at or below the selected ceiling and all applicable project policy, command and
write allowlists, validation, idempotency, receipt, and open-source-boundary
checks pass. High trust therefore permits eligible high-risk actions; it does
not authorize destructive operations, secret exposure, publication, deployment,
history rewriting, or cross-project writes that another gate forbids.

The lanes initially share the existing learning-daemon process and durable
supervisor. This is intentional: the contract is already separable, but a
process split should be operational isolation rather than duplicated behavior.
Action Executor and Runtime Maintenance are the first candidates for separate
processes if load or fault-isolation evidence justifies it.
