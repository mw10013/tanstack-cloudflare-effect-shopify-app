import { Schema } from "effect";

export const Shop = Schema.NonEmptyString.pipe(
  Schema.brand("Shop"),
);
export type Shop = typeof Shop.Type;

export const SessionId = Schema.NonEmptyString.pipe(
  Schema.brand("SessionId"),
);
export type SessionId = typeof SessionId.Type;

export const ProductId = Schema.NonEmptyString.pipe(Schema.brand("ProductId"));
export type ProductId = typeof ProductId.Type;

export const VariantId = Schema.NonEmptyString.pipe(Schema.brand("VariantId"));
export type VariantId = typeof VariantId.Type;

export const ProductStatus = Schema.Literals(["ACTIVE", "DRAFT", "ARCHIVED", "UNLISTED"]);
export type ProductStatus = typeof ProductStatus.Type;

export const ProductVariant = Schema.Struct({
  id: VariantId,
  price: Schema.String,
  barcode: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});
export type ProductVariant = typeof ProductVariant.Type;

export const Product = Schema.Struct({
  id: ProductId,
  title: Schema.String,
  handle: Schema.String,
  status: ProductStatus,
  variants: Schema.Struct({
    edges: Schema.Array(Schema.Struct({ node: ProductVariant })),
  }),
});
export type Product = typeof Product.Type;

export const Session = Schema.Struct({
  id: SessionId,
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
export type Session = typeof Session.Type;
