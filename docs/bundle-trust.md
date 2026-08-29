# Signed And Trusted Workflow Bundles

Agent Workflow verifies bundle integrity, origin, compatibility, and signer trust independently from project execution permission. A valid signature proves which key signed an unchanged manifest; it does not grant commands, writes, network access, or wide-open autonomy.

## Verify

```bash
agentflow bundle-verify
agentflow bundle-verify --policy require --json
```

Check compatibility and migration notes without signer policy:

```bash
agentflow bundle-compat
agentflow bundle-compat --runtime-version 0.2.1 --node-version 26.3.0 --mcp-version 1.29.0 --json
```

Inspect the local trusted bundle registry:

```bash
agentflow bundle-registry
agentflow bundle-registry --json
agentflow bundle-registry --registry /path/to/bundles.json
```

The default registry lives at `registries/bundles.json`. Registry entries are
discovery and governance metadata: bundle id, source, package name, latest
known version, signer fingerprints, install commands, and notes. They do not
install code, change project adoption state, or trust a signer automatically.

Preview migration notes for a project or an explicit source version without
changing files:

```bash
agentflow bundle-upgrade-preview --project /path/to/project
agentflow bundle-upgrade-preview --from-version 0.1.0 --from-checksum <sha256>
```

For concrete definition contract changes, upgrade steps, validation commands,
and rollback guidance, run:

```bash
agentflow definition-migrations --project /path/to/project
```

After reviewing compatibility, trust, and migration notes, record the current
bundle as the project baseline:

```bash
agentflow bundle-adopt --project /path/to/project --force
```

When present, project state is read from
`.agent-workflow/bundle-state.json`. `init-project` and `onboard-project --write`
create this file during adoption:

```json
{
  "schemaVersion": 1,
  "bundle": {
    "id": "agent-workflow-core",
    "version": "0.2.1",
    "checksum": "sha256...",
    "recordedAt": "2026-08-29T00:00:00.000Z"
  }
}
```

Statuses are `trusted`, `valid-untrusted`, `unsigned`, `modified`, `expired`, `incompatible`, and `invalid`. Trust policies are:

- `allow`: unsigned and valid-untrusted bundles may run; modified, invalid, or incompatible bundles are rejected.
- `warn`: the same execution boundary, with warnings for anything not trusted.
- `require`: only a valid signature from a trusted public key is allowed.

Set the default with `AGENTFLOW_BUNDLE_TRUST_POLICY=allow|warn|require`.

During local development, a detached signature from an older manifest checksum is
treated as `unsigned` rather than trusted. The default `allow` policy can run
that local checkout, while `require` and the release checker still block until a
maintainer signs the refreshed manifest.

## Sign

Keep private keys outside the repository and Agent Workflow configuration:

```bash
openssl genpkey -algorithm Ed25519 -out release-private.pem
openssl pkey -in release-private.pem -pubout -out release-public.pem
agentflow bundle-sign --private-key /secure/release-private.pem --signer release@example.com
```

This writes the detached `agent-workflow.bundle.sig.json`. Optional `--expires-at` is included in the signed payload, so expiration metadata cannot be changed without invalidating the signature.

## Trust a signer

```bash
agentflow bundle-trust --public-key release-public.pem --signer release@example.com
agentflow bundle-trust
agentflow bundle-trust --remove <sha256-fingerprint>
```

The trust store contains public keys only at `~/.config/agent-workflow/trusted-bundle-keys.json` by default. Override it with `AGENTFLOW_BUNDLE_TRUST_STORE` for managed environments.

The dashboard exposes `/bundles`, `/api/bundles`, and `/api/bundle-registry`.
Add `?project=/path/to/project` to include project adoption state, upgrade
status, definition migration guidance, registry status, and mock-provider
contract-test readiness. MCP exposes `agentflow_bundle_verify`,
`agentflow_bundle_compat`, `agentflow_bundle_upgrade_preview`, and
`agentflow_bundle_adopt`; trust-store mutations remain explicit CLI actions.
