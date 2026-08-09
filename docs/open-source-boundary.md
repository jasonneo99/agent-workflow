# Open Source Boundary

Agent Workflow is an open framework for running portable development agents across projects. It should share the reusable operating system around agents, not private product intelligence from any one application.

## What Belongs In This Repository

The open source project can include patterns that help any team operate agent workflows safely and cheaply:

- Portable agent and workflow definitions.
- Project-local context files such as `AGENTS.md` and `.agent-workflow/`.
- Context indexing, source summaries, compiled briefs, and token-budget controls.
- Model-provider abstraction for BYO, OpenAI-compatible gateways, OpenAI, Bedrock, Kiro, and mock mode.
- Adaptive routing patterns based on feedback, quality, fallback, latency, and cost.
- Receipts, artifacts, exports, dashboards, and MCP tools for observability.
- Safety boundaries such as command allowlists, writable path allowlists, secret protection, dry-run defaults, and explicit write flags.
- Generic developer workflow agents for architecture, implementation, testing, frontend, UX, security, docs, release readiness, and project maintenance.
- Documentation about how to evaluate, personalize, and improve agent workflows without coupling them to a private product domain.

## What Should Stay Project-Local Or Private

Product-specific agent engines should keep their private intelligence outside the open source framework:

- Proprietary prompts, ranking formulas, scoring heuristics, or routing policies.
- Domain ontologies, business rules, customer workflows, and product-specific decision logic.
- Private schemas, tenant logic, authorization rules, deployment assumptions, and operational runbooks.
- Training data, customer-derived examples, private feedback, or production incidents.
- Product-specific agents whose value depends on non-public context.
- Any generated tuning overlay that reveals private project behavior, priorities, users, customers, or architecture.

## How To Share Learnings Safely

When a private project teaches us something useful, generalize the lesson before contributing it here:

- Share the pattern, not the private example.
- Use neutral names such as `media-platform`, `commerce-site`, or `example-project` instead of customer or product details.
- Convert private prompts into generic agent contracts and output requirements.
- Replace product-specific scores with observable categories such as quality, fallback rate, latency, cost tier, and feedback rating.
- Keep screenshots, logs, exports, and tuning overlays out of commits unless they are scrubbed examples.
- Prefer docs that explain the boundary, workflow, or safety pattern over docs that reveal product implementation details.

## Relationship To Product Agent Engines

Agent Workflow can power a product agent engine, but it should not become that product engine.

The framework owns:

- Agent execution.
- Workflow orchestration.
- Context compilation.
- Provider routing.
- Feedback memory.
- Observability.
- Safety enforcement.

A product engine owns:

- Domain goals.
- Product-specific decisions.
- Private data access.
- Customer-specific context.
- Competitive heuristics.
- Production automation policy.

This boundary lets Agent Workflow improve as a reusable developer tool while private products keep their actual moat private.

## Contribution Checklist

Before contributing a change, ask:

- Would this help a team that has never seen the private project?
- Can the behavior be explained without private schemas, data, prompts, or business logic?
- Are examples synthetic or scrubbed?
- Does the change keep project-specific context in `.agent-workflow/` or another project-local location?
- Does it preserve dry-run or explicit-approval behavior for risky actions?

If the answer is unclear, keep the change project-local first and promote only the generalized pattern later.
