# Signed And Trusted Workflow Bundles

Agent Workflow verifies bundle integrity, origin, compatibility, and signer trust independently from project execution permission. A valid signature proves which key signed an unchanged manifest; it does not grant commands, writes, network access, or wide-open autonomy.

## Verify

```bash
agentflow bundle-verify
agentflow bundle-verify --policy require --json
```

Statuses are `trusted`, `valid-untrusted`, `unsigned`, `modified`, `expired`, `incompatible`, and `invalid`. Trust policies are:

- `allow`: unsigned and valid-untrusted bundles may run; modified, invalid, or incompatible bundles are rejected.
- `warn`: the same execution boundary, with warnings for anything not trusted.
- `require`: only a valid signature from a trusted public key is allowed.

Set the default with `AGENTFLOW_BUNDLE_TRUST_POLICY=allow|warn|require`.

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

The dashboard exposes `/bundles` and `/api/bundles`. MCP exposes read-only `agentflow_bundle_verify`; trust-store mutations remain explicit CLI actions.
