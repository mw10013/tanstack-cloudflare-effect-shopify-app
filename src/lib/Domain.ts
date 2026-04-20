import { Schema } from "effect";

export const ShopifySessionId = Schema.NonEmptyString.pipe(
  Schema.brand("ShopifySessionId"),
);
export type ShopifySessionId = typeof ShopifySessionId.Type;

export const ShopDomain = Schema.NonEmptyString.pipe(
  Schema.brand("ShopDomain"),
);
export type ShopDomain = typeof ShopDomain.Type;

const ShopifySessionPayloadEntries = Schema.mutable(
  Schema.Array(
    Schema.mutable(
      Schema.Tuple([
        Schema.String,
        Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
      ]),
    ),
  ),
);

export const ShopifySessionPayload = Schema.fromJsonString(
  ShopifySessionPayloadEntries,
);
export type ShopifySessionPayload = typeof ShopifySessionPayload.Type;

export const ShopifySession = Schema.Struct({
  id: ShopifySessionId,
  shop: ShopDomain,
  payload: ShopifySessionPayload,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ShopifySession = typeof ShopifySession.Type;
