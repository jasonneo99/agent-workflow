---
name: agent-workflow
description: Use when the user wants Codex to run, coordinate, automate, onboard, or inspect Agent Workflow agents and workflows in the current or another local project, or use Agent Workflow Studio as the companion workflow UI.
---

# Agent Workflow for Codex projects

Use the connected Agent Workflow MCP tools as the governed execution layer for
software-project work. The Codex task is the conversational control surface;
Agent Workflow owns reusable agents, workflow runs, policy checks, approvals,
receipts, artifacts, and project-local context.

## Select the target project

1. Resolve the project from the active Codex workspace unless the user names a
   different local project.
2. Check for `AGENTS.md` and `.agent-workflow/project.yaml`.
3. If configuration is missing, preview onboarding first. Write onboarding only
   when the user asked to set up or onboard that project.
4. Keep project facts in that project's `AGENTS.md` and `.agent-workflow/`
   directory. Do not copy private context into this plugin or the shared Agent
   Workflow repository.

## Choose the narrowest operation

- Use a named specialist task for one specialist such as the UX reviewer,
  security reviewer, frontend engineer, or test engineer.
- Use a preset when the user names an established preset.
- Use orchestration for a broad goal that needs routing across specialists.
- Use run-and-watch for a complete multi-stage workflow that should finish in
  the current Codex task.
- Use indexing before substantial runs when project context is missing or stale.
- Use status, artifacts, export, and summary tools to report evidence instead of
  duplicating workflow work in Codex.

Treat terminal Agent Workflow results as authoritative. When a run completes,
report its result and evidence. When it blocks on approval or user input,
present that decision. Do not silently implement the same task outside the run.

## Agent Workflow Studio

Studio is an optional companion cockpit over the same headless Agent Workflow
engine. It is not a separate workflow backend and does not replace Codex.

When the user asks for Studio:

1. Resolve and validate the target project with Agent Workflow tools.
2. Check server/runtime readiness before claiming Studio is available.
3. Direct the user to the configured dashboard's `/studio` route, or to the
   installed native Agent Workflow Studio app when that app is present.
4. Use Studio for plans, live stages, task threads, diffs, artifacts, approvals,
   and intervention; continue to use MCP tools for model-visible operations.
5. Distinguish the browser `/studio` route from the native Studio app and verify
   which surface is open before diagnosing UI behavior.

## Safety

- Respect each target project's action policy and allowed write paths.
- Acquire and honor project work intents for write-capable work.
- Treat approval-required results as stop conditions until the user decides.
- Never expose provider keys, `.env` values, private context, or unsanitized
  artifacts.
- Keep hosted fallback enabled until local routing has real smoke, holdout,
  promotion, and low-risk evidence.
