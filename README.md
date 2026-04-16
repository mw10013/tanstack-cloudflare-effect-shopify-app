# tanstack-cloudflare-effect-shopify-app

Bare-bones TanStack Start + Cloudflare Workers + Effect v4 app.

## Stack

- TanStack Start (Router, Query, Form)
- Cloudflare Workers with D1 + KV
- Effect v4
- Tailwind CSS

## What this template demonstrates

- `createServerFn` for GET + POST server functions
- TanStack Form form handling
- `useMutation` for writes
- Effect v4 in server function handlers
- D1 reads and writes
- KV write/read example

## Removed from previous template

- better-auth and auth flows
- Durable Objects and organization agent
- Workflows
- R2
- Queues
- Rate limits
- Cron triggers
- app/admin sidebar pages

## Local development

```bash
pnpm i
cp .env.example .env
pnpm d1:reset
pnpm dev
```

## Commands

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm test:integration
pnpm test:browser
pnpm test:e2e
```
