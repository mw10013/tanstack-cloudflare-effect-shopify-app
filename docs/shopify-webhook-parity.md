# Webhook Security & Authentication Parity (Completed)

Comparison of webhook handling between `refs/shopify-app-template` (upstream React Router template) and our TanStack Start / Cloudflare / Effect port.

Scope: subscription declaration, request auth/validation, returned webhook context shape, and route handlers for `app/uninstalled` and `app/scopes_update`.

Verified against:

- `refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx`
- `refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx`
- `refs/shopify-app-template/app/shopify.server.ts`
- `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/webhooks/authenticate.ts`
- `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/webhooks/types.ts`
- `refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/webhooks/__tests__/authenticate.test.ts`
- `refs/shopify-app-js/packages/apps/shopify-api/lib/webhooks/validate.ts`
- `src/lib/Shopify.ts`
- `src/routes/webhooks.app.uninstalled.ts`
- `src/routes/webhooks.app.scopes_update.ts`
- `refs/shopify-docs/docs/apps/build/webhooks.md`
- `refs/shopify-docs/docs/apps/build/webhooks/subscribe/https.md`
- `refs/shopify-docs/docs/apps/build/webhooks/ignore-duplicates.md`

## TL;DR

| Concern | Template | Our port | Parity? |
| --- | --- | --- | --- |
| Subscriptions in `shopify.app.toml` | `app/uninstalled`, `app/scopes_update` | Same topics and URIs | ✅ |
| Runtime registration (`registerWebhooks` / `afterAuth`) | Exported but not used in template app | Not implemented | ✅ (same effective behavior) |
| HMAC validation library | `@shopify/shopify-api` `webhooks.validate` | Same library and call | ✅ |
| Non-POST / invalid signature response codes | 405 / 401 / 400 | 405 / 401 / 400 | ✅ wire behavior |
| Failure response surface | throws `Response` + `statusText` | returns `Response`, no `statusText` | ⚠️ surface |
| Failure-path logs | `logger.debug(...)` in auth helper | no debug logging in auth helper | ❌ operational parity |
| Offline session load + refresh | `ensureValidOfflineSession(...)` | same concept in Effect (`ensureValidOfflineSession`) | ✅ |
| Success context shape | includes `webhookId`, `subTopic`/`name`, and events fields (`handle`/`action`/`resourceId`) | missing those fields | ❌ contract gap |
| Duplicate detection header exposed | `eventId` and `webhookId` | `eventId` only (optional on `webhooks` transport) | ⚠️ partial |
| `app/uninstalled` handler | delete sessions if `session` exists | unconditional `deleteSessionsByShop(shop)` | ⚠️ intentional refinement |
| `app/scopes_update` handler | update `scope` when `session` exists | same behavior + payload/schema validation | ✅ (stricter input validation) |
| API version alignment | Admin API + webhook config aligned (`October25` / `2025-10`) | split (`January26` in code, `2026-07` in TOML) | ❌ drift |

## 1) Subscription declaration and registration

Both apps declare app-specific webhooks in TOML and do not rely on runtime registration in the template's current implementation.

Template (`refs/shopify-app-template/shopify.app.toml`):

```toml
[webhooks]
api_version = "2025-10"

  [[webhooks.subscriptions]]
  uri = "/webhooks/app/uninstalled"
  topics = ["app/uninstalled"]

  [[webhooks.subscriptions]]
  topics = [ "app/scopes_update" ]
  uri = "/webhooks/app/scopes_update"
```

Port (`shopify.app.toml`, `shopify.app.staging.toml`): same two subscriptions, `api_version = "2026-07"`.

Template exports `registerWebhooks` in `refs/shopify-app-template/app/shopify.server.ts:33`, but there is no call site in the template app routes. Our port also has no runtime registration path.

## 2) Request validation and auth flow

### 2.1 Core validation parity

Both flows are effectively:

1. reject non-POST
2. read raw body (`request.text()`)
3. validate via `shopify.webhooks.validate({ rawBody, rawRequest })`
4. return 401 for invalid HMAC, 400 for missing/other validation failures
5. load valid offline session for the shop

Template (`refs/shopify-app-js/.../authenticate/webhooks/authenticate.ts:22-53`):

```ts
if (request.method !== 'POST') throw new Response(undefined, { status: 405 });
const rawBody = await request.text();
const check = await api.webhooks.validate({ rawBody, rawRequest: request });
if (!check.valid) {
  throw new Response(undefined, {
    status: check.reason === WebhookValidationErrorReason.InvalidHmac ? 401 : 400,
  });
}
const session = await ensureValidOfflineSession(params, check.domain);
```

Port (`src/lib/Shopify.ts:339-356`):

```ts
if (request.method !== "POST") return new Response(undefined, { status: 405 });
const rawBody = yield* tryShopifyPromise(() => request.text());
const check = yield* tryShopifyPromise(() =>
  shopify.webhooks.validate({ rawBody, rawRequest: request }),
);
if (!check.valid) {
  return new Response(undefined, {
    status: check.reason === ShopifyApi.WebhookValidationErrorReason.InvalidHmac ? 401 : 400,
  });
}
const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(check.domain);
const session = Option.getOrUndefined(yield* ensureValidOfflineSession(shop));
```

Crypto/auth security parity: yes.

