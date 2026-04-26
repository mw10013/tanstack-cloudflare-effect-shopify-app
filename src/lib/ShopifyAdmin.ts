import { Context, Effect, Layer, Schema } from "effect";

import { CurrentSession } from "@/lib/CurrentSession";
import { Shopify, ShopifyError } from "@/lib/Shopify";

export class ShopifyAdmin extends Context.Service<ShopifyAdmin>()("ShopifyAdmin", {
  make: Effect.gen(function* () {
    const shopify = yield* Shopify;
    const session = yield* CurrentSession;
    const graphql = Effect.fn("ShopifyAdmin.graphql")(
      (query: string, options?: { readonly variables?: Record<string, unknown> }) =>
        shopify.graphql(session, query, options),
    );
    const graphqlDecode = Effect.fn("ShopifyAdmin.graphqlDecode")(function* <A>(
      schema: Schema.Decoder<A>,
      query: string,
      options?: { readonly variables?: Record<string, unknown> },
    ) {
      const { data, errors } = yield* graphql(query, options);
      if (errors) yield* Effect.fail(new ShopifyError({ message: errors.message ?? "Admin GraphQL request failed", cause: errors }));
      return yield* Effect.try({
        try: () => Schema.decodeUnknownSync(schema)(data),
        catch: (cause) => new ShopifyError({ message: "Admin GraphQL response validation failed", cause }),
      });
    });
    return { graphql, graphqlDecode };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
