# Project Context Center

The first source slice exposes project evidence as a read-only projection over
the existing durable stores. It does not import personal assistant data or add
an approval engine, history database, receipt store, learning pipeline, or provider
metrics system. Evidence never grants authority.

## Contract and navigation

`packages/project-evidence/src/index.ts` defines schema version 1. Nodes represent
source files, explicit requirements/roadmap/decision document entries, historical
runs, artifacts, failed tasks, and participating agents. Relationships are
`contains`, `produced`, `failed`, and `participated`. Every endpoint and relationship
retains its underlying table and record key. Source entries also retain indexed
hashes and exact lines. Relationships express stored facts, not inferred
requirement satisfaction or execution dependencies.

`project-evidence --project <directory> --json` and `GET /api/project-evidence`
expose the same contract. `/studio/context` provides a filterable list and detail
view. Native Studio's Project context navigation calls the engine through its
existing CLI selection and opens source files in the editor or existing run
details. Older engines produce an unavailable state; no local graph store is
created as a fallback.

The read uses one repeatable-read, read-only PostgreSQL transaction, selecting
only the exact registered project root. Limits are 200 files, 50 runs, 200
artifacts, 500 tasks, and 2,000 extracted document entries across the selected
files. Extra database rows and the global extraction limit set `truncated`.
Document extraction reads headings and task-list items from requirement,
roadmap, and decision Markdown files, with at most 200 entries per file;
it ignores fenced code. It is structural extraction, not semantic validation.
Other requirement formats and arbitrary document filenames are not parsed yet.

Indexed sources are `unverified`; recorded run data is `historical`. Confidence
is categorical (`recorded` or `extracted`), not a fabricated probability.
Source preview independently compares current bytes with the indexed hash,
rejects symlinks and escaping/private runtime paths, limits text to 200 KB,
and escapes markup. Artifact links open their existing run evidence rather
than treating arbitrary artifact URIs as executable URLs.

## Upgrade and rollback

No new database table or SQL migration is necessary: graph entries are derived
metadata within existing `project_files` records and the graph is reconstructed
on demand. Refresh the existing project index to populate `evidenceEntries`.
Unchanged summaries reused during a full refresh also receive extracted entries.
A delta-only refresh covers only selected changed files; use a full index refresh
to backfill older records. Old readers safely ignore the new metadata. Rolling
back source leaves existing records/history intact. There are no graph mutation
endpoints in this slice.

## Acceptance evidence (2026-10-22)

- Independent combined rerun: 16 engine/indexer/HTML/source-preview/PostgreSQL
  tests passed, with no skips.
- Real PostgreSQL test passed using synthetic project records in a disposable
  schema, including cross-project isolation, absent projects, and truncation.
- Both repositories passed TypeScript checks. Studio passed 59 JavaScript tests,
  its Rust test suite, and its production frontend build. The build retains an
  existing large-chunk warning; these checks do not establish packaged acceptance.
- Playwright exercised the actual browser HTML renderer using synthetic evidence
  at 1366x900 and 390x844: page identity, list/detail, source link, filtering,
  degraded state, no page/console errors, and no mobile horizontal overflow.
  This renderer harness is not an HTTP-handler integration test.
- Studio's Vite browser preview at 1440x1000 exercised Project context opening,
  honest engine-unavailable behavior, and refresh without page errors.
- `validate-boundary` and both repository diff whitespace checks passed.
- Sidecar preparation failed before writes: `Pinned runtime contract does not
  match the Agent Workflow bundle manifest.` The pinned contract and unrelated
  dirty manifest were preserved. Native packaged success is not claimed.
- Rust formatting check still reports unrelated existing differences; formatting
  of the new condition was repaired without reformatting unrelated code.

## Remaining acceptance and next work

1. Reconcile the engine bundle and Studio pinned contract in a scoped release
   change, preserving unrelated dirty work and trust checks.
2. Rebuild and independently launch packaged Studio against that exact engine;
   verify graph retrieval, file/run navigation, restart reconstruction, empty
   state, and storage outage/recovery. First slice remains incomplete until then.
3. Add exact context influence records via existing action receipts, including
   snapshots of selected graph relations and freshness, and run-detail navigation.
4. Add attributed corrections, bounded history and deletion impact previews,
   with mutations governed by existing approvals/receipts.