### 2.2 Surface/operational differences

- Template throws `Response` and sets `statusText` (`Method not allowed`, `Unauthorized`, `Bad Request`); ours returns `Response` and omits `statusText`.
- Template logs failure paths (`logger.debug(...)` at non-POST and validation failures); ours currently does not log those paths.

Behavior on the wire is equivalent for status code, but debuggability is not.

## 3) Returned webhook context parity (main gap)

Template context includes more fields than our port returns.

Template (`refs/shopify-app-js/.../authenticate/webhooks/authenticate.ts:56-87` and `.../types.ts:12-170`) includes:

- always: `apiVersion`, `shop`, `topic`, `webhookId`, `payload`, `webhookType`, `triggeredAt`, `eventId`
- webhooks transport: `subTopic`, `name`
- events transport: `handle`, `action`, `resourceId`

Port (`src/lib/Shopify.ts:356-366`) currently returns:

- `shop`, `topic`, `apiVersion`, `webhookType`, `triggeredAt`, `eventId`, `payload`, `session`, `admin`
- missing: `webhookId`, `subTopic`, `name`, `handle`, `action`, `resourceId`

This is not a security hole, but it is a real contract parity gap.

Upstream tests assert these fields for events (`refs/shopify-app-js/.../authenticate.test.ts:191-200`):

```ts
expect(result.webhookType).toBe('events');
expect(result.webhookId).toBe('webhook-456');
expect(result.eventId).toBe('evt-123');
expect(result.handle).toBe('my-handle');
expect(result.action).toBe('update');
expect(result.resourceId).toBe('gid://shopify/Product/123');
```

## 4) Duplicate webhook semantics (important correction)

Shopify's duplicate-handling guide recommends dedupe by `X-Shopify-Event-Id`, not by `X-Shopify-Webhook-Id`:

> "Get the event ID from the headers. This is the `X-Shopify-Event-Id` header and the same value across more than one webhook indicates a duplicate."  
> (`refs/shopify-docs/docs/apps/build/webhooks/ignore-duplicates.md:17`)

Implication for our current port:

- We already expose `eventId`, so duplicate detection is possible today when `eventId` is present. Note: per `refs/shopify-app-js/packages/apps/shopify-api/lib/webhooks/types.ts:187-196`, `eventId` is required on the `events` transport but optional (`eventId?: string`) on the classic `webhooks` transport — dedupe code must handle `undefined`.
- Missing `webhookId` is still a template API parity gap and reduces context fidelity.

## 5) Route handler parity

### `app/uninstalled`

Template (`refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx:12-14`):

```ts
if (session) {
  await db.session.deleteMany({ where: { shop } });
}
```

Port (`src/routes/webhooks.app.uninstalled.ts:29-31`):

```ts
if (result instanceof Response) return result;
yield* shopify.deleteSessionsByShop(result.shop);
```

This is an intentional refinement: unconditional delete converges to same DB end-state and avoids the extra session existence branch.

### `app/scopes_update`

Template updates scope only when `session` exists. Port does the same and adds runtime validation:

- `Schema.decodeUnknownEffect(ScopesUpdatePayload)(result.payload)`
- `Schema.decodeUnknownEffect(Domain.SessionId)(result.session.id)`

Parity: yes, with stricter decode guarantees.

## 6) API version drift (template vs port, and within port)

Template is aligned:

- `refs/shopify-app-template/app/shopify.server.ts:13` -> `ApiVersion.October25`
- `refs/shopify-app-template/shopify.app.toml:9` -> `api_version = "2025-10"`

Port is split:

- `src/lib/Shopify.ts:70` -> `ShopifyApi.ApiVersion.January26`
- `shopify.app.toml:13` / `shopify.app.staging.toml:12` -> `api_version = "2026-07"`

That is an internal drift in our app surface, not only a "we are ahead of template" drift.

## 7) Shopify delivery expectations check

Shopify expects quick 2xx responses:

- `refs/shopify-docs/docs/apps/build/webhooks/subscribe/https.md:40`: non-2xx is treated as failure
- `refs/shopify-docs/docs/apps/build/webhooks/subscribe/https.md:46`: full request timeout is five seconds
- `refs/shopify-docs/docs/apps/build/webhooks/subscribe/https.md:58`: retries 8 times over 4 hours on failure/no response

Both template and port return `new Response()` on success for these two routes, satisfying the status-code requirement.

## 8) Final parity backlog (prioritized)

1. **Restore full webhook context shape** in `Shopify.authenticateWebhook`:
   - add `webhookId`
   - add webhooks fields `subTopic`, `name`
   - add events fields `handle`, `action`, `resourceId`
   - ideally return a discriminated union by `webhookType` like upstream so `eventId` is typed required on `events` and optional on `webhooks`

2. **Add debug logs on auth failure paths** in `Shopify.authenticateWebhook` (non-POST, invalid HMAC, missing headers/other invalid).

3. **Decide API version policy and align config**:
   - either align `src/lib/Shopify.ts` and `shopify.app*.toml` to one version
   - or keep split intentionally and document why

4. **Optional surface parity nicety**: set `statusText` for 405/401/400 to match template responses exactly.

Items 1-2 are direct parity work. Item 3 is architectural policy. Item 4 is low-risk polish.
