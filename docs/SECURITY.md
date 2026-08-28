# Security Guidelines

Agent Workflow is a local-first developer automation framework. It can inspect project files, compile context, call model providers, queue workflow stages, expose MCP tools, and request local commands or file writes under project policy.

Security work in this repository should strengthen the shared framework without importing private product logic or customer context.

## Reporting Vulnerabilities

Please report vulnerabilities privately by emailing jasonneo99@gmail.com.

Do not open a public issue for an unpatched vulnerability. Include the affected version or commit, reproduction steps, expected impact, and any scrubbed logs or exports that help reproduce the issue.

Expected response:

- initial acknowledgement within 7 days
- confirmation or clarification after reproduction
- coordinated fix planning for accepted reports
- patch release when needed
- public disclosure after users have a reasonable upgrade path

## What To Report

Good security reports include issues such as:

- command execution policy bypasses
- file write policy bypasses
- secret leakage through logs, exports, dashboard views, MCP responses, or artifacts
- unsafe provider configuration handling
- bundle trust or signature verification weaknesses
- cross-project context leakage
- dashboard or MCP vulnerabilities that expose local project data
- dependency vulnerabilities with a practical exploit path in Agent Workflow

Usually out of scope:

- vulnerabilities in private projects that use Agent Workflow
- issues that require already having unrestricted local machine access
- model quality failures without a security impact
- prompt injection reports that do not bypass an Agent Workflow policy or leak protected data
- denial-of-service reports against intentionally local developer-only services without data exposure

## Safe Reproduction

Use a throwaway test project when possible. Do not test against private repositories, production credentials, customer data, or third-party systems without authorization.

Do not include secrets, `.env` files, private prompts, compiled briefs, raw command output, tenant details, customer details, or product-specific task text in a public report.

Use scrubbed exports for sharing:

```bash
npm run export-run -- --run <run-id> --scrub
npm run validate-examples
```

## Security Practices

Agent Workflow should keep these guarantees easy to inspect and test:

- project-specific context stays in the target project
- reusable agents and workflows remain provider-neutral
- risky commands and file writes pass project policy before execution
- approval-required command and file-write requests are stored as pending inbox items instead of running immediately
- approval decisions create audit receipts and do not bypass project command or write allowlists
- meaningful automation actions produce receipts
- live provider use is explicit and visible
- secrets are never printed, exported, or committed
- scrubbed exports remove private project details before public sharing
- signed bundle metadata can be verified before distribution

Before security-sensitive changes, review:

- [Autonomy Policy](autonomy.md)
- [Open Source Boundary](open-source-boundary.md)
- [Bundle Trust](bundle-trust.md)
- [Contributing](../CONTRIBUTING.md)

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
