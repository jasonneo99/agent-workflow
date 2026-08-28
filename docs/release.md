# Release Guide

This guide separates contributor checks from maintainer-only publishing. Releases are explicit, signed, and published through GitHub Actions Trusted Publishing.

## Contributor Checks

Contributors can verify a checkout without release credentials:

```bash
npm run release:check -- --allow-current-version
```

For faster local iteration:

```bash
npm run release:check -- --allow-current-version --skip-tests
```

This command is read-only. It checks repository state, bundle metadata, package contents, Trusted Publisher workflow setup, npm published-version readiness, local npm auth status, and the normal validation commands.

## Maintainer Release Prep

Maintainers prepare a release locally because the bundle signature requires a private signing key. Do not commit private keys, npm tokens, generated `.env` files, or machine-specific release paths.

```bash
AGENTFLOW_RELEASE_SIGNING_KEY=/secure/release-private.pem \
AGENTFLOW_RELEASE_SIGNER=release@example.com \
  npm run release:prepare
```

`release:prepare` defaults to a patch bump. It updates package metadata, refreshes the bundle manifest, signs the bundle, and runs validation.

Use an explicit bump when needed:

```bash
npm run release:prepare -- minor --signing-key /secure/release-private.pem --signer release@example.com
npm run release:prepare -- 1.2.3 --signing-key /secure/release-private.pem --signer release@example.com
```

Preview the plan without credentials or file changes:

```bash
npm run release:prepare -- --dry-run
```

After release prep succeeds:

```bash
git add package.json package-lock.json agent-workflow.bundle.json agent-workflow.bundle.sig.json
git commit -m "Prepare vX.Y.Z package release"
git push origin master
```

## Trusted Publishing

The npm package uses GitHub Actions Trusted Publishing, so GitHub receives a short-lived OIDC token instead of storing a long-lived npm token.

Configure npm package settings with:

```text
Publisher: GitHub Actions
Organization or user: jasonneo99
Repository: agent-workflow
Workflow filename: publish.yml
Environment name: npm-publish
Allowed actions: Allow npm publish
```

Then run the `Publish Package` workflow from GitHub Actions.

## Release Boundaries

Keep release machinery lightweight and auditable:

- Do not store private signing keys in this repository.
- Do not store npm tokens in this repository.
- Do not add maintainer-specific local paths to docs or scripts.
- Do not publish from contributor forks.
- Do not publish a package version that is already on npm.
- Do not publish unsigned or stale-signed bundle metadata.

Package consumers should receive the runtime, agent/workflow definitions, templates, and docs. Maintainer helper scripts can live in the source repository without becoming part of the installed runtime surface.
