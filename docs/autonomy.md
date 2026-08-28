# Autonomy Policy

Autonomy is explicit and project-scoped.

| Level | Meaning |
| --- | --- |
| 0 | Advisory only |
| 1 | Draft artifacts |
| 2 | Edit local files |
| 3 | Run local commands and tests |
| 4 | Update external systems with approval |
| 5 | Trusted scheduled automation |
| wide-open | All configured local and external actions are allowed |

`wide-open` is intended for owners who want maximum automation. It should still write receipts for every action. Shared projects can disable it by setting `allow_wide_open: false`.

## Execution policy profiles

Execution policy profiles describe how cautiously Agent Workflow may operate
against a target environment. They do not select or isolate Agent Workflow's
Postgres, Redis, or object storage.

Three profiles are built in:

| Profile | Behavior |
| --- | --- |
| `local` | Preserve the project's configured autonomy, commands, and write paths. |
| `staging` | Cap autonomy at 2, disable wide-open operation, and require approvals and receipts. |
| `production` | Cap autonomy at 1 and disable commands and file writes. |

Projects select a default in `.agent-workflow/project.yaml`:

```yaml
execution:
  policy_profile: local
  policy_profiles: {}
```

Use `--policy-profile staging` or `--policy-profile production` on `compile`,
`run`, `run-and-watch`, or `agent-task` to override the project default for one
operation. A project can define a named override under `policy_profiles`; a
project-defined profile takes precedence over a built-in profile of the same
name.

Each enterprise workflow run stores the selected profile, the fully resolved
policy snapshot, and a SHA-256 snapshot hash. Workers execute against that
immutable snapshot, so later edits to project configuration do not change the
policy of an already queued run.

Projects can add narrowly scoped `actions.approval_rules` for recurring
low-risk local commands or file writes. Approval rules do not expand policy:
the action must still pass allowed and blocked command/path checks first. A
matching `auto_execute` rule lets the worker execute the action immediately
while preserving normal receipts and artifacts.

Storage isolation remains an optional deployment concern. Teams that require
separate infrastructure for production can run a separate Agent Workflow
deployment, but the policy-profile feature does not require it.
