# Context Intelligence Gateway

The Context Intelligence Gateway reduces frontier-model input without hiding
risk-sensitive evidence. Its default `shadow` mode records what it would route
while preserving existing read behavior.

The shared policy is `policies/context-routing.yaml`. It routes by estimated
tokens, intent, risk, and whether a targeted deterministic lookup is possible.
A fixed line-count threshold is intentionally not used.

## Observe

Every project index pass emits privacy-safe observation batches under
`.agent-workflow/context-gateway/observations/`. Records contain content and
path hashes, estimates, route rationale, and risk class. They never contain file
bodies or clear local paths.

```bash
npm run index-project -- -p /path/to/project
npm run context-report -- -p /path/to/project
```

The report measures projected savings across all observed reads. It does not
present compression on delegated reads as total workflow savings.

## Evaluate And Route

`context-holdout` accepts project-local JSON cases with required terms, direct
and routed answers, citation validity, token counts, and added latency. It
persists only the aggregate gate result and a hash of the cases—not answer
bodies. Enforcement requires at least three passing cases, correct citations,
at least 30% token savings, and p95 added latency no higher than 30 seconds.

```bash
npm run context-holdout -- -p /path/to/project \
  --cases /path/to/project/.agent-workflow/evals/context-holdout.json

npm run context-route -- -p /path/to/project \
  --file src/service.ts \
  --question "Where is authorization enforced?" \
  --intent authorization
```

Shadow and advisory modes never block. Enforce mode additionally requires the
persisted passing holdout result and an explicit `--holdout-approved` flag.
Exact reads always remain available with `--exact`; high-risk and low-confidence
work is promoted to the frontier route.

When executed, eligible routed reads use the configured provider's file
summarizer. Structured claims include content hashes, line spans when resolved,
confidence, and exact-read handles. Summaries are cached under the target
project with project-id isolation, TTL, bounded entry size, and invalidation
keys covering content, policy, processor, model, question class, and schema.
Each route attempt writes a body-free local receipt.

## Claude Code And Cursor Hooks

Preview first, then merge a project hook without removing existing hooks:

```bash
npm run context-host-setup -- --host claude -p /path/to/project
npm run context-host-setup -- --host claude -p /path/to/project --write
npm run context-host-doctor -- --host claude -p /path/to/project

npm run context-host-setup -- --host cursor -p /path/to/project --write
npm run context-host-doctor -- --host cursor -p /path/to/project
```

The Claude adapter handles `Read` `PreToolUse` input and preserves targeted
offset/limit reads. The Cursor adapter handles `beforeReadFile`, returns its
documented allow/deny shape, and installs with `failClosed: true`. Both reuse
the shared routing policy and direct denied reads to `context-route`; neither
can enable enforcement without a project-local `enforce` policy and passing
holdout evidence.

## Governed Repetitive-Code Generation

Generation never writes directly to the requested target. The fast configured
provider returns an exact-target candidate, which is staged under
`.agent-workflow/context-gateway/codegen/` with reference, specification, and
candidate hashes plus a bounded review diff.

```bash
npm run context-codegen -- -p /path/to/project \
  --spec "Add tests following the reference pattern" \
  --reference tests/reference.test.ts \
  --target tests/generated.test.ts

npm run context-codegen -- -p /path/to/project \
  --plan <plan-id> --approved --reviewed-by "Reviewer" \
  --validate-command "npm test"
```

Promotion requires explicit diff-review confirmation, a named reviewer, an
allowed validation command, and project-policy approval for the target. Failed
validation restores the prior content or removes a newly created target. The
terminal plan records validation and rollback evidence.