5. Add unified search over authoritative stores, then the evidence-backed brief.

Contextual approval resolution, capability health, attempt journals, durable
follow-ups, I/O feeds and notification/action history remain reconciliation work
against the existing primitives. None is claimed complete by this first slice.

## Native acceptance and influence continuation (2026-10-22)

This continuation supersedes the packaging blocker in the initial evidence
above. The shared working tree's changed definitions and manifest were preserved.
A reviewed runtime snapshot starts from engine commit
`4fbbd24d8dfe21e225c37a7705c4e716f0dfe0b8` and overlays only the context graph and
influence implementation. Its original signed definition bundle remains at
`d790edefc63aa8b8cc6b524699ae39e9c4b34d77d3dd1817bad327096889f425`.
No release signing key was configured or used and no new trust grant was added.

Studio's contract now pins executable source separately with `sourceChecksum`.
`runtime-source.mjs` hashes portable application/package sources and dependency
metadata, excluding tests, installed dependencies and private runtime state.
Preparation checks that source identity, verifies the exact selected source's
bundle signature, carries the signature into the runtime, checks required
commands, and writes runtime provenance. The compiled binary digest is explicitly
before platform signing; final packaged binary hashes belong in the acceptance
receipt. An unrelated inherited `AGENTFLOW_ROOT` cannot redirect verification.
Use `AGENT_WORKFLOW_SOURCE` to select the reviewed snapshot; the dirty shared
checkout intentionally fails the pin checks. The snapshot location and file
hashes are retained in ignored local runtime storage and existing receipts.
A clean engine commit and matching CI source revision are still release work.

The macOS `.app` was rebuilt with a separate QA identifier and profile, using a
disposable PostgreSQL database and synthetic project. It passed deep/strict
ad-hoc code-sign verification. Native checks covered all eight evidence kinds,
source hash/line details, file and run navigation, index refresh, restart
reconstruction, explicit empty state, storage outage and recovery. An independent
package rebuild/relaunch reproduced the graph. The installed application and
live project services were not replaced. Notarization, hosted CI and other
platforms are not established by this local QA.

### Influence contract and APIs

`packages/project-evidence/src/influence.ts` defines schema version 1. Influence
means context supplied to compilation or prepared for a runtime invocation; it
is not proof of causal model reasoning. Hashes and references are recorded, not
a second copy of private source bodies. Execution authority always remains
`none` in this metadata.

Compilation captures included/full-source hashes for project context, indexed
summaries, exact excerpts, tuning notes, supplied preferences, agent instructions
and workflow stages. Known reuse advisories link their prior run. Unknown dates
and origins remain unknown. The compiled-brief artifact retains the metadata;
a plan receipt is appended atomically with run creation. Invalid context hashes
roll back the run. Replays retain historical attribution and link the origin
rather than claiming a fresh source read.

All existing provider-round/fallback call sites use the attribution wrapper.
Each invocation records its exact input hash and selected context before the
provider executes, then links a canonical result hash to that input receipt.
Read rounds capture the actual supplied file content hash, full source hash
when available, and truncation. Prior stage artifacts, receipts, state deltas
and memory-context strings retain hashes and available run navigation. Provider
failures retain their input receipt. Receipt-storage failures stop invocation
or fallback; provider metrics remain in the existing metrics system. Bound
executors record their prepared context and governed snapshot, with an explicit
returned event; existing approval/output receipts determine their outcome.

There is no new table or receipt engine. Existing `action_receipts`, their hash
chain, and existing artifacts persist these records. Old runs are never
retrospectively assigned influence. Graph edges are not automatically injected
into prompts: current receipts explicitly report `graphStatus: not_supplied`
and an empty relationship list, rather than claiming unrelated edges influenced
a plan. Supplied preference or memory strings without structured origin retain
an exact included hash but cannot gain invented source attribution.

Read history with `context-influence --project <directory> --run <id> --json`,
`GET /api/context-influence?project=...&run=...`, or `/studio/influence`.
Browser Studio links "Why these inputs?" from run details; native Studio adds an
Influence tab. Both show phase, hashes, freshness, provenance, missing history,
truncation and file/run navigation. Reads are project-scoped and bounded to the
first 200 receipts. The receipt chain retains further history.

