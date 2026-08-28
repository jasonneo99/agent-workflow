# Security Policy

Agent Workflow is a local-first automation framework for developer workflows. It can read project files, queue agent stages, call configured model providers, and request local commands or file writes under project policy.

Please report security issues privately. Do not open a public issue for an unpatched vulnerability.

## Reporting A Vulnerability

Email the maintainer at jasonneo99@gmail.com with:

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

Do not include API keys, `.env` files, private prompts, compiled briefs, raw command output, or customer data in reports. Use scrubbed exports:

```bash
npm run export-run -- --run <run-id> --scrub
```

## Security Design Principles

Agent Workflow should preserve these boundaries:

- project-specific context stays in the target project
- reusable agents and workflows stay provider-neutral
- risky commands and file writes require policy checks and receipts
- secrets are never printed or exported
- mock mode remains available for deterministic validation
- live provider use is explicit and visible
- scrubbed reports remove private project details before sharing

For more detail, see [docs/SECURITY.md](docs/SECURITY.md), [docs/autonomy.md](docs/autonomy.md), and [docs/open-source-boundary.md](docs/open-source-boundary.md).
