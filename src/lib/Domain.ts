import { Schema } from "effect";

export const ShopifySessionId = Schema.NonEmptyString.pipe(
  Schema.brand("ShopifySessionId"),
);
export type ShopifySessionId = typeof ShopifySessionId.Type;

export const ShopDomain = Schema.NonEmptyString.pipe(
  Schema.brand("ShopDomain"),
);
export type ShopDomain = typeof ShopDomain.Type;

export const ShopifySession = Schema.Struct({
  id: ShopifySessionId,
  shop: ShopDomain,
  payload: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type ShopifySession = typeof ShopifySession.Type;
