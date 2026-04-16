# Multiple clones of tanstack-cloudflare-agent

Tracks sibling repositories next to the primary `tanstack-cloudflare-agent` checkout for parallel development.

## Goals

- Primary repo at `/Users/mw/Documents/src/tanstack-cloudflare-agent`.
- Clones as independent siblings under `/Users/mw/Documents/src/`.
- Shared git objects via `--reference` for disk savings.

## Naming

- `tanstack-cloudflare-agent` (primary)
- `tanstack-cloudflare-agent-clone`
- `tanstack-cloudflare-agent-clone1`
- `tanstack-cloudflare-agent-clone2`

Increments suffix for easy enumeration.

## Clone commands

From `/Users/mw/Documents/src`:

```bash
git clone --reference tanstack-cloudflare-agent https://github.com/mw10013/tanstack-cloudflare-agent.git tanstack-cloudflare-agent-clone
git clone --reference tanstack-cloudflare-agent https://github.com/mw10013/tanstack-cloudflare-agent.git tanstack-cloudflare-agent-clone1
git clone --reference tanstack-cloudflare-agent https://github.com/mw10013/tanstack-cloudflare-agent.git tanstack-cloudflare-agent-clone2
```

Each clone has isolated `.git` refs and working tree.

## Setting up shared links

After cloning, run the setup script to create symlinks to shared files from the primary repository:

```bash
pnpm run clone:links
```

This creates symlinks for `refs/` and `todo.md` pointing to the primary repo's versions, avoiding duplication.

## Handling parallel dev ports

- Copy primary `.env` to each clone.
- Set unique `PORT` in each `.env` (incrementing numbers).
- No specific port values; clones use incrementing ports.
- `BETTER_AUTH_URL` must align with `PORT`.
- E2E tests uniquify emails with `-PORT` to avoid cross-clone collisions.

## Port flow map

| Concern           | File/Setup                    | Port handling                                              |
| ----------------- | ----------------------------- | ---------------------------------------------------------- |
| Dev server        | `package.json` dev script     | Sources `.env`, uses `$PORT` for vite dev.                 |
| Playwright        | `playwright.config.ts`        | Loads `.env`, uses `process.env.PORT` for url/baseURL.     |
| Integration tests | `test/integration/`           | Use fixed `http://example.com`, no localhost ports.        |
| Stripe CLI        | `package.json` stripe scripts | Sources `.env`, uses `$PORT` in webhook URL.               |
| Wrangler config   | `wrangler.jsonc`              | BETTER_AUTH_URL hardcoded per env; types as string.        |
| Typegen           | `worker-configuration.d.ts`   | Generated with `wrangler types`; env vars typed as string. |
