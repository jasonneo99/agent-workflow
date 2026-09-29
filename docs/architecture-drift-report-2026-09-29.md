# Architecture Drift Report — 2026-09-29

## Scope

This report reconciles the uncommitted Muse-era working tree against
`AGENTS.md`, the open-source boundary, and the architecture documented in this
repository. It distinguishes implemented behavior from intent and does not
treat an agent-generated claim as delivery evidence.

Reviewed areas:

- Studio requester, approval, continuation, outcome, and project-selection UI;
- requester metadata and notification outbox storage;
- bounded file discovery and mutation recovery;
- supervised workflow recovery and delivery evidence;
- the `trusted-personal` execution profile;
- project-alias consolidation; and
- supporting tests and operator documentation.

## Aligned Changes

### Requester-aware run control plane

Run creation, replay, supervised repair, and Studio now preserve requester and
requester-channel metadata. Approval and blocked-run events can create durable
outbox records, and reply handling routes a decision back through the existing
approval and checkpoint-resume contracts. This fits the durable, auditable
workflow model as long as requester metadata is not mistaken for authenticated
identity.

### Bounded source discovery

Provider artifacts can request bounded filename/path searches before exact file
reads. This closes a recurring failure mode where agents blocked on information
already present in the project. The search remains project-relative, bounded,
receipt-backed, and separate from shell execution.

### Mutation and verification recovery

File-mutation retries now have a dedicated bounded budget, stale patches are
refreshed, and a refreshed response can supersede an obsolete rejected patch.
Verification retry accounting remains separate. These changes align with the
existing reliability contract because they preserve policy checks and immutable
receipts.

### Continuation-aware Studio

Studio distinguishes historical runs from current continuations, surfaces
blockers and approvals inline, and exposes a separate outcome contract instead
of equating terminal stage state with delivery. This is directionally aligned
with truthful outcome reporting.

### Transactional project consolidation

The storage layer can merge an obsolete project registration into a selected
canonical registration while retaining runs, memory, index state, and
performance baselines. This is appropriate only behind exact operator-selected
identities and a verified backup gate.

## Drift And Gaps

### D1 — Private notification topology is in the open-source tree

**Severity:** high  
**Status:** open

`scripts/notify-requester.py` names a private product service and includes a
real private-network hostname as its default. `docs/chat-mode.md` also presents
that private service, token, local absolute path, and personal-device behavior
as if they were portable framework setup.

This conflicts with the repository-wide open-source boundary. The framework
should ship only a generic stdin/stdout or HTTP webhook adapter contract with a
synthetic URL. The private mobile-push bridge, host topology, token names tied
to that deployment, and launchd overlay belong in the private companion
repository. Do not release the current bridge or examples unchanged.

### D2 — Outcome delivery evidence is syntactic, not contract-relevant

**Severity:** high  
**Status:** open

`buildRunOutcomeContract` currently accepts any recorded `file_write` plus any
successful `command_output` from the run lineage. That can mark a delivery
ready when the write is only a receipt/doc, the command is diagnostic, or the
evidence belongs to an unrelated continuation.

Delivery evidence needs relevance constraints: product-path classification,
verification purpose and target, expected acceptance checks, continuation
contract compatibility, and explicit exclusions for generated receipts,
planning artifacts, and unrelated successful commands.

### D3 — Requester identity is not authenticated

**Severity:** high  
**Status:** open

CLI flags, environment variables, and hidden Studio form fields can supply the
requester and actor strings. Those values are useful routing metadata but are
not proof of identity. Approval role gates reduce the impact, but external
delivery adapters and reply ingestion still need a verified principal binding,
channel-specific anti-replay data, and an exact approval/run association.

### D4 — The bundled notification bridge logs full message bodies

**Severity:** high  
**Status:** open

The bridge appends the complete notification JSON to a user-local log. Blocker
and approval bodies can contain private project context, filenames, or command
details. A portable bridge should log only notification id, run id, channel,
result, and bounded error classification by default. Content logging must be an
explicit private deployment option with retention controls.

### D5 — `trusted-personal` has a broad command surface

**Severity:** medium  
**Status:** open

The profile allows broad `git *`, `gh *`, `python3 *`, `node *`, `find *`, and
similar patterns, relying on block rules and later classification to catch
external or destructive variants. That is convenient but wider than the
documented “ordinary development” contract and raises parser-bypass and
side-effect-classification risk.

Replace broad patterns with verb-level allowlists, add policy tests for remote
mutation and data exfiltration variants, and keep the profile opt-in. Shared,
remote, staging, and production projects must not inherit it.

### D6 — Project canonicalization uses host-path heuristics

**Severity:** medium  
**Status:** open

Studio hides presumed aliases using `/Users/.../Projects`,
`/home/.../Projects`, and local-share path patterns. This is presentation-only,
but it embeds OS conventions and can hide two distinct projects with similar
names and suffixes.

Move canonical identity to a stable project key or explicit alias table from
storage. The UI should consume that decision rather than infer identity from
usernames and paths.

### D7 — Project consolidation backup is not one atomic guarantee

**Severity:** medium  
**Status:** open

The database merge is transactional, but backup creation necessarily occurs
outside the transaction. The control path must verify backup identity,
timestamp, integrity, and target database before beginning the merge, record
that evidence with the consolidation receipt, and refuse stale or mismatched
backups.

### D8 — Notification delivery semantics conflate visibility and delivery

**Severity:** medium  
**Status:** open

Dashboard and CLI channels can be marked delivered without an external bridge.
That is valid for “recorded and visible,” but the state name can imply the
requester actually received the message. Split or document states such as
`recorded`, `presented`, `delivered`, and `failed`, with retries and dead-letter
handling for external adapters.

### D9 — Schema and behavior need migration/upgrade evidence

**Severity:** medium  
**Status:** open

The additive schema introduces requester columns and `run_notifications`.
Unit/source assertions are useful, but release readiness still needs a fresh
upgrade test from the prior schema, idempotent rerun evidence, rollback or
compatibility behavior for older binaries, and representative notification
deduplication under concurrent approval/block events.

### D10 — Documentation currently overstates completion

**Severity:** low  
**Status:** partially corrected

The Chat Mode roadmap marks the full integration complete even though D1–D9
remain open. Documentation should distinguish “implemented locally,” “verified
by tests,” “portable/open-source ready,” and “deployed/accepted.” This report
and the architecture update restore that distinction; the active roadmap file
was not edited because another live work intent owns it.

## Recommended Order

1. Remove or generalize the private notification bridge before any public
   commit or release.
2. Bind requester replies to verified principals and exact channel events.
3. Strengthen outcome evidence relevance before using `acceptReady` for
   automatic promotion or completion.
4. Narrow `trusted-personal` command patterns and add adversarial policy tests.
5. Replace path heuristics with durable project identity and alias records.
6. Add notification lifecycle, concurrent deduplication, and schema-upgrade
   acceptance tests.
7. Reconcile roadmap checkboxes only after these gates have evidence.

## Verification Boundary

At review time, the full test command passed 686 tests with 1 skipped, and
`git diff --check` passed. `npm run validate-boundary` failed on private-project
identifiers in `apps/cli/src/index.ts` and
`packages/dynamic-workflow/src/index.test.ts`; manual review also found the
private notification coupling described in D1 and D4. The repository remains
intentionally dirty, another active work intent owns Chat Mode/Studio files,
and no public-release readiness claim is made by this report.
