# Governed Roadmap Snapshots

Agent Workflow publishes roadmap metadata from the machine that owns a registered
project checkout. Heimdall serves the retained snapshot and never reads a remote
workstation path or accepts an arbitrary path or command.

## Publication

`agentflow onboard-project --write` publishes when enterprise storage is
reachable. Every `agentflow index-project` run, including watch-mode refreshes,
also republishes. The publisher resolves only `project.roadmap_path` (or
`docs/roadmap.md`) beneath the canonical project root and rejects absolute paths,
parent traversal, and symlinks that escape the checkout. Input is capped at 1 MB;
output is capped at 500 checklist items (200 by default). Titles and section names
are bounded and local absolute paths are redacted.

The latest validated snapshot is retained in `project_index_state.metadata` under
`roadmapSnapshot`. It contains only:

- schema version and stable project ID/name
- configured project-relative source
- SHA-256 of source content
- source modification and publication timestamps
- bounded publishing hostname (never a checkout path)
- ready/empty/missing/unavailable publication state and bounded reason
- checklist totals, truncation flag, and bounded item ID/title/section/line/status

## Authenticated read contract

`GET /api/server-roadmap?projectId=<registered UUID>` requires the same configured
server bearer-token or OIDC-proxy authentication as governed server mutations.
Bearer clients send `Authorization: Bearer <AGENTFLOW_SERVER_TOKEN>`. Responses set
`Cache-Control: no-store`.

The response kind is `agentflow_server_roadmap_snapshot`. `status` is one of:

- `current`: valid snapshot published within 24 hours
- `stale`: valid snapshot older than 24 hours; last known data remains available
- `missing`: registered project has not published, its configured source is absent,
  or the publishing workstation was unavailable before any snapshot existed
- `invalid`: the project ID or retained payload fails validation

An unknown registered project ID returns 404, malformed IDs return 400, and failed
authentication returns 401. Project lookup is by immutable ID, so duplicate names
are unambiguous. The response never includes `rootUri` or another host path.

## Rollout and rollback

1. Deploy the reviewed Agent Workflow package to the Heimdall service and restart
   its dashboard/API process in an approved window.
2. Deploy the same publisher revision to machines that own registered checkouts.
3. Run `agentflow index-project --project <checkout>` on each owning machine, or
   let its existing index watcher republish after a roadmap change.
4. Read every registered project by ID through the authenticated endpoint and
   verify identity, digest, publisher, freshness, and absence of host paths.

Rollback by returning the Heimdall process and workstation publishers to the prior
package revision. Retained `roadmapSnapshot` JSON is additive and can remain in
`project_index_state`; older versions ignore it. Fleet clients should fall back to
their prior read-only status when the endpoint is unavailable, never to arbitrary
filesystem access.
