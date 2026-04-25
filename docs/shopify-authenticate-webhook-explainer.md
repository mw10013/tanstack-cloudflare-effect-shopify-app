# `authenticate.webhook`: What It Is, Why The Port Missed It, And What To Do Next

Audience: you, after staring at Step 3 and asking "does the template even have this?" and "how could that have been missed?"

Short answers up front:

- **Yes**, the template has it. `authenticate.webhook` is a top-level, publicly documented API of the `@shopify/shopify-app-react-router` library ([refs/shopify-app-js/.../authenticate/webhooks/authenticate.ts](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/webhooks/authenticate.ts)) and both template webhook routes use it ([refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx:6](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx#L6), [refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx:6](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx#L6)).
- **How it was missed**: the port was built bottom-up from "what do the two existing webhook routes need" rather than top-down from "what does `authenticate.webhook` do". The two existing routes don't make Admin API calls, so nobody needed a session or an admin client inside a webhook, so the HMAC-only `validateWebhook` looked complete.
- **What to do next**: four concrete decisions, spelled out at the end with recommendations.

## Part 1: Shopify webhook anatomy

Skip this if you already know it. Everything else in the doc assumes this shared vocabulary.

### What a webhook is, mechanically

A Shopify webhook is an **HTTP POST** from Shopify's servers to your app, triggered by an event on a shop (order created, app scopes updated, merchant uninstalled the app, etc). Shopify docs:

> "Each webhook is made up of **headers** and a **payload**. Headers contain metadata about the webhook, like the shop that the app was installed on and where the event occurred."
> — [refs/shopify-docs/.../webhooks.md:70-71](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-docs/docs/apps/build/webhooks.md#L70-L71)

Every delivery carries these headers ([refs/shopify-docs/.../webhooks.md:76-84](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-docs/docs/apps/build/webhooks.md#L76-L84)):

```
X-Shopify-Topic          # e.g. "app/uninstalled"
X-Shopify-Hmac-Sha256    # signature over the body, using your app secret
X-Shopify-Shop-Domain    # "{shop}.myshopify.com"
X-Shopify-API-Version    # "2026-04"
X-Shopify-Webhook-Id     # idempotency key
X-Shopify-Triggered-At   # timestamp
X-Shopify-Event-Id       # event identifier
X-Shopify-Name           # optional subscription name
```

The body is JSON. Your handler's job is to:

1. Verify the HMAC (confirming "this came from Shopify, not a random attacker").
2. Look at the topic (dispatching to the right handler).
3. Parse the payload.
4. Do something with it — typically: update local state, call Shopify's Admin API, or both.

### Two independent design choices the app has to make per webhook

For every webhook topic your app subscribes to, there are two separate questions:

**Q1: Does this handler need to call the Admin API?**

Some webhooks are pure "delete local row" handlers — `app/uninstalled` drops sessions, `customers/redact` drops customer records. Others want to **call back into Shopify** — e.g., a `products/update` handler that wants to denormalize the updated product into your cache needs to GraphQL the product back to get the fields Shopify didn't include in the webhook body.

**Q2: Do I need the merchant's offline access token right now?**

If Q1 is yes, you need a valid offline access token for the shop. The token comes from the stored `Session` row for that shop. But the row may be:

- missing entirely (webhook fired after uninstall — more on this below)
- present but expired (with expiring offline tokens enabled)
- present but revoked out-of-band (merchant rotated your app's secret)

So even if the row exists, "get a usable admin client for this shop" is non-trivial — it's "load → refresh if expired → invalidate if 401 → re-exchange if unrecoverable".

**This is the gap `authenticate.webhook` closes.** Without it, every webhook handler that wants an admin client has to re-implement that chain. With it, you get a typed `{ shop, topic, payload, session, admin }` and a standard way to "skip if no session for this shop".

## Part 2: What `authenticate.webhook` does in the template

Concretely, in the upstream library:

```ts
// refs/shopify-app-js/.../authenticate/webhooks/authenticate.ts:19-104
return async function authenticate(request) {
  if (request.method !== 'POST') {
    throw new Response(undefined, { status: 405, statusText: 'Method not allowed' });
  }
  const rawBody = await request.text();
  const check = await api.webhooks.validate({ rawBody, rawRequest: request });

  if (!check.valid) {
    if (check.reason === WebhookValidationErrorReason.InvalidHmac) {
      throw new Response(undefined, { status: 401, statusText: 'Unauthorized' });
    } else {
      throw new Response(undefined, { status: 400, statusText: 'Bad Request' });
    }
  }
  const session = await ensureValidOfflineSession(params, check.domain);
  // ... assembles webhookContext with apiVersion, shop, topic, webhookId,
  //     payload, subTopic, session, admin, webhookType, triggeredAt, eventId
  if (!session) return webhookContext;

  const admin = adminClientFactory({ params, session, handleClientError: ... });
  return { ...webhookContext, session, admin };
};
```

In the template's rendered routes, this collapses to two-line handlers:

```tsx
// refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx:5-17
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }
  return new Response();
};
```

```tsx
// refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx:5-21
export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  const current = payload.current as string[];
  if (session) {
    await db.session.update({ where: { id: session.id }, data: { scope: current.toString() }});
  }
  return new Response();
};
```

Notice what's delegated:

- HMAC verification → helper
- Method check (POST only) → helper
- Status code selection (401 vs 400 vs 405) → helper
- Shop extraction from headers → helper
- Offline session load → helper
- Offline token refresh-if-needed → helper
- Admin client construction → helper
- JSON body parse → helper

And what the handler owns:

- topic-specific payload interpretation (`payload.current as string[]`)
- topic-specific storage write (`db.session.update(...)`)

That split is the whole point. The helper enforces "every webhook handler does the same 8 things before touching business logic, and if any of them fail you return a well-known HTTP status code".

### The full return shape

Straight from the upstream types — this is what the template's API promises:

```ts
// refs/shopify-app-js/.../authenticate/webhooks/types.ts:12-170
interface Context<Topics> {
  apiVersion: string;     // "2026-04" etc
  shop: string;           // "{shop}.myshopify.com"
  topic: Topics;          // "APP_UNINSTALLED" etc
  webhookId: string;      // "This is the idempotency key — useful to keep track
                          //  of which events your app has already processed"
  payload: Record<string, any>;
  webhookType: WebhookTypeValue;
  subTopic?: string;
  name?: string;
  handle?: string;
  action?: string;
  resourceId?: string;
  triggeredAt?: string;
  eventId?: string;
}
type WebhookContext =
  | (Context & { session: undefined; admin: undefined })
  | (Context & { session: Session; admin: AdminApiContext });
```

Two calls out:

1. **`webhookId` is the idempotency key.** This is baked into Shopify's own best-practices guide: "Get the event ID from the headers. This is the `X-Shopify-Event-Id` header and the same value across more than one webhook indicates a duplicate" ([refs/shopify-docs/.../webhooks/ignore-duplicates.md:17](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-docs/docs/apps/build/webhooks/ignore-duplicates.md#L17)). Any webhook handler that isn't already idempotent needs this. The template exposes it by default.
2. **`session` is optional, and the template's own routes check for it before acting.** This is *not* just defensive paranoia — it's a real shape. From [types.ts:186-188](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/webhooks/types.ts#L186-L188): "Webhook requests can trigger after an app is uninstalled. If the app is already uninstalled, the session may be undefined. Therefore, you should check for the session before using it." `app/uninstalled` will fire, the handler will delete sessions, and then Shopify may **retry** the delivery — on that retry, `session` is already undefined.

## Part 3: What's different in the port today

Prior to Step 3, the port had only this:

```ts
// old src/lib/Shopify.ts validateWebhook — now removed
const validateWebhook = Effect.fn("Shopify.validateWebhook")(
  function* (request: Request) {
    const rawBody = yield* tryShopifyPromise(() => request.text());
    const result = yield* tryShopifyPromise(() =>
      shopify.webhooks.validate({ rawBody, rawRequest: request }),
    );
    return { ...result, rawBody };
  },
);
```

And each webhook route had to do the rest inline:

```ts
// old webhooks.app.scopes_update.ts
const result = yield* shopify.validateWebhook(request);
if (!result.valid) return new Response("Invalid webhook", { status: 401 });
const payload = yield* Schema.decodeUnknownEffect(ScopesUpdatePayload)(JSON.parse(result.rawBody));
const shop = yield* Schema.decodeUnknownEffect(Domain.Shop)(result.domain);
const id = yield* shopify.offlineSessionId(shop);
yield* shopify.updateSessionScope({ id, scope: payload.current.toString() });
```

What this port was doing vs what the template does, feature by feature:

| Feature | Template `authenticate.webhook` | Port `validateWebhook` |
| --- | --- | --- |
| HMAC verification | yes | yes |
| Method check (POST only) | yes (405) | no |
| 401 vs 400 distinction | yes | caller-dependent (one route did, one didn't) |
| Shop extraction | yes | caller extracts manually |
| Offline session load | yes | caller derives id + loads manually |
| Offline token refresh | yes (expires-aware) | no (no refresh logic existed at all) |
| Admin client construction | yes | no |
| JSON body parse | yes | caller parses manually |
| Return shape typed per topic | yes | generic validation result |
| Idempotency key exposed | yes (`webhookId`) | not exposed |

The gap is not subtle. The port is doing **one** of the nine template responsibilities; everything else is push-down to each caller.

## Part 4: How this was missed

It was missed because every time someone looked at a webhook in the port, they saw two existing routes:

- `app/uninstalled` — deletes rows. No Admin API call.
- `app/scopes_update` — updates a row. No Admin API call.

Neither route needs `session` or `admin` in any meaningful way. So the port's construction history looks like this:

- [`6731840`](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app) ("Add Shopify OAuth phase 1 auth plumbing") added `webhooks.app.uninstalled.ts` with inline HMAC validation.
- [`33c9c42`](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app) ("Handle invalid HMAC vs other webhook validation errors separately") added the 401/400 distinction inline in the route.
- [`dfbf45c`](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app) ("Encapsulate webhook body reading in validateWebhook") extracted the HMAC-plus-rawBody bit into a service method — but stopped there.
- [`ae2ea1e`](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app) ("Add app/scopes_update webhook handler") and followups added the second route, reusing `validateWebhook` and deriving the session id manually.

At every step, "what do the two current routes need" was enough to ship. Because the two routes don't need an admin client, nobody needed `ensureValidOfflineSession`, so nobody needed token refresh, so the `future: { expiringOfflineAccessTokens: true }` flag from the template config never got ported either (G1 in [docs/shopify-app-template-parity.md](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/docs/shopify-app-template-parity.md)).

The prior research ([docs/shopify-session-lifetime-research.md](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/docs/shopify-session-lifetime-research.md)) *did* catch this — it says: "Generic webhook auth helper returning `session` and `admin`: missing. The port only has HMAC validation." But it was framed under "session lifetime parity", which makes it sound like a niche concern. It isn't — it's the default contract for every webhook handler the template ever adds.

In the port's current state, as soon as you add a third webhook route that needs to call Admin API — for example, an `orders/create` handler that wants to fetch shipping details not in the payload — you would either have to:

- duplicate the load/refresh/client-construct chain inline, or
- finally build `authenticate.webhook`.

Step 3 just did the second, now, before that pressure hits. The payoff accrues over time: every future webhook handler is a one-liner.

## Part 5: Your four open questions, answered

Recommendations are grounded in what the template does. I'll give you the argument on each side plus a recommendation.

### Q1. Should `authenticateWebhook` surface more fields (`apiVersion`, `webhookId`, `subTopic`, `triggeredAt`, `eventId`) for observability/idempotency, or truly wait for a caller?

**Template exposes all of them** ([types.ts:12-170](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/webhooks/types.ts#L12-L170)). Cost in the port: one line that spreads the check result through.

Two arguments:

- *For YAGNI*: the two current routes don't use these. You can always add them later when a route needs them.
- *For matching template*: `webhookId` is the Shopify-documented idempotency key. `eventId` is Shopify's duplicate-detection key. These are not speculative — they are load-bearing for any webhook handler that isn't already naturally idempotent, and Shopify's best-practices guide says so explicitly ([ignore-duplicates.md:17](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-docs/docs/apps/build/webhooks/ignore-duplicates.md#L17)).

The two current routes *are* naturally idempotent (delete-all-by-shop, upsert-by-id), so they don't need the idempotency key. But the template-facing promise is "you get everything a webhook handler needs". The minute you add an `orders/create` or `products/update` handler — neither of which is naturally idempotent — you need `webhookId`.

**Recommendation: match the template's shape.** Pass through `apiVersion`, `webhookId`, `subTopic`, `triggeredAt`, `eventId`. Cost is ~5 lines. Argument is "we promised template parity; these are template-surface fields; idempotency is a first-class webhook concern".

If you disagree and want strict YAGNI, the cost of adding them later is tiny (one edit in `Shopify.ts`), so it's a safe deferral. But the request to do it now is well-grounded.

### Q2. In `scopes_update`, should we keep the `if (result.session)` guard or always update?

**Template guards.** From [refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx:10-19](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-template/app/routes/webhooks.app.scopes_update.tsx#L10-L19): `if (session) { await db.session.update(...) }`.

Two arguments:

- *For guarding*: you're only updating a row that actually exists; matches template exactly; no cost.
- *For always updating* (the port's pre-refactor behavior): you're deriving the id from the shop and updating unconditionally, which is a no-op when no row matches. Equivalent outcome, minus one branch.

For `scopes_update` specifically, the outcomes are identical whether you guard or not, because SQLite `UPDATE ... WHERE id = ?` on a non-matching id is a no-op. The only difference is one SQL round-trip you don't need to make.

**Recommendation: keep the guard** (already in Step 3). Reason: it matches template exactly, and there's an edge case the template's guard protects against that the "always update" pattern doesn't — if the row was silently re-created between the session load and the update (e.g., a concurrent re-auth), the "always update" pattern would scribble the webhook's old scope over the freshly-re-authed scope. Unlikely in practice, but the guarded version is strictly safer.

### Q3. Should Step 3 include Step 5's 401 invalidation?

**Template couples them** — `authenticate.webhook`'s admin client uses the same `handleClientError` as `authenticate.admin`, which clears `session.accessToken` on 401 ([token-exchange.ts:154-170](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/admin/strategies/token-exchange.ts#L154-L170)).

Two arguments:

- *For combining*: strictly speaking, Step 3's `admin` client today is not at parity — a caller using it can get the "stale token keeps being reused" loop described in G5. Coupling means "Step 3 is actually done".
- *For staging*: Step 5 changes `buildAdminContext`, which is used by **both** `authenticateAdmin` and `authenticateWebhook`. Doing it as its own step makes the PR small and reviewable, and when Step 5 lands, it upgrades both callers at once without Step 3 needing to change. Also, neither of the two current webhook routes *calls* `result.admin`, so the coupling has no observable consequence today.

**Recommendation: keep them staged, do Step 5 next.** Reason: the 401 invalidation is a `buildAdminContext` concern, not an `authenticateWebhook` concern, so attaching it to Step 3 muddles the responsibility. Step 5 should be a small dedicated change that lifts the parity bar for both callers (admin routes + webhook routes) simultaneously. The practical cost of the delay is zero because no caller is hitting the admin client from a webhook yet.

Document it clearly so it doesn't get lost: "`result.admin` returned by `authenticateWebhook` is a standard `ShopifyAdminContext`; it will gain 401 invalidation when Step 5 updates `buildAdminContext`. No call site changes required at that point."

### Q4. Should `JSON.parse(rawBody)` return a Response(400) instead of throwing?

**Template does not catch it** ([refs/shopify-app-js/.../authenticate/webhooks/authenticate.ts:62](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/refs/shopify-app-js/packages/apps/shopify-app-react-router/src/server/authenticate/webhooks/authenticate.ts#L62)). It parses with `JSON.parse(rawBody)` and lets it throw.

Arguments:

- *For catching*: defense in depth; a non-JSON body that somehow passed HMAC would currently crash the handler with a generic Effect defect instead of a clean 400.
- *Against catching*: HMAC verification has to pass first. HMAC is computed over the raw body bytes with your app secret. Only Shopify possesses your app secret. So "non-JSON but HMAC-valid" requires that Shopify sent a non-JSON body, which is a Shopify bug, not an input-validation concern. The template's position is "if Shopify sends us garbage, we'd rather see the crash".

**Recommendation: match template, don't catch.** Reason: the scenario only fires on a Shopify bug, and a loud crash is the right response to a Shopify bug (you want it in your error dashboard). Wrapping it in a 400 would silently hide the platform-level failure. The existing Effect machinery in [src/worker.ts:80-90](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/src/worker.ts#L80-L90) already maps unhandled defects to clean error responses, so the user doesn't see a raw stack either way.

## Part 6: One adjacent thing worth flagging

Separate issue, same area — worth knowing but not blocking Step 3.

The port's [shopify.app.toml](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/shopify.app.toml) and [shopify.app.staging.toml](file:///Users/mw/Documents/src/tanstack-cloudflare-effect-shopify-app/shopify.app.staging.toml) have:

```toml
[webhooks]
api_version = "2026-07"
```

But no `[[webhooks.subscriptions]]` blocks. The template has them:

```toml
# refs/shopify-app-template/shopify.app.toml
[[webhooks.subscriptions]]
uri = "/webhooks/app/uninstalled"
topics = ["app/uninstalled"]

[[webhooks.subscriptions]]
topics = [ "app/scopes_update" ]
uri = "/webhooks/app/scopes_update"
```

Without these subscription declarations, Shopify does not route webhook events to your app for those topics — your `/webhooks/app/uninstalled` and `/webhooks/app/scopes_update` routes exist in the code but would never fire in production. There's no runtime registration path in the port either (no `registerWebhooks` call, no afterAuth hook).

This is out of scope for Step 3 (which is a code-level parity change) but worth addressing before relying on any webhook delivery in practice. One-line fix per route: add the subscription blocks to both toml files.

## Part 7: Concrete follow-ups

In order of my recommendation:

1. **Expand `authenticateWebhook`'s return** to include `apiVersion`, `webhookId`, `subTopic`, `triggeredAt`, `eventId` (Q1). ~5 lines in `src/lib/Shopify.ts`. No caller changes.
2. **Keep the current guards** in Step 3's code (Q2). Already done.
3. **Document the 401 coupling** with a one-line comment on `authenticateWebhook`'s admin field: "gains 401 invalidation when Step 5 updates `buildAdminContext`". Do not merge Step 5 into Step 3 (Q3).
4. **Don't wrap `JSON.parse`** (Q4). Already done.
5. **Add `[[webhooks.subscriptions]]` blocks** to both toml files (Part 6). Out of scope for the parity step-list but required for the webhook routes to actually receive traffic.

After your call on Q1, Step 3 is fully settled and we can move to Step 4 (`unauthenticatedAdmin`) or skip to Step 5 (401 invalidation), which I'd recommend doing next so the admin client gains the right behavior before any other caller picks it up.
