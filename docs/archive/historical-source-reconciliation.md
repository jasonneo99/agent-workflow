# Historical source observations for an existing assignment

The operator-only source-repair attestation can optionally acknowledge an exact
set of historical source-write receipt hashes and artifact URIs. Every receipt
must be paired with one identical finalized file-write artifact, and every path
must be covered by the freshly verified source manifest and live scoped intent.
Unknown, unpaired, extra, changed, deleted, external, or separately reserved
effects remain refused. Pending approvals remain refused.

This observes historical writes; it does not prove their historical preimages,
authorize replay, or establish original product acceptance. The full immutable
history remains intact. The preview and final reconciliation recheck the exact
evidence set and current source commitment. New evidence invalidates the preview.
The original requirements and attempt budget remain, the assignment receives a
fresh fence, and continuation actions remain read-only under the frozen command
policy. There is no worker-facing self-approval tool or automatic opt-in.
