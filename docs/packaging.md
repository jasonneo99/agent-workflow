# Package And Install

Agent Workflow is prepared as the public npm package `@jasonneo99/agent-workflow` and requires Node.js 24 or newer. Publishing is intentionally separate from building or pushing source.

## Install

```bash
npm install --global @jasonneo99/agent-workflow
agentflow-setup
agentflow doctor
agentflow ide-onboard --project /path/to/project --write --check
```

The package installs `agentflow` for CLI/dashboard/worker commands, `agentflow-mcp` for stdio MCP clients, and `agentflow-setup` for interactive provider setup.

The package also includes the documentation site content under `docs/`, including dashboard screenshots used by the README and user guide.

Installed-package setup writes provider configuration to `~/.config/agent-workflow/.env`. Clone-based development continues using the repository `.env`. Set `AGENTFLOW_ENV_FILE` or add `.agent-workflow/.env` in the current project to select another configuration explicitly.

## Verify a release package

```bash
npm run build
npm run pack:check
```

`pack:check` verifies the dry-run package contents and executes the compiled CLI against the packaged runtime layout. The `prepack` lifecycle rebuilds JavaScript before creating a package.

Publishing changes external registry state and remains an explicit release step. Before `npm publish`, update the version, run repository validation and package verification, inspect the dry-run contents, and confirm npm authentication and package ownership.

## Trusted Publisher

Use npm Trusted Publishing to publish from GitHub Actions without storing an npm token.

In the npm package settings, configure:

```text
Publisher: GitHub Actions
Organization or user: jasonneo99
Repository: agent-workflow
Workflow filename: publish.yml
Environment name: npm-publish
Allowed actions: Allow npm publish
```

The workflow must exist at `.github/workflows/publish.yml`. It uses `id-token: write` so npm can verify the GitHub Actions OIDC identity. The release bundle still needs to be signed before publishing:

```bash
npm version patch --no-git-tag-version
npm run bundle-manifest -- --write
npm run agentflow -- bundle-sign --private-key /Users/jasonmiller/.local/share/agent-workflow-release/signing-ed25519-private.pem --signer jasonneo99-release
npm run validate
npm run pack:check
git add package.json package-lock.json agent-workflow.bundle.json agent-workflow.bundle.sig.json
git commit -m "Prepare vX.Y.Z package release"
git push origin master
```

Then run the `Publish Package` workflow from GitHub Actions.
