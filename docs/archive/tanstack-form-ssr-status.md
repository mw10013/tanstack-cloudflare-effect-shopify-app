# TanStack Form SSR Status (March 2026)

Conclusion: **avoid the SSR form pattern (`react-form-start`) for now.** Use the client mutation pattern (login.tsx) instead.

## Why

The SSR/server validation layer has fundamental open issues. The client-side form API is excellent — the SSR layer is not.

## Open Issues

### Type Safety Broken

- **#1856** — `createServerValidate` returns `Promise<any>`. Generics erased when internals switched to `createServerFn`. No typed validated output.
- **#1438** — Types lie. FormData values are strings at runtime but typed as schema output (`age` typed as `number`, actually `"25"`).
- **#1723** — Validation returns raw input, not schema-transformed output. Docs say to re-parse in `onSubmit` — validation runs twice.
- **#1325** — `formErrors.map(error)` has broken type inference (`void | undefined` instead of error types).

### Field Error Propagation Broken

- **#1704** (labeled `bug`) — Server validation errors land in `errorMap.onServer.fields` but never propagate to `field.state.meta.errors`. Field-level error display impossible with server validation. Affects Next.js, React Router, and TanStack Start.
- **#1643** — Cannot programmatically set `onServer` errors type-safely. `TOnServer` generic defaults to `undefined`.

### No Success Channel

No mechanism to return business logic results after validation passes. `createServerValidate` returns raw values or throws errors. Forces redirect-to-separate-route pattern for success states (see login1.tsx spike).

### Examples Were Broken

- **#1984** (open) — Next.js server actions example non-functional. `isSubmitting` never true, `onSubmit` never fires.
- **#1944** (closed) — TanStack Start example was broken. Fixed in v1.28.1 via PR #1890.

## Cookie Transport (TanStack Start-specific)

`react-form-start` serializes form state to `_tanstack_form_internals` cookie via `devalue`, redirects, reads+deletes in loader, merges back into client form. Issues:

- 4KB cookie size limit
- Extra indirection (`getFormData` → `getFormDataFromServer`)
- Next.js path uses `useActionState` instead — cookie is Start-specific

## Maintainer Activity

PR #1890 ("Fix Issues with SSR") merged Feb 2026 — fixed some basics but deeper issues remain open. No public roadmap for an SSR rework.

## Our Spike

`login1.tsx` + `login1-success.tsx` implemented the full pattern. Problems encountered:

- `validatedData` typed as `any`, required eslint-disable for `unsafe-assignment`
- Form error rendering required 30-line `flatMap` to handle `string | Record<string, { message }[]>` union
- Success state forced into separate route + query param (magicLink in URL)
- Client validation commented out during testing due to friction with the pattern

## Recommendation

Stick with client mutation pattern (`useForm` + `useMutation` + `useServerFn`) until upstream fixes land. Revisit when #1856 (typed returns) and #1704 (field error propagation) are resolved.
