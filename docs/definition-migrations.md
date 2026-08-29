# Definition Migrations

Definition migrations describe changes to reusable agent and workflow contracts.
They are read-only guidance: Agent Workflow does not rewrite project files from
this catalog.

## Preview

Use a project baseline:

```bash
agentflow definition-migrations --project /path/to/project
```

Use an explicit source version:

```bash
agentflow definition-migrations --from-version 0.2.0 --from-checksum <sha256>
```

The report includes:

- definition changes
- upgrade steps
- rollback steps
- validation commands

## Catalog

Migration guidance lives in:

```text
migrations/definition-migrations.yaml
```

Add a catalog entry whenever a reusable agent, workflow, project config, or
schedule contract changes in a way that users should review during adoption.

Each entry should include:

- `id`: stable migration id
- `from`: source bundle version or range
- `to`: target bundle version
- `summary`: short human-readable reason
- `definition_changes`: changed contract expectations
- `upgrade_steps`: commands or edits to adopt the change
- `rollback_steps`: how to return to the previous baseline
- `validation`: commands to run before adopting

## Safe Adoption

Recommended sequence:

```bash
agentflow bundle-compat
agentflow bundle-upgrade-preview --project /path/to/project
agentflow definition-migrations --project /path/to/project
agentflow validate
agentflow workflow-graph --workflow review-pr --project /path/to/project
agentflow bundle-adopt --project /path/to/project --force
```

Keep project-specific migrations in the target project. Keep only reusable,
non-proprietary contract guidance in this open-source catalog.
