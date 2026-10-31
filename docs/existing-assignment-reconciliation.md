# Existing coordinator assignment reconciliation

An operator may reconcile an existing nonterminal continuation when its recorded
claim points at a terminal predecessor or an expired owner. This operation does
not create a workflow, replay a predecessor, erase failed history, reset attempts,
or establish acceptance. It is intentionally absent from worker/model tools.

Use `previewExistingAssignmentOnClient` inside a transaction to inspect the exact
assignment, continuation, source requirements and current source hash. After a
direct human request covering the existing IDs, obtain a fresh project work intent
for the exact source paths. Supply the reviewed digest to
`reconcileExistingAssignment`; a changed snapshot fails closed. The intent owner
must remain alive and renew its intent throughout the targeted worker invocation.
The worker ID is the returned owner followed by `:` and the new assignment fence.

Reconciliation requires canonical ownership, exact lineage, queued/unleased
remaining tasks, no live old intent, valid original and continuation receipt
chains, no unresolved overlapping assignment, and no pending authority or recorded
file mutations. Previously executed checks remain historical evidence. Their
effects must be reviewed by the operator before using this API; arbitrary or
uncertain external effects require a different effect-specific reconciliation.
Selected commands must be literal entries in the frozen continuation policy.
Reconciled execution removes project file-write permission and isolates command
writes. The API never grants deployment, service control or archive authority.

The historical acceptance contract remains immutable. A supplemental pending
contract binds the same deliverables and required gates to current source bytes.
Its complete old assignment, metadata and policy are retained in an append-only
artifact and chained operator receipt. Stage context and acceptance resolution
require the exact attestation; an unbound metadata field cannot supply a contract.
Historical command references cannot satisfy the fresh contract. Once reconciled,
the same continuation cannot be reconciled again through this operation.

Focused database regression:

```sh
node --import ./scripts/test-environment.mjs --import tsx --test packages/storage/src/existing-assignment-reconciliation.test.ts
```

The test creates a unique transactional schema and disposable synthetic source,
then rolls back the schema and removes the source. It exercises the installed
claim trigger, stale versus fresh workers, history preservation, changed source,
expired/live intents, pending actions, mutation evidence, forged contracts and
repeat rejection. No product host effects or workflow wrappers are needed.

## Explicit repaired resume of the same blocked run

Generic terminal recovery remains forbidden. An operator with a new direct human
repair-and-resume instruction may use `recordVerifiedSourceRepairOnClient` to
seal the exact latest blocked attempt, owned source postimage and fresh passing
governed test artifacts. The artifact and matching chained receipt attest source
repair only, not independent product acceptance. The same postimage or authority
reference cannot mint another proof.

Supply that artifact as `repairProofUri` to the existing preview/reconciliation
API. This mode accepts only the same assigned blocked continuation, with no live
old lease/intent, pending effects, conflicting owner or occupied lane. All prior
source paths and original gates must remain. Repaired files may extend the scope;
they may not shrink it. A changed proof, source or command artifact fails closed.

The transaction stores full prior run/task records, keeps every historical
contract, receipt and artifact, appends a blocked-to-queued operator transition
and notification, then rearms the same tasks without resetting attempts. It
issues fresh assignment fencing and a current pending contract/brief. The proof
is single use and repaired resumes have a finite three-attempt cap. Cancelled,
failed or completed runs cannot use this path. The ordinary state machine and
generic replay guards remain unchanged; workers cannot invoke this operator API.

## Explicit review of a retained cancelled sibling branch

An operator can additionally supply `cancelledBranch` with an exact predecessor
run and its older fence. This is for an already queued continuation whose own
cancelled replay predecessor differs from the assignment's later cancelled child.
It never creates a replay, selects a branch automatically or revives either
cancelled run. It cannot be combined with blocked-run repaired resume.

Both retained predecessors must be cancelled, unleased, in the exact same project,
run set, original source and assignment, with their exact recorded fences. No
branch may retain active tasks, pending approvals, mutation/external-action
evidence or unresolved commands. Historical command targets must be literal
members of the operator's narrowed frozen-policy command set and their recorded
results must have succeeded without timeout. All source/predecessor/current-run
receipt chains verify before a fresh assignment fence is issued. Another active
continuation, owner, lane or overlapping assignment still blocks the operation.

The compare-and-swap preview includes both old branches and their task records.
The chained reconciliation artifact retains the old assignment, selected queued
run, both terminal predecessors and historical contracts; queued task attempts
are not reset. Execution uses current-source attestation, a fresh brief and a
read-only narrowed policy. Historical observations are not current acceptance.
Workers and callbacks cannot invoke this operator-only reconciliation.

