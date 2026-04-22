import { Context, Effect, Layer, Schema } from "effect";

import type { ShopifyAdminContext as ShopifyAdminContextValue } from "@/lib/Shopify";

type ShopifyGraphqlOptions = Parameters<ShopifyAdminContextValue["graphql"]>[1];

const ShopifyAdminContext = Context.Service<ShopifyAdminContextValue>(
  "ShopifyAdminContext",
);

export class ShopifyAdminApiError extends Schema.TaggedErrorClass<ShopifyAdminApiError>()(
  "ShopifyAdminApiError",
  { message: Schema.String, cause: Schema.Defect },
) {}

export class ShopifyAdminApi extends Context.Service<ShopifyAdminApi>()(
  "ShopifyAdminApi",
  {
    make: Effect.gen(function* () {
      const admin = yield* ShopifyAdminContext;
      const graphql = Effect.fn("ShopifyAdminApi.graphql")(
        function* (query: string, options?: ShopifyGraphqlOptions) {
          return yield* admin.graphql(query, options).pipe(
            Effect.mapError(
              (cause) =>
                new ShopifyAdminApiError({
                  message: "Admin GraphQL request failed",
                  cause,
                }),
            ),
          );
        },
      );
      const graphqlJson = Effect.fn("ShopifyAdminApi.graphqlJson")(
        function* (query: string, options?: ShopifyGraphqlOptions) {
          const response = yield* graphql(query, options);
          return yield* Effect.tryPromise({
            try: () => response.json(),
            catch: (cause) =>
              new ShopifyAdminApiError({
                message: "Admin GraphQL JSON decode failed",
                cause,
              }),
          });
        },
      );
      const graphqlDecode = Effect.fn("ShopifyAdminApi.graphqlDecode")(
        function* <A>(
          schema: Schema.Decoder<A>,
          query: string,
          options?: ShopifyGraphqlOptions,
        ) {
          const json = yield* graphqlJson(query, options);
          return yield* Effect.try({
            try: () => Schema.decodeUnknownSync(schema)(json),
            catch: (cause) =>
              new ShopifyAdminApiError({
                message: "Admin GraphQL response validation failed",
                cause,
              }),
          });
        },
      );
      return {
        graphql,
        graphqlJson,
        graphqlDecode,
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
  /**
   * Builds a `ShopifyAdminApi` layer bound to one authenticated admin context.
   *
   * Use this at request time after `shopify.authenticateAdmin` succeeds.
   *
   * @example
   * ```ts
   * const auth = yield* shopify.authenticateAdmin(request)
   * if (auth instanceof Response) return auth
   *
   * const result = yield* program.pipe(
   *   Effect.provide(ShopifyAdminApi.layerFor(auth)),
   * )
   * ```
   */
  static readonly layerFor = (admin: ShopifyAdminContextValue) =>
    this.layer.pipe(Layer.provide(Layer.succeed(ShopifyAdminContext, admin)));
}
