# V1 improvement plan

Approved direction, 2026-11-03: strengthen and improve the existing Agent
Workflow platform. V2 is retired from active development and retained as a
learning experiment. This plan supersedes the idea that a replacement runtime
is the next delivery line; it does not erase earlier decisions or run evidence.

## Objective

Complete bounded coding tasks through the normal pipeline without a separate
chat repairing its machinery. Keep the useful current engine, queue, management
interface and Studio contracts while improving reliability in small steps.
Human approvals and ordinary review feedback remain part of controlled work.

## Long-term goals retained

1. Delegate outcomes with less manual coordination and repair.
2. Retain useful project understanding across chats, models and machines, with
   provenance and freshness checks.
3. Improve through verified outcomes, failures and review; evaluate changes and
   reverse regressions.
4. Reduce cost and elapsed time per accepted outcome, including human effort.
5. Earn greater autonomy through measured reliability and scoped authority.
6. Provide coherent priorities, progress, approvals and results across projects
   and interfaces.
7. Remain a portable, open-source platform with provider independence and
   owner-controlled private context.

Codex CLI remains the current primary executor preference through replaceable
provider contracts. Hosted and local model support remains a product goal.
Users should be able to add and manage models through the application UI.
Normal model setup should not require a separate CLI process or manual `.env`
editing. These requirements do not select a new storage system or authorize provider,
credential, platform or UI migrations.

## Immediate priorities

1. **Admit executable tasks.** Check source scope, write capability, ownership,
   dependencies, environment and the declared behavioral test recipe before
   model execution. Explain missing prerequisites and valid policy holds.
2. **Accept the actual result.** Preserve requirements; bind executed checks to
   the final candidate, obtain fresh independent verification and use governed
   integration. Distinguish task/stage completion from functional acceptance
   and installed, native or visible product acceptance.
3. **Make recovery predictable.** Keep one current owner, durable effect
   receipts, finite attempts, deduplication and backoff. Exercise cancellation,
   worker loss and interrupted result consumption. Hold uncertain effects
   until authenticated reconciliation; callbacks alone cannot trigger repair.
4. **Make operation understandable.** Show actual execution state, actionable
   blockers, acceptance gaps, intervention history and the providers/models
   that ran. Improve model setup and the existing interfaces over shared state.
5. **Simplify from evidence.** Remove duplicate responsibility or unnecessary
   handoffs only after reproducing their cost or failure mechanism and
   preserving contracts, data, ownership and recovery behavior. Expand model
   and platform support through explicit qualification.

The [stabilization record](v1-stabilization.md) and
[environment contract](run-environments.md) remain implementation references.
Historical checkboxes and local successes do not establish universal reliability
or current release readiness; inspect current canonical evidence before claims.

## Lessons to apply, with limits

- Executed writes and post-edit tests outrank completion prose. Retain exact
  evidence outside truncated provider history and consume results before
  deciding completion or budget exhaustion.
- Keep task scope stable. Source success does not imply installed/native/UI
  delivery, and diagnostic history cannot invent extra requirements.
- Keep independent acceptance outside candidate control. Reuse negative test
  ideas from experimental verifier failures without assuming those failures
  exist in the current v1 runtime.
- Verify cleanup and recovery through exact owned resources, invocation identity
  and original deadlines. Process exit alone is insufficient evidence.
- Use compact model diagnostics and precise evidence references; keep full raw
  traces private. Measure improvements against accepted outcomes.

Evaluate candidate reuse one component at a time, including its contract,
dependencies, licensing and behavioral evidence. V2's SQLite runtime, API loop,
WASM/signing design, replacement UI and proposed pilot thresholds are not
approved v1 migrations or acceptance claims.

## Evidence for the next improvement

Select one observed failure or operator burden, a bounded patch and explicit
acceptance checks. Freeze the case inputs and distinguish coding outcomes,
valid holds and deliberate negative controls. Record outside machinery repairs,
false completion, attempts, elapsed time and cost per accepted result.
Include ordinary code correction through the workflow without hiding the first
failed review. Add lifecycle or platform cases when the changed behavior needs
them; preserve failed observations and independent checks.

Promote improvements through review, appropriate tests, runtime adoption evidence
when relevant and a reversible rollout. This direction update starts no new
runtime, queue, provider, service, release or deployment action. Keep private
paths, run identities and operational records outside public source according
to the [open-source boundary](open-source-boundary.md).
