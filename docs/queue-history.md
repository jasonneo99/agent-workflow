# Withdrawing unsuccessful runs

An explicit human request can remove an unsuccessful run from active queue
views without accepting it or changing its terminal status. Its tasks,
contracts, approvals, artifacts and receipts remain available in history.

The withdrawal API requires the exact project, run, task digest, confirmation,
and a fresh intent scoped to `runtime/withdrawals/<run-id>`. It rejects active
tasks, approvals, reservations and unresolved effects.

Chat-created runs remain bound to their original chat. CLI and scheduled runs
may instead use an operator session and the digest of their actual requester,
requester channel and evaluation metadata. The source origin stays unchanged;
an operator session is not recorded as the run's originating chat. Queue
membership checks the retained origin snapshot before honoring the receipt.

The dashboard's **Archive from active views** action fetches this binding from
the canonical run before invoking the same fenced API. A callback or copied
session identifier is not a human instruction and cannot authorize withdrawal,
execution, replay or acceptance.
