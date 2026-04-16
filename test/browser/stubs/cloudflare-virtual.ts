/**
 * Browser-Mode shims for Cloudflare's runtime-only virtual modules
 * (`cloudflare:workers`, `cloudflare:email`).
 *
 * Vitest Browser Mode bundles tests with Vite/esbuild for a browser target,
 * but the route tree transitively imports modules that only resolve inside
 * workerd — `agents`, `partyserver`, `@/organization-agent`, and
 * `src/user-provisioning-workflow.ts`. Without shims, dep-optimization fails
 * on the unknown `cloudflare:*` specifiers.
 *
 * `test/browser/vitest.config.ts` aliases both specifiers to this file so
 * imports resolve to harmless no-ops. Tests never exercise these code paths;
 * they only need module resolution to succeed.
 */

// oxlint-disable no-extraneous-class -- runtime stubs; shape must match the real exports
export class DurableObject {}
export class RpcTarget {}
export class WorkflowEntrypoint {}
export class EmailMessage {}
export const env: Record<string, unknown> = {};