### Continuation verification

- 61 focused engine/compiler/executor tests passed; an independent 15-test
  rerun included real PostgreSQL graph and influence persistence, project
  isolation, hash-chain verification and invalid-plan rollback.
- Both TypeScript checks passed. Native Studio's full JavaScript and Rust checks
  and final package outcomes are recorded in its continuation receipt.
- A real packaged mock-provider worker claimed one queued stage, completed one,
  and failed zero. It emitted its own input/result attribution. The synthetic
  run's complete receipt chain then verified at 13 receipts.
- The live HTTP API returned plan/input/result phases and excluded another
  project's records. Playwright exercised the actual server's history view,
  graph/source navigation, and 1366x900 / 390x844 rendering, with no page errors
  or horizontal overflow. This supersedes the initial renderer-only API limit.
- Packaged native Studio displayed persisted phases, expanded hashes and
  freshness, opened the referenced source, and showed an older run as
  unrecorded without leaking the newly selected run's attribution.

Next five scoped actions are attributed corrections with bounded history,
governed deletion-impact preview, unified search, the evidence-backed project
brief, and reconciliation of operational health/attempt/follow-up/activity UX
against existing stores. No push, publication or deployment occurred.

## Attributed indexed-fact corrections

`context-correction` projects the latest 20 correction receipts for an exact
project and evidence node. Earlier receipts remain in their original run chains.
The same view discovers up to 10 open correction approvals from the existing
approval store, with explicit truncation indicators.

A correction annotates an indexed requirement, roadmap item or decision. It
preserves the source title, indexed hash and location, prior displayed value,
proposed value, reason, proposer, executing actor and supporting indexed file
references. It does not rewrite source files, alter model routing or grant
execution authority. If the indexed source changes, the annotation is stale.
Corrections are currently review annotations; they are not silently injected
into compiler prompts as authoritative source replacements.

Requests use `requestActionApproval`, deterministic proposal identities and the
existing approval inbox. Recording uses the normal role and separation-of-duty
checks, execution claims, `context_correction` artifacts and chained
`context_correction_recorded` action receipts. Per-node transactional locking
and source/history/support checks reject competing or stale snapshots. A
successful retry reuses its artifact. Rejected approvals retain their normal
history and record no correction. No correction or approval database is added.

Native Studio uses its source-pinned engine for history, canonical proposal
review and explicit approval decisions. A browser-only preview cannot mutate
project context. Historical annotations and evidence remain data, never action
authority.

## Governed deletion-impact preview

`context-deletion-impact` is read-only. It projects immediate graph connections,
recorded context references across the same project's runs, historical correction
records using that source, and artifacts from those related runs. Recommendation
artifacts appear when recorded in that artifact lineage. File-derived facts use
file-granularity matching; receiving context is not proof of causal dependency.

The response includes a snapshot hash and separate bounds for the graph,
context references (200), corrections (100) and related artifacts (100). Missing
records, source drift during collection, truncated results, current disk drift,
older unrecorded context and semantic or unlinked recommendation dependencies
must not be interpreted as safe deletion. Unknowns remain explicit even when
no recorded dependent is found.

Native Studio exposes a preview and links to existing run evidence. It offers
no delete action. Preview reads neither create approvals nor append receipts,
and never remove evidence or alter audit retention. Any subsequent supported
mutation still requires the existing project policy, approval and receipt
controls against current evidence. No separate deletion authority is added.

Correction history ordering uses a per-fact revision recorded under the existing
transaction lock. Cross-run clock skew cannot promote an older correction to
current state. Timestamp, source and prior-value provenance remain retained.


## Unified project evidence search

`context-search` queries existing authoritative stores for the canonical project
root before applying the result window, including runs outside the graph's
recent-history window. Literal case-insensitive substring matching covers
indexed paths and extracted fact titles, run tasks, artifact kinds, participating
agent identifiers, failed tasks and receipt summaries. File bodies and artifact
contents are outside this search. No second search index or history store is
created. Search changes no approvals, artifacts or receipts.

