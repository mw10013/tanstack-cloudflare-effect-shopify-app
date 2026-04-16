import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";
import * as Option from "effect/Option";

import { D1 } from "@/lib/D1";

const getIndexData = createServerFn({ method: "GET" }).handler(
  ({ context: { runEffect } }) =>
    runEffect(
      Effect.gen(function* () {
        const d1 = yield* D1;
        const row = yield* d1.first<{ count: number }>(
          d1.prepare("select count(*) as count from ShopifySession"),
        );
        return {
          shopifySessionCount: row.pipe(
            Option.match({
              onNone: () => 0,
              onSome: ({ count }) => Number(count),
            }),
          ),
        };
      }),
    ),
);

export const Route = createFileRoute("/")({
  loader: () => getIndexData(),
  component: RouteComponent,
});

function RouteComponent() {
  const { shopifySessionCount } = Route.useLoaderData();
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Shopify phase 1</h1>
        <p className="text-sm text-muted-foreground">
          Dev store auth plumbing for TanStack Start + Cloudflare + Effect v4
        </p>
      </header>
      <section className="rounded-lg border p-4 text-sm text-muted-foreground">
        Stored Shopify sessions: {shopifySessionCount}
      </section>
      <section className="rounded-lg border p-4">
        <div className="flex flex-wrap gap-3 text-sm">
          <Link className="rounded-md border px-3 py-2" to="/auth/login">
            Start auth
          </Link>
          <Link className="rounded-md border px-3 py-2" to="/app">
            Open app route
          </Link>
        </div>
      </section>
    </main>
  );
}
