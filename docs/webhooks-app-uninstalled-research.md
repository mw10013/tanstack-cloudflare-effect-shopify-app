# Webhooks: app/uninstalled

## What Problem It Solves

When a merchant uninstalls a Shopify app, the app's OAuth tokens for that shop become permanently invalid. If the app retains those sessions:

- Subsequent OAuth flows for a re-install may conflict with or load stale sessions
- Stored access tokens become dead weight in the DB (and a security liability)
- GDPR compliance chain breaks — `shop/redact` fires 48 hours later and expects sessions already gone

The `app/uninstalled` webhook gives the app an immediate, Shopify-signed notification to clean up sessions for that shop.

## What Happens Without It

Sessions persist in `ShopifySession` after uninstall. On re-install, the OAuth flow may attempt to reuse a stale session. At minimum, junk accumulates in D1; at worst, session-loading code fails trying to decode/use an invalidated token.

The `shop/redact` GDPR webhook (fires 48 hrs post-uninstall) is a separate topic and does not substitute — Shopify's docs treat `app/uninstalled` as operational cleanup and `shop/redact` as the compliance deadline.

> "48 hours after a store owner uninstalls your app, Shopify sends a payload on the `shop/redact` topic."
> — `refs/shopify-docs/docs/apps/build/privacy-law-compliance.md`

## Shape vs. shopify-app-template

**Template** (`refs/shopify-app-template/app/routes/webhooks.app.uninstalled.tsx`):
```ts
const { shop, session, topic } = await authenticate.webhook(request);
if (session) {
  await db.session.deleteMany({ where: { shop } });
}
return new Response();
```

**This app** (`src/routes/webhooks.app.uninstalled.ts`):
```ts
const rawBody = yield* Effect.tryPromise(() => request.text());
const result = yield* shopify.validateWebhook({ rawBody, request });
if (!result.valid) return result.reason === WebhookValidationErrorReason.InvalidHmac
  ? new Response("Unauthorized", { status: 401 })
  : new Response("Bad Request", { status: 400 });
yield* shopify.deleteSessionsByShop(result.domain);
return new Response(null, { status: 200 });
```

The shapes are equivalent in intent but differ in DB call count.

The template's `authenticate.webhook` calls `ensureValidOfflineSession` unconditionally (line 52 of `refs/shopify-app-js/.../authenticate/webhooks/authenticate.ts`) — always a DB read before the `if (session)` guard runs. The guard only gates the subsequent delete.

| Scenario | Template | This app |
|---|---|---|
| First uninstall | 2 DB calls (load + delete) | 1 DB call (delete) |
| Retry / already uninstalled | 1 DB call (load, noop) | 1 DB call (delete noop) |

Unconditional delete is strictly more efficient. `DELETE WHERE shop = ?` on zero rows is a no-op — same idempotency guarantee at lower cost.

## validateWebhook (`src/lib/Shopify.ts:290`)

```ts
const validateWebhook = Effect.fn("Shopify.validateWebhook")(
  function* ({ rawBody, request }: { rawBody: string; request: Request }) {
    return yield* tryShopifyPromise(() =>
      shopify.webhooks.validate({
        rawBody,
        rawRequest: request,
      }),
    );
  },
);
```

Delegates to `shopify-api-node`'s `webhooks.validate`, which:
1. Reads `X-Shopify-Hmac-Sha256` header
2. Computes HMAC-SHA256 of `rawBody` using the app's `apiSecretKey`
3. Compares via timing-safe equality
4. Returns `{ valid: boolean, domain: string, ... }`

The ref library's own authenticate flow does the same thing (`refs/shopify-app-js/.../authenticate/webhooks/authenticate.ts:30`):
```ts
const check = await api.webhooks.validate({ rawBody, rawRequest: request });
if (!check.valid) {
  if (check.reason === WebhookValidationErrorReason.InvalidHmac) {
    throw new Response(undefined, { status: 401, ... });
  } else {
    throw new Response(undefined, { status: 400, ... });
  }
}
```

Aligned with the ref: `InvalidHmac` → 401, all other reasons (`MissingBody`, `MissingHmac`, `MissingHeaders`) → 400. The route branches on `result.reason` after `validateWebhook` returns invalid.

The raw body is read before validation and passed explicitly, which is required: the request body stream can only be read once.

## deleteSessionsByShop (`src/lib/Shopify.ts:218`)

```ts
const deleteSessionsByShop = Effect.fn("Shopify.deleteSessionsByShop")(
  function* (shop: string) {
    yield* d1.run(
      d1.prepare("delete from ShopifySession where shop = ?1").bind(shop),
    );
  },
);
```

Parameterized query against D1 — no SQL injection surface. Deletes by `shop` column, which is the `myshopify.com` domain from `result.domain`.

Template uses Prisma: `db.session.deleteMany({ where: { shop } })`. Same semantics. The `shop` column value is sourced from the validated webhook payload (`result.domain`), which is the HMAC-verified shop domain — trustworthy input.

**Solid**: parameterized, targets only the uninstalled shop, idempotent, runs inside the Effect pipeline so errors surface through the Effect error channel.