Results retain source table/key, indexed hash and line where available,
freshness and confidence. They grant no execution authority. Studio supports
query/type filtering, explicit search and clear, source/run navigation, empty
results, and unavailable/retry states. The query is limited to 200 characters;
responses expose at most 100 safe results from a 501-candidate window and
disclose truncation when either window is reached. Existing path exclusions
apply to legacy indexed files. This is indexed evidence, not proof of current
disk state or feature acceptance.


## Evidence-backed project brief

`context-brief` composes the existing graph projection and recorded corrections
in one repeatable-read, read-only database snapshot. It creates no artifact,
approval, receipt or parallel history store. Context Center loads the brief on
opening and supports explicit refresh and source/run navigation.

The deterministic brief quotes indexed requirements, roadmap entries and
decisions (up to six each), plus five recent run tasks and five recorded failed
tasks. Graph input bounds also apply. Indexed facts retain source table/key,
line, hash, observation date, freshness and confidence. A matching recorded
correction retains the original indexed fact, proposer, executor, approval and
receipt references; an annotation from an older source remains separate and
does not replace the indexed statement. Complete receipt-chain and approval
decision verification is not implied by this read.

Any suggestion derived from retained failures is explicitly labeled inference
and links to supporting run evidence. The brief does not determine current
blockers, feature acceptance, owners, deadlines or priorities. It exposes
unknowns, stale annotations, missing requirements and truncation. Indexed
sources are not compared to disk. A snapshot hash identifies the retained
content, excluding generation time. The brief grants no execution authority
and does not automatically add evidence or recommendations to agent prompts.


## Contextual approval resolution

`context-approvals` reads the existing project-scoped approval store and
canonical request. Context Center exposes requested action/target, rationale,
originating work, bounded redacted payload and policy, decision/execution
actors, exact target/path and originating-run evidence, and linked approval
receipts. It creates no parallel approval, history or receipt store.

Explicit approve-only, approve-and-execute, execute-approved, reject, retry
existing approved/failed actions and dismiss-without-execution controls route
through the pinned CLI's existing approval commands. Unsupported states/actions
are not offered. No automatic retry or persistent approval rule is created.
A reviewed snapshot binds the project, request inputs, policy, status and
canonical update fields. Native preflight rejects a changed snapshot and
reloads canonical status after every decision, including a partial failure.
Existing role gates, separation of duties, policy evaluation and execution
claims remain authoritative. Evidence grants no execution authority.

Approval cards are capped at 25, related graph evidence at 10 and linked
receipts at 20. Payload/policy previews are capped at 16000/4000 characters;
secret-named JSON fields and secret-shaped card values are redacted. Bounded
request inputs disable inline decisions and defer to the existing full inbox.
Relationships are exact matches within the graph window, not causal inference.
Receipt links do not imply independent verification of a full chain. Approval,
execution and feature acceptance remain distinct. Other Context Center
projections retain their snapshot until explicitly refreshed.


## Capability health

`context-health` composes read-only observations from the existing project
configuration loader, graph projection, canonical approval counts and latest
20 matching action receipts. Project storage reads use a repeatable-read,
read-only transaction with a five-second statement timeout. Existing service
checks probe configured endpoint TCP reachability with bounded timeouts;
endpoint addresses and raw connection errors are not returned. No health
history, approval or receipt store is created.

Native Context Center separately reads existing runtime discovery and Studio
capability state. Discovery, recorded Studio grants, project constraints,
storage query results, transport reachability and historical outcomes are
distinct observations. None establishes OS permission, workflow execution or
feature acceptance. Configuration uses the existing loader, including trusted
command rules where configured. Provider authentication and paid inference
are not probed. Refresh does not repair, retry, grant access or change policy.

Failed checks do not erase independent observations: unavailable schema reads
remain unavailable even when TCP is reachable; invalid configuration does not
turn available database evidence into a failed connection. Unknowns are
explicit. Old snapshots clear while refreshing, and late health responses are
invalidated when the workspace is destroyed.

The UI provides explicit refresh, expandable recorded outcomes and receipt
provenance, project-scoped run navigation, and bounded-history notices. Pending
approvals and historical failures do not establish a current blocker. Indexed
hashes are not compared with disk; receipt chains are not independently
verified by this health read. The view grants no execution authority.

## Attempt journals

`context-attempts` projects existing task counters and hash-linked action receipts
in one project-scoped, repeatable, read-only database snapshot. Native Studio
invokes the source-pinned engine and rejects mismatched project or authority
contracts. No journal table, approval, retry, worker action or alternate history
store is created.