For a held repair assignment whose old lane has since been occupied, an operator
may supply an explicit vacant `lane` from 1 through 5. The old lane is preserved
in history; its current occupant is never changed. Omitted lane retains the old
behavior and refuses an occupied historical lane. Verifier moves, invalid lanes,
non-held assignments, occupied destination lanes and five-item global working
capacity all fail closed. Independent executing work counts toward that ceiling.
The selected lane is bound into the preview digest and chained record and checked
again under the coordinator lock during mutation, so a post-preview race cannot
steal a slot. This changes no source, action permission or acceptance requirement.

## One-time prospective execution recipe adoption

An explicit operator `executionRecipe` request may continue the exact held repair
assignment after its task-bound native PTY allocation check failed. This is not
generic terminal recovery and is never exposed to a worker or callback. Supply
the exact failed command artifact and literal recipe commands. The command must
already be executable under the frozen policy and explicitly opted into the
current canonical project's PTY recipe. No executable command, file write,
deployment or restart permission is added. Default write isolation remains on.

The latest failed task output must have an authenticated receipt, exit 1 without
timeout, one test failure containing the PTY permission denial, and unchanged
source matching the prior attested contract. Missing bindings, other statuses,
live owners, pending effects, conflicting families/lanes or five working items
refuse adoption. The entire current configuration participates in preview CAS;
revocation or drift after preview refuses mutation. The same run may adopt a
recipe only once. A subsequent failure needs its own diagnosis, not a replay.

The transaction retains the prior failed run, tasks, continuation, frozen policy,
contract and command artifact in chained history before issuing fresh fencing,
a pending current-source contract and an explicit failed-to-queued operator
transition. Attempts are never reset. Ordinary terminal transition/replay guards
remain closed. This grants no product acceptance: fresh governed task checks and
independent original-requirement verification are still required. A skipped native
fixture is not native behavior evidence even when an aggregate suite exits zero.

## New explicit human source phase after failure

An operator may bind one newly instructed source phase to the same failed held
repair run. This is separate from the old three-repair budget, which remains
consumed and unchanged. No automatic caller, callback, generic retry or worker
tool can authorize it. The immutable root-issued grant binds a direct human
instruction reference/digest, project/run/assignment/state version, owner and
intent fencing, exact changed source hash/paths, existing frozen commands,
one attempt and an expiry of at most one hour. Exact source-bound fresh passing
checks are required; source/command additions beyond the grant are rejected.
Prior effects retain the existing complete source-observation requirements.

The preview and mutation recheck the grant, source, checks, leases and ownership.
The terminal failed attempt, continuations and task attempts are sealed before
the same task is rearmed under fresh fencing and read-only actions. Original
requirements and historical contracts remain unchanged. One such phase may be
consumed per run; it neither refunds old attempts nor grants product acceptance.

## One-time current-revision verifier reassessment

`verifierReassessment.authorizationUri` is a separate operator-only mode for an
exact failed, held verifier. It cannot be combined with any repair, branch or
recipe mode. It requires a chained direct-human authorization binding the exact
run, source, project, assignment/state/intent fences, immutable candidate digest,
task snapshot, current and frozen policies, allowed commands, source hash and
four original gates. The instruction text and digest are retained; authority
expires within one hour and an explicit revocation receipt refuses admission.

Every retained source write must have one exact matching artifact and an
unambiguous canonical project identity, including absolute-path consistency.
Cross-project relative-path collisions are never resolved against the verifier
root by default. Unknown, external, deleted, uncertain or unpaired effects fail
closed. Completed reservation snapshots and existing view-only archive receipts
require explicit review; pending actions or reservations remain blockers.

Exactly one failed gate and its three never-started cancelled downstream gates
may be rearmed. Each cancellation needs an authenticated receipt naming that
failed task as its cause. The transaction seals all prior tasks, attempts,
continuations, metadata and policy, preserves the immutable candidate and frozen
requirements, and issues a supplemental current-source contract. Attempts are
never reset. All gates still require fresh evidence; historical acceptance and
view-only archival decisions grant no new acceptance or execution authority.

Only existing frozen commands may execute. Prospective PTY adoption is limited
to the canonical literal full unittest-discovery recipe, with project writes
denied and command isolation retained. Live ownership, conflicting scopes,
occupied lanes and working-capacity limits still apply. A consumed reassessment
cannot repeat, including after another failure; generic recovery is unchanged.
