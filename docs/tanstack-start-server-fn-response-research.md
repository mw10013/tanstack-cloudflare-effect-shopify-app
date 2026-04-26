# TanStack Start Server Fn Response + Effect `runEffect` Research

Question: for TanStack Start server functions, what happens on the wire in these cases?

1. server fn **returns** a `Response`
2. server fn **throws** a `Response`

And how should `runEffect` preserve HTTP semantics for TanStack Start, especially server functions?

## Soundness Verdict

- TanStack Start preserves `Response` semantics for server functions (raw response passthrough + redirect serialization path).
- The missing piece was `instanceof Response` in the post-`Cause.squash` check in `runEffect` — without it, non-redirect `Response` failures were converted to a generic `Error` before Start could inspect them.
- Fixed at `src/worker.ts:82`: one predicate added. `Cause.squash` priority (first `Fail` → first `Die`) already returns the `Response` correctly; the check just wasn't routing it.

## Grounded Findings

### 1) TanStack Start server fn response transport has three paths

`refs/tan-start/packages/start-server-core/src/server-functions-handler.ts`:

```ts
const unwrapped = res.result || res.error

if (unwrapped instanceof Response) {
  if (isRedirect(unwrapped)) {
    return unwrapped
  }
  unwrapped.headers.set(X_TSS_RAW_RESPONSE, 'true')
  return unwrapped
}

return serializeResult(res)
```

Source: `refs/tan-start/packages/start-server-core/src/server-functions-handler.ts:164-182`.

Meaning:

- non-redirect `Response` -> raw response (`x-tss-raw: true`)
- redirect `Response` -> redirect handling path
- non-`Response` values -> serialized payload (`x-tss-serialized`)

### 2) Redirect responses for server fn requests are serialized to redirect JSON

`refs/tan-start/packages/start-server-core/src/createStartHandler.ts`:

```ts
if (request.headers.get('x-tsr-serverFn') === 'true') {
  return Response.json(
    { ...response.options, isSerializedRedirect: true },
    { headers: response.headers },
  )
}
```

Source: `refs/tan-start/packages/start-server-core/src/createStartHandler.ts:769-773` and `:803-807`.

### 3) Client fetcher understands both raw responses and serialized redirects

`refs/tan-start/packages/start-client-core/src/client-rpc/serverFnFetcher.ts`:

```ts
if (response.headers.get(X_TSS_RAW_RESPONSE) === 'true') {
  return response
}

if (contentType.includes('application/json')) {
  const jsonPayload = await response.json()
  const redirect = parseRedirect(jsonPayload)
  if (redirect) {
    throw redirect
  }
}
```

Source: `refs/tan-start/packages/start-client-core/src/client-rpc/serverFnFetcher.ts:183-185` and `:266-271`.

### 4) Thrown values from server fn middleware/handler are preserved as `error`

`refs/tan-start/packages/start-client-core/src/createServerFn.ts`:

```ts
catch (error: any) {
  return {
    ...ctx,
    error,
  }
}
```

Source: `refs/tan-start/packages/start-client-core/src/createServerFn.ts:320-324`.

Because `server-functions-handler` unwraps `res.result || res.error`, a thrown `Response` is still eligible for the same response branches above.

### 5) `runEffect` was the place that could lose response semantics (now fixed)

The original `src/worker.ts` omitted `instanceof Response` from the post-squash check:

```ts
if (isRedirect(squashed) || isNotFound(squashed)) throw squashed  // missing Response
```

A failed/died plain `Response` would survive `Cause.squash` but fail both predicates, fall through to `throw new Error(Cause.pretty(...))`, and lose all HTTP semantics before Start could inspect it.

Fixed at `src/worker.ts:82`:

```ts
if (squashed instanceof Response || isRedirect(squashed) || isNotFound(squashed)) throw squashed
```

## Fix Applied

The bug was a missing `instanceof Response` predicate. `Cause.squash` priority (first `Fail` → first `Die`, per `Cause.ts:700-703`) already returns the `Response` value correctly for the common single-source case — the check just wasn't routing it.

Applied at `src/worker.ts:82` — one token added:

```ts
if (squashed instanceof Response || isRedirect(squashed) || isNotFound(squashed)) throw squashed
```

Restores raw-`Response` passthrough end-to-end:

- `Effect.fail(new Response(..., { status: 401 }))` → squash returns the `Response` → thrown as-is → `server-functions-handler` sets `X_TSS_RAW_RESPONSE` → client `serverFnFetcher` returns it raw.
- `Effect.die(new Response(...))` → same path (squash falls through to first `Die`).
- Existing redirect / notFound / `Error` normalization paths unchanged.

## Additional Practical Pattern

For server functions that return typed data (not raw body), prefer Start response APIs over throwing `Response`:

From docs: `setResponseHeader(s)`, `setResponseStatus` are first-class for server functions.

Source: `refs/tan-start/docs/start/framework/react/guide/server-functions.md:281-304`.

This lets you keep JSON RPC payloads while still setting status/headers, and avoid failure-channel transport concerns.

## Decision Rules for This Repo

- If endpoint semantics are raw HTTP (status/header/body contract), return or throw `Response` — `runEffect` now preserves it.
- If endpoint semantics are typed data + metadata, return typed data and use `setResponseStatus` / `setResponseHeaders`.
- Keep redirects/notFound in TanStack-native shape and rethrow unchanged.

## What To Validate

1. server fn `Effect.fail(new Response("unauthorized", { status: 401 }))` reaches client as raw `Response`.
2. server fn thrown redirect still navigates (serialized redirect path still intact).
3. existing error-boundary rendering still receives meaningful `.message` strings.
4. middleware short-circuit `Response` behavior remains unchanged.
