# Scrubbed Examples

This directory contains synthetic examples that demonstrate Agent Workflow output without private project data.

- `scrubbed-run.md`: shareable Markdown run export.
- `scrubbed-run.json`: matching structured run export.

These files are intentionally scrubbed. They should not contain local paths, emails, secrets, compiled briefs, raw command output, private prompts, schemas, tenant details, customer details, or product-specific task text.

Validate them with:

```bash
npm run validate-examples
```
