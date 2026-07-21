# Profiles

The default profile is enterprise.

## Enterprise

Enterprise mode expects the local service stack:

- Postgres + pgvector
- Redis
- MinIO object storage

It is the recommended default because it supports durable workflow runs, audit receipts, semantic memory, queues, cached summaries, and future multi-user operation.

Initialize a project:

```bash
npm run init-project -- --project /path/to/project --profile enterprise
```

Check services:

```bash
npm run doctor
```

Seed storage:

```bash
npm run bootstrap-storage
```

## Simple

Simple mode is opt-in for users who only want portable files and compiled workflow briefs.

Initialize a project:

```bash
npm run init-project -- --project /path/to/project --profile simple
```

Check definitions without service checks:

```bash
npm run doctor -- --simple
```

## Truck Outfitters Unlimited

Truck Outfitters mode is a production-site profile for `/Users/jasonmiller/Projects/truckoutfittersunlimited`.

Initialize the project:

```bash
npm run init-project -- --project /Users/jasonmiller/Projects/truckoutfittersunlimited --profile truckoutfitters
```

Preview an orchestration plan:

```bash
npm run agentflow -- orchestrate \
  --project /Users/jasonmiller/Projects/truckoutfittersunlimited \
  --task "Review the production site UX, SEO, mobile experience, and launch risks" \
  --dry-run
```

Run the orchestration:

```bash
npm run agentflow -- orchestrate \
  --project /Users/jasonmiller/Projects/truckoutfittersunlimited \
  --task "Review the production site UX, SEO, mobile experience, and launch risks"
```
