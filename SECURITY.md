# Security Policy

Agent Workflow is a local-first automation framework for developer workflows. It can read project files, queue agent stages, call configured model providers, and request local commands or file writes under project policy.

Security work in this repository should strengthen the shared framework without importing private product logic or customer context.

Please report security issues privately. Do not open a public issue for an unpatched vulnerability.

## Reporting A Vulnerability

Use the repository's private security-advisory reporting channel with:

- a short description of the issue
- affected version, commit, or install method
- reproduction steps or proof of concept
- expected impact
- any logs or exports, scrubbed of secrets and private project data

You should receive an initial response within 7 days. The expected handling flow is confirmation, fix planning, patch release when needed, and public disclosure after users have a reasonable upgrade path.

## Scope

In scope:

- command execution policy bypasses
- file write policy bypasses
- secret leakage through logs, exports, dashboard views, MCP responses, or artifacts
- unsafe provider configuration handling
- bundle trust or signature verification weaknesses
- cross-project context leakage
- dashboard or MCP vulnerabilities that affect local project data
- dependency vulnerabilities with a practical exploit path in Agent Workflow

Out of scope:

- vulnerabilities in private projects using Agent Workflow
- issues that require already having full local machine access
- model quality failures without a security impact
- prompt injection reports that do not bypass an Agent Workflow policy or leak protected data
- denial-of-service reports against intentionally local developer-only services without data exposure

## Safe Testing

Use a throwaway test project when possible. Do not test against private repositories, production credentials, customer data, or third-party systems without authorization.

Do not include API keys, `.env` files, private prompts, compiled briefs, raw command output, tenant details, customer data, or product-specific task text in reports. Use scrubbed exports:

```bash
npm run export-run -- --run <run-id> --scrub
npm run validate-examples
```

## Security Design Principles

Agent Workflow should preserve these boundaries:

- project-specific context stays in the target project
- reusable agents and workflows stay provider-neutral
- risky commands and file writes pass project policy before execution
- approval-required command and file-write requests are stored as pending inbox items instead of running immediately
- approval decisions create audit receipts and do not bypass project command or write allowlists
- meaningful automation actions produce receipts
- secrets are never printed, exported, or committed
- mock mode remains available for deterministic validation
- live provider use is explicit and visible
- scrubbed reports remove private project details before sharing
- signed bundle metadata can be verified before distribution

Before security-sensitive changes, review:

- [Autonomy Policy](docs/autonomy.md)
- [Open Source Boundary](docs/open-source-boundary.md)
- [Bundle Trust](docs/bundle-trust.md)
- [Contributing](CONTRIBUTING.md)

## Maintainer Release Checks

Before publishing a release, maintainers should run:

```bash
npm run check
npm run release:check -- --allow-current-version
```

For packaging-only verification:

```bash
npm run pack:check
```