The latest 25 tasks retain up to 20 explicitly matching receipts each. Each
model route retains its first 10 recorded provider entries. Separate truncation
notices explain each bound. Task counters count leases; provider attempts remain
separate and are never assigned to a particular lease by timestamp inference.
Canonical task state and lease generation are shown alongside historical receipt
outcomes, timestamps, identities and hashes. Legacy counters without receipts
are explicitly incomplete. No receipts does not mean no prior execution.

Only exact task targets or model-route stage identities in the same run are
included. Provider diagnostics and arbitrary metadata are excluded; selected
labels and summaries are bounded, redacted and escaped in Studio. Replacement
runs and copied checkpoints are not reconstructed as retries. Receipt chains
and feature acceptance remain unverified by the view itself. Existing approval
and execution controls retain authority; this surface offers only refresh,
progressive disclosure and normal run navigation. Open disclosure state survives
background renders and is pruned to retained task identities.

Storage failures remove the prior snapshot and show an actionable unavailable
state. Refresh can recover without creating approvals or replaying work. The
five-second statement timeout bounds database queries. Full history export,
per-lease reconstruction and automatic retry remain outside this contract.

## Durable follow-ups

`context-followups` reconciles explicit run continuation links and persisted
stage handoffs into Context Center. It reuses `workflow_runs` replacement links,
`sourceRunId` and `replayOfRunId` metadata, `workflow_handoffs`, handoff events and
receipt links, canonical action approvals and existing hash-linked receipts.
No follow-up store, timer, scheduler, reminder or approval engine is created.

A project-scoped, repeatable-read, read-only snapshot retains the latest 25 run
relationships and 25 handoffs. Each handoff retains its latest 10 events and 10
explicitly linked receipts. Separate notices identify each truncated window.
The native bridge uses the source-pinned engine, validates project and authority,
and fails closed on failed commands, malformed responses or output exceeding one
megabyte. Database statements have a five-second timeout.

Both ends of a run relationship must belong to the selected project before a
navigation button is exposed. Missing, malformed and foreign references remain
unavailable without leaking the foreign identity or task. Self-links and cycles
are displayed as recorded relationships and never traversed. Dates and task
wording cannot invent lineage. Linked handoff receipts and events must match
the exact handoff and run. Selected labels, summaries and notes are bounded,
redacted and escaped; arbitrary metadata and artifact contents are excluded.

Canonical run and handoff states remain separate. A historical source failure
is not rewritten by a completed follow-up. A completed handoff is not feature
acceptance, and a proposed handoff may be generated from a workflow definition
without establishing a human commitment or scheduled reminder. Recorded sender
and receiver agents do not establish ownership outside that handoff. Approval
counts reuse existing run approvals; existing run controls retain all decision
and execution authority. The view offers refresh, disclosure and run navigation.

Missing events or receipts remain explicit history gaps. This read does not
verify complete receipt chains or authorize recovery. Refresh clears stale
snapshots; a failed read shows an unavailable state without resuming work.
Late responses are invalidated on workspace destruction. Disclosure state
survives background rendering and refresh and is pruned to retained identities.

Collapsed continuation rows include the recorded follow-up task title alongside
relationship type and both statuses, so different runs remain distinguishable
before disclosure. Full run identity and provenance remain inside the row.

Follow-up navigation carries the selected run's recorded task, workflow and state
from this project-scoped snapshot into the existing run view. A run outside the
recent-history window therefore retains its own header and evidence. The view
keeps at most 20 other recent entries plus the selected run; arbitrary or foreign
identities absent from the snapshot cannot supply this navigation state.


## Project I/O feed

The read-only `context-io --project <dir> --kind all|inputs|outputs|commands
--json` projection uses existing action receipts. Studio invokes its pinned
packaged engine and exposes the feed in Project Context. No new history store,
worker, scheduler or action authority is introduced.

The selected category is filtered before the latest-50 receipt window. Reads,
writes, rejections and historical evidence reuse remain distinct. Command
results distinguish nonzero exit, timeout and missing outcome; a zero exit or
completed run is not feature acceptance. Recorded byte counts and content hashes
are optional evidence. Task attribution requires an explicit task ID in the same
run; it is never inferred from agent names or time proximity.

