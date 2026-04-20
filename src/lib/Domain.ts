import { Schema } from "effect";

export const Shop = Schema.NonEmptyString.pipe(
  Schema.brand("Shop"),
);
export type Shop = typeof Shop.Type;

export const SessionId = Schema.NonEmptyString.pipe(
  Schema.brand("SessionId"),
);
export type SessionId = typeof SessionId.Type;

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
