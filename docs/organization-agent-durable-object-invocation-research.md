# Organization Agent Durable Object Invocation Research

## Summary

There are four distinct invocation surfaces in play:

- native Durable Object RPC via `stub.method()`
- Durable Object fetch/HTTP via `stub.fetch(request)`
- WebSocket upgrades, usually routed through the fetch surface
- Agents SDK `@callable()` RPC over an already-open WebSocket

The most important distinction is that `stub.method()` is not HTTP. It uses Cloudflare's internal RPC transport. `stub.fetch(request)` uses Fetch API request/response semantics, but it is still an internal binding call rather than a public network round-trip.

Within the Agents SDK, `getCurrentAgent()` context follows the invocation surface:

- WebSocket message/callable: `connection` present, `request` absent
- HTTP `onRequest`: `request` present, `connection` absent
- WebSocket `onConnect`: both `connection` and `request` present
- direct/background/internal execution: both absent

## Cloudflare Durable Object Invocation Modes

### 1. Direct stub RPC: `stub.method()`

Cloudflare docs explicitly recommend direct RPC on public Durable Object methods for modern projects.

`refs/cloudflare-docs/src/content/docs/durable-objects/best-practices/create-durable-object-stubs-and-send-requests.mdx`:

```md
By writing a Durable Object class which inherits from the built-in type `DurableObject`, public methods on the Durable Objects class are exposed as RPC methods, which you can call using a DurableObjectStub from a Worker.
```

`refs/cloudflare-docs/src/content/docs/durable-objects/best-practices/rules-of-durable-objects.mdx`:

```ts
const stub = env.CHAT_ROOM.get(id);
const message = await stub.sendMessage(userId, content);
```

The Agents docs make the same distinction.

`refs/agents/docs/callable-methods.md`:

```md
The `@callable()` decorator is specifically for WebSocket-based RPC from external clients. When calling from within the same Worker or another agent, use standard Durable Object RPC directly.
```

And later:

```ts
const agent = await getAgentByName(env.MyAgent, "instance-name");
const result = await agent.processData(data);
```

This is the path that gives you no HTTP request and no WebSocket connection.

### 2. HTTP/fetch path: `stub.fetch(request)`

Cloudflare also supports sending an HTTP-style `Request` to a Durable Object fetch handler.

`refs/cloudflare-docs/src/content/docs/durable-objects/best-practices/create-durable-object-stubs-and-send-requests.mdx`:

```ts
const stub = env.MY_DURABLE_OBJECT.getByName("foo");
const response = await stub.fetch(request);
```

Important detail from the same doc:

```md
The URL associated with the Request object passed to the fetch() handler of your Durable Object must be a well-formed URL, but does not have to be a publicly-resolvable hostname.
```

So this is not "send real internet HTTP to the Durable Object". It is an internal platform call to the Durable Object's fetch handler that uses Fetch API request/response semantics.

`refs/cloudflare-docs/src/content/docs/workers/runtime-apis/rpc/reserved-methods.mdx` makes the distinction explicit:

```md
On the client side, `fetch()` called on a service binding or Durable Object stub works like the standard global `fetch()`.
...
In short, `fetch()` does not have RPC semantics, it has Fetch API semantics.
```

That means:

- you pass a `Request` or `fetch()` arguments
- the callee receives a `Request`
- redirects and other fetch behaviors follow Fetch API rules

But it is still an internal binding call, not a public network round-trip.

### 3. WebSocket path

For Durable Objects, WebSockets still start as an HTTP upgrade request, typically routed through `stub.fetch(request)`.

Example pattern in `refs/cloudflare-docs/src/content/docs/durable-objects/best-practices/websockets.mdx`:

```ts
return stub.fetch(request);
```

In the Agents SDK, the Worker-level router handles the incoming upgrade and the Agent exposes `onConnect`, `onMessage`, and `onClose`.

`refs/agents/docs/http-websockets.md`:

```md
- HTTP requests via `onRequest()`
- WebSocket connections via `onConnect()`, `onMessage()`, `onClose()`
```

### 4. Agents `@callable()` RPC

This is not native Durable Object RPC. It is Agents SDK RPC over the already-open WebSocket.

`refs/agents/docs/callable-methods.md`:

```md
Callable methods let clients invoke agent methods over WebSocket using RPC.
```

And:

```md
The `@callable()` decorator is specifically for WebSocket-based RPC from external clients.
```

So there are really two RPC layers in play:

- native Cloudflare Durable Object RPC: `stub.method()`
- Agents SDK WebSocket RPC: `agent.stub.someCallable()` in the browser

## How Stubs Work Under The Covers

Cloudflare's docs say Durable Object stubs use the platform's internal RPC/object-capability transport, not plain HTTP.

`refs/cloudflare-docs/src/content/docs/durable-objects/api/stub.mdx`:

```md
E-order is implemented by the Cap'n Proto distributed object-capability RPC protocol, which Cloudflare Workers uses for internal communications.
```