Only bounded scalar receipt fields are selected. Source bodies, content previews,
command text, stdout, stderr, raw summaries and arbitrary metadata are excluded.
Unsafe or private file paths are withheld. Historical paths are not compared
with current disk contents and do not expose a file-open action. Receipt hashes
are references; the view does not independently verify complete chains.

Run navigation uses the same-project snapshot's task, workflow and canonical
status, including runs outside recent history. Refresh clears stale evidence;
storage failure reports unavailable without replay. Retained disclosure state
survives background rendering and refresh. Native responses are limited to one
megabyte, storage statements to five seconds, and late workspace responses are
invalidated. Notification history and broader action-history reconciliation
remain separate work.


## Notification history

The read-only `context-notifications --project <dir> --status <state> --json`
projection reads the existing run notification outbox. The native Context Center
uses its pinned engine. States are `all`, `pending`, `delivered`, `failed`,
`delivery_uncertain` and `coalesced`; filtering precedes the latest-50 bound.
Ordering is by creation time, not last delivery update. This is current recorded
outbox history, not a complete transition log or live dispatcher-health probe.

Delivery status, transport start/acceptance, delivered time and arrival
acknowledgment remain separate observations. Missing acknowledgment does not
prove non-arrival. None establishes human review, action approval or feature
acceptance. Optional attempts, availability, origin-binding presence and active
claim expiry help explain recorded delivery state without exposing credentials.
Coalesced replacement identities require the same project, channel and origin
binding. Missing or foreign targets remain unknown. Coalescing does not retract
messages already delivered.

Receipt references require an exact same-run event-key/hash match; full chains
are not verified by this view. Legacy transport and coalescing fields may be
absent and remain unrecorded. No schema migration or parallel history store is
introduced. Titles and run goals are bounded/redacted; bodies, raw event keys,
origin task IDs, transport message IDs and claim credentials are excluded.

Navigation carries the snapshot's originating run title, workflow and canonical
status even outside recent history. Refresh clears stale rows; failures report
unavailable without replay. Disclosure state survives refresh/background render
and is pruned to retained identities. Destroyed workspaces discard late results.
Storage reads are read-only repeatable snapshots with a five-second statement
limit; native responses are capped at one megabyte. The history cannot claim,
dispatch, retry, acknowledge, coalesce or resolve approvals. Broader action
history remains separate reconciliation work.


## Action-history reconciliation

`context-actions --project <dir> --kind all|approvals|receipts --json` is a
read-only projection of existing approval records and action receipts. Native
Studio invokes the pinned runtime. The category is filtered before the latest-50
bound. Approval records sort by last update; receipts sort by recorded creation.
Equal timestamps do not establish causal order. This is a bounded snapshot,
not a complete transition log or an additional action-history store.

Canonical approval state at read time stays separate from earlier receipt
events. An approved request is not execution; executed bookkeeping and an
execution receipt are not feature acceptance. Dismissal does not erase earlier
failures or receipts. Unlinked events do not establish whether approval was
required or granted. Targets, timestamps and agent names never infer permission.

Links require explicit approval identity in the same run. Each approval shows
its latest 10 matching receipts, with truncation disclosed. Exact same-run
`action_approval_executed` receipt presence is checked across retained storage,
even outside that window. Absence is unrecorded evidence, not proof that no
action occurred. Same-run explicit task identities retain task/stage attribution;
missing, malformed or foreign identities stay unknown. Full chains are not
verified by this read.

Only bounded scalar provenance is exposed. Payloads, action targets, summaries,
actor identities, decision notes, credentials and arbitrary metadata are omitted.
The history cannot approve, execute, retry, dismiss, delete or repair records.
Existing approval review remains the only linked review surface, with its existing
policy and snapshot checks. Approval decisions refresh this read-only history.
Run links carry canonical title/workflow/status for older runs outside recent
history. Failed refresh clears stale evidence; retained disclosure state survives
render/refresh, and destroyed workspaces discard late responses. Reads use a
repeatable read-only snapshot, a five-second statement timeout and a one-megabyte
native response cap.

Context-pane scroll is retained during background rendering. Existing review
links focus the exact canonical request so long history does not obscure it.
