import { Schema } from "effect";

export const ShopifySessionId = Schema.NonEmptyString.pipe(
  Schema.brand("ShopifySessionId"),
);
export type ShopifySessionId = typeof ShopifySessionId.Type;

export const ShopDomain = Schema.NonEmptyString.pipe(
  Schema.brand("ShopDomain"),
);
export type ShopDomain = typeof ShopDomain.Type;

/**
 * Canonical in-memory shape for the JSON payload stored in `ShopifySession`.
 *
 * The domain model keeps this readonly. Shopify's mutable tuple-array typing is
 * handled at the integration boundary in `Shopify.ts`.
 */
const ShopifySessionPayloadEntries = Schema.Array(
  Schema.Tuple([
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
  ]),
);

/**
 * D1 stores the Shopify session payload as a JSON string, but the decoded
 * domain value is the readonly tuple array representation of that payload.
 */
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
