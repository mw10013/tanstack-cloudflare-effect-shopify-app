# Shopify phase 2 embedded shell research

Phase 1 foundation is complete in current codebase. Phase 2 is now complete in current codebase.

## Source of truth

- Template embedded shell: `refs/shopify-app-template/app/routes/app.tsx`
- Template global document headers: `refs/shopify-app-template/app/entry.server.tsx`
- Header behavior details: `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/helpers/add-response-headers.ts`

## What the template does in phase 2

- Embedded app shell in app route:
  - `<AppProvider embedded apiKey={apiKey}>` in `refs/shopify-app-template/app/routes/app.tsx:19`
- Global header injection for HTML responses:
  - `addDocumentResponseHeaders(request, responseHeaders)` in `refs/shopify-app-template/app/entry.server.tsx:17`
- Header helper behavior from Shopify package:
  - sets `Link` preload/preconnect when `shop` query param exists (`.../add-response-headers.ts:29-34`)
  - sets `Content-Security-Policy` with `frame-ancestors ...` for embedded apps (`.../add-response-headers.ts:36-42`)

## Current repo status

- Embedded shell is already implemented for `/app`:
  - `src/routes/app.tsx:61-67`
  - `src/components/AppProvider.tsx:31-47`
- Iframe-safe auth transitions are implemented:
  - `/auth/session-token` bounce page and `/auth/exit-iframe` flow in `src/lib/Shopify.ts:213-259`
- Global document headers are applied for HTML responses:
  - reusable header applier exported in `src/lib/Shopify.ts:170-178`
  - worker applies headers after `serverEntry.fetch` for `text/html` responses in `src/worker.ts:113-129`
  - bounce/exit responses still use the same header behavior (`src/lib/Shopify.ts:186-201`)

## Phase 2 parity result

Phase 2 parity target is complete:

- Embedded shell parity: done
- Iframe-safe auth transitions: done
- Global Shopify document response headers on HTML responses: done

## Implemented approach (TanStack Start + Workers)

1. Reusable header applier exported as `addDocumentResponseHeaders(request, headers)` in `src/lib/Shopify.ts`.
2. Existing bounce/exit path reuses shared internal header logic to avoid drift.
3. `src/worker.ts` wraps `serverEntry.fetch` result for `text/html` responses, clones headers, applies Shopify document headers, and returns a new response.

## How to check

1. Start local app with Shopify CLI flow:
   - `pnpm shopify:dev`
2. Quick deterministic header check (single command, no store install needed):
   - `curl -sS -D - -o /dev/null "http://localhost:$(pnpm port)/auth/session-token?shop=your-store.myshopify.com&embedded=1&host=dGVzdA==&shopify-reload=http://localhost:$(pnpm port)/app"`
3. In response headers, confirm:
   - `content-security-policy` includes `frame-ancestors https://<shop> https://admin.shopify.com ...`
   - `link` includes preload/preconnect for Shopify CDN/App Bridge/Polaris
4. Run static checks:
   - `pnpm typecheck`
   - `pnpm lint`

## Non-phase-2 items (do not block phase 2)

- `app/scopes_update` webhook parity is still missing (`.shopify-cli/shopify.app.toml` only has `app/uninstalled`) and belongs to phase 4.
- Baseline app surface parity (`/app/additional`) belongs to phase 3.