That is the key answer to "does stub use HTTP under the covers?"

- for `stub.method()`: no, this is native internal RPC
- for `stub.fetch(request)`: also not public internet HTTP; it is a special stub method with Fetch API semantics carried by the platform's internal binding/RPC machinery

The service binding docs say the same kind of thing for Worker-to-Worker communication:

`refs/cloudflare-docs/src/content/docs/workers/runtime-apis/bindings/service-bindings/http.mdx`:

```md
Worker A that declares a Service binding to Worker B can forward a Request object to Worker B, by calling the `fetch()` method that is exposed on the binding object.
```

And the RPC overview says:

`refs/cloudflare-docs/src/content/docs/workers/runtime-apis/rpc/index.mdx`:

```md
Workers provide a built-in, JavaScript-native RPC system
```

So "HTTP" here means interface shape and semantics, not "talking over a public HTTP socket".

## How Agents Populate `connection` and `request`

The Agents SDK stores invocation context with `agentContext` and populates different fields for different entrypoints.

`refs/agents/packages/agents/src/index.ts`:

```ts
export function getCurrentAgent<...>(): {
  agent: T | undefined;
  connection: Connection | undefined;
  request: Request | undefined;
  email: AgentEmail | undefined;
}
```

### HTTP `onRequest`

`refs/agents/packages/agents/src/index.ts`:

```ts
this.onRequest = (request: Request) => {
  return agentContext.run(
    { agent: this, connection: undefined, request, email: undefined },
```

### WebSocket `onMessage`

```ts
this.onMessage = async (connection: Connection, message: WSMessage) => {
  return agentContext.run(
    { agent: this, connection, request: undefined, email: undefined },
```

### WebSocket `onConnect`

```ts
this.onConnect = (connection: Connection, ctx: ConnectionContext) => {
  return agentContext.run(
    { agent: this, connection, request: ctx.request, email: undefined },
```

### Background/internal execution

The same file also shows internal paths that run with neither request nor connection, for example `onStart` and schedule execution:

```ts
this.onStart = async (props?: Props) => {
  return agentContext.run(
    { agent: this, connection: undefined, request: undefined, email: undefined },
```

and:

```ts
await agentContext.run(
  {
    agent: this,
    connection: undefined,
    request: undefined,
    email: undefined
  },
```

So the reliable interpretation is:

- `connection` present: WebSocket-originated execution
- `request` present and `connection` absent: HTTP/fetch-originated execution
- both present: WebSocket connection establishment
- both absent: non-HTTP/non-WebSocket execution context

This is a context classification, not a transport detector for one specific call path.

## Repo Examples

This repo uses all of these surfaces.

### WebSocket/browser path

`src/worker.ts` authenticates agent traffic in both `onBeforeConnect` and `onBeforeRequest`, then injects a trusted header:

```ts
const routed = await routeAgentRequest(request, env, {
  onBeforeConnect: (req) => runEffect(authorizeAgentRequest(req)),
  onBeforeRequest: (req) => runEffect(authorizeAgentRequest(req)),
});
```

`authorizeAgentRequest()` rewrites the request with:

```ts
headers.set(organizationAgentAuthHeaders.userId, session.value.user.id);
return new Request(request, { headers });
```

Then `src/organization-agent.ts` stores that identity on the WebSocket connection:

```ts
const userId = yield* Schema.decodeUnknownEffect(Domain.User.fields.id)(
  ctx.request.headers.get(organizationAgentAuthHeaders.userId),
);
connection.setState({ userId });
```

### Trusted direct stub RPC from server code

The repo also calls `OrganizationAgent` directly via DO RPC from server-side helpers.

`src/lib/Invoices.ts`:

```ts
const stub = yield* getOrganizationAgentStub(organizationId);
const invoices = yield* Effect.tryPromise(() => stub.getInvoices());
```

and:

```ts
const invoice = yield* Effect.tryPromise(() => stub.getInvoice({ invoiceId }));
```

### Trusted direct stub RPC from queue/internal code

`src/lib/Q.ts`:

```ts
yield* Effect.tryPromise(() =>
  stub.onFinalizeMembershipSync({
    userId: message.userId,
    change: message.change,
  }),
);
```

and:

```ts
yield* Effect.tryPromise(() =>
  stub.onInvoiceUpload({
    r2ActionTime: notification.eventTime,
    r2ObjectKey: notification.object.key,
  }),
);
```

Again: direct stub RPC, no HTTP request and no WebSocket connection.

## Bottom Line

- `stub.method()` is native internal Durable Object RPC, not HTTP
- `stub.fetch(request)` is the DO fetch handler with Fetch API semantics, but still via internal binding transport, not public internet HTTP
- Agents `@callable()` is separate WebSocket RPC, not Cloudflare native DO RPC
- `getCurrentAgent()` context reflects the invocation surface rather than one specific transport implementation
- in practice, `connection`/`request` presence is a useful way to distinguish WebSocket, HTTP, connection-establishment, and internal execution paths
