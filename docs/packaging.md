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
npm run release:check -- --allow-current-version
```

`pack:check` verifies the dry-run package contents and executes the compiled CLI against the packaged runtime layout. The `prepack` lifecycle rebuilds JavaScript before creating a package.

`release:check` is read-only. It verifies repository cleanliness and sync, bundle manifest/signature consistency, Trusted Publisher workflow configuration, package contents, npm published-version readiness, local npm auth status, and the standard validation/test commands. Use `--allow-current-version` when checking a post-release checkout where the local package version is already published. Use `--allow-dirty` only when testing the checker while editing.

Publishing changes external registry state and remains an explicit release step. Before `npm publish`, update the version, run repository validation and package verification, inspect the dry-run contents, and confirm npm authentication and package ownership.

See [Release Guide](release.md) for contributor-safe checks, maintainer signing, and Trusted Publishing.
