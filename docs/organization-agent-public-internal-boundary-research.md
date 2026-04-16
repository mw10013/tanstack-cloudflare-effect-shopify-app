# Organization Agent Public/Internal Boundary Research

## Goal

Keep `OrganizationAgent` boundaries explicit:

- user/browser entrypoints are `@callable()` methods
- trusted server/queue/workflow entrypoints are direct DO RPC methods
- caller-context guard runs on user entrypoints

## Approach

Use two clear surfaces:

1. public callable wrapper (`@callable()`) for browser/user traffic
2. internal plain method for trusted callers (server, queue, workflow)

Apply caller guard only where caller context exists:

```ts
const { connection, request } = getCurrentAgent<OrganizationAgent>();
if (!connection && !request) return;
```

This keeps authorization semantics precise: caller checks for user surfaces, trusted execution for internal surfaces.

## Current Runtime Shape

Entrypoint surfaces in this repo now:

1. browser/user via Agents routing + `@callable()` methods
2. server-side trusted code via direct DO RPC stubs
3. queue consumers via direct DO RPC stubs
4. workflow runtime callbacks

Worker gate for browser-originated agent traffic (`src/worker.ts`):

```ts
const routed = await routeAgentRequest(request, env, {
  onBeforeConnect: (req) => runEffect(authorizeAgentRequest(req)),
  onBeforeRequest: (req) => runEffect(authorizeAgentRequest(req)),
});
```

## Current Method Matrix

Based on `src/organization-agent.ts` and current call sites in `src/`.

| Method | `@callable()` | Browser usage | Trusted server usage | Queue/workflow usage |
| --- | --- | --- | --- | --- |
| `createInvoice()` | Yes | Yes | No current internal call site | No |
| `updateInvoice(input)` | Yes | Yes | No current internal call site | No |
| `uploadInvoice(input)` | Yes | Yes | No current internal call site | No |
| `deleteInvoice(input)` | Yes | Yes | No current internal call site | No |
| `getInvoices()` | No | No current browser call site | Yes (`src/lib/Invoices.ts`) | No |
| `getInvoice(input)` | No | No current browser call site | Yes (`src/lib/Invoices.ts`, invoice detail loader) | No |
| `syncMembership(input)` | No | No | Yes (auth hooks + server fns) | No |
| `onInvoiceUpload(input)` | No | No | No | Yes (`src/lib/Q.ts`) |
| `onFinalizeInvoiceDeletion(input)` | No | No | No | Yes (`src/lib/Q.ts`) |
| `onFinalizeMembershipSync(input)` | No | No | No | Yes (`src/lib/Q.ts`) |
| `saveInvoiceExtraction(input)` | No | No | No | Yes (`src/invoice-extraction-workflow.ts`) |

## How Invoice Boundaries Work Now

`src/organization-agent.ts` now has only four callable invoice methods:

```ts
@callable()
createInvoice() { ... }

@callable()
updateInvoice(input) { ... }

@callable()
uploadInvoice(input) { ... }

@callable()
deleteInvoice(input) { ... }
```

And invoice read methods are plain methods (no decorator):

```ts
getInvoices() { ... }

getInvoice(input) { ... }
```

Server-side invoice reads call direct DO RPC (`src/lib/Invoices.ts`):

```ts
const invoices = yield* Effect.tryPromise(() => stub.getInvoices());
...
const invoice = yield* Effect.tryPromise(() => stub.getInvoice({ invoiceId }));
```

Browser code currently calls only mutation methods via `useOrganizationAgent().stub` in:

- `src/routes/app.$organizationId.invoices.index.tsx`
- `src/routes/app.$organizationId.invoices.$invoiceId.tsx`

## Naming Cleanup (Simple)

Stub helper names now encode trust level directly:

1. `src/lib/Invoices.ts#getOrganizationAgentStubForSession`
2. `src/lib/Q.ts#getOrganizationAgentStubTrusted`

Why this helps:

- makes trust level obvious at import and call site
- reduces accidental use of trusted stubs in user-scoped flows
- improves code review speed for boundary/security checks

## Practical Rule For New Capabilities

If a capability needs both browser and internal access, split into two methods:

1. callable wrapper + caller guard
2. internal method for trusted callers

If browser access is not needed, keep only the internal method.

## Bottom Line

- boundary approach is: callable for user entrypoints, plain RPC for trusted internals
- current code matches that approach for invoice operations
- `assertCallerMember` is the correct guard name for caller-scoped authorization
- stub helper naming now encodes trust level directly
