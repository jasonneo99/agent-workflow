# Tellara Commands

## Setup

```bash
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install --frozen-lockfile
```

## Local Development

```bash
pnpm dev:all
```

Local app: `http://localhost:3000`

Local service dashboard: `http://127.0.0.1:8787`

## Focused Verification

```bash
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run db:boundary-discipline
pnpm run db:migrate:validate
pnpm run staff:registry:check
pnpm run staff:catalog:check
pnpm run staff:policies:check
```

## Broader Verification

```bash
pnpm run verify
pnpm run test:e2e:local-dashboard
pnpm run build
pnpm run build:public-profile
```

## Destructive Or Long-Running Commands

Do not run these automatically without explicit user intent:

```bash
pnpm run dev:services:reset
pnpm run db:reset
pnpm run fga:reset
pnpm run dev:all
pnpm run dev
```
