import { Schema } from "effect";

export const ShopifySessionId = Schema.NonEmptyString.pipe(
  Schema.brand("ShopifySessionId"),
);
export type ShopifySessionId = typeof ShopifySessionId.Type;

export const Shop = Schema.NonEmptyString.pipe(
  Schema.brand("Shop"),
);
export type Shop = typeof Shop.Type;

export const ShopifySession = Schema.Struct({
  id: ShopifySessionId,
  shop: Shop,
  state: Schema.String,
  isOnline: Schema.Number,
  scope: Schema.NullOr(Schema.String),
  expires: Schema.NullOr(Schema.Number),
  accessToken: Schema.NullOr(Schema.String),
  userId: Schema.NullOr(Schema.Number),
  firstName: Schema.NullOr(Schema.String),
  lastName: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  accountOwner: Schema.NullOr(Schema.Number),
  locale: Schema.NullOr(Schema.String),
  collaborator: Schema.NullOr(Schema.Number),
  emailVerified: Schema.NullOr(Schema.Number),
  refreshToken: Schema.NullOr(Schema.String),
  refreshTokenExpires: Schema.NullOr(Schema.Number),
});
export type ShopifySession = typeof ShopifySession.Type;
