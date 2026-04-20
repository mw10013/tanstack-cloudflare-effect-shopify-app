import { Context, Effect, Layer, Option, Schema } from "effect";

import * as Domain from "@/lib/Domain";
import { D1 } from "@/lib/D1";

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()(
  "RepositoryError",
  {
    message: Schema.String,
    cause: Schema.Defect,
  },
) {}

export class Repository extends Context.Service<Repository>()("Repository", {
  make: Effect.gen(function* () {
    const d1 = yield* D1;
    const decodeShopifySession = (input: unknown) =>
      Schema.decodeUnknownEffect(Domain.ShopifySession)(input).pipe(
        Effect.mapError(
          (cause) =>
            new RepositoryError({ message: "Invalid ShopifySession row", cause }),
        ),
      );
    const findShopifySessionById = Effect.fn(
      "Repository.findShopifySessionById",
    )(function* (id: Domain.ShopifySession["id"]) {
      const row = yield* d1.first<Record<string, unknown>>(
        d1
          .prepare("select * from ShopifySession where id = ?1")
          .bind(id),
      );
      if (Option.isNone(row)) return Option.none();
      return yield* decodeShopifySession(row.value).pipe(
        Effect.map(Option.some),
        Effect.catchTag("RepositoryError", () => Effect.succeed(Option.none())),
      );
    });
    const findShopifySessionsByShop = Effect.fn(
      "Repository.findShopifySessionsByShop",
    )(function* (shop: Domain.ShopifySession["shop"]) {
      const result = yield* d1.run<Record<string, unknown>>(
        d1.prepare("select * from ShopifySession where shop = ?1").bind(shop),
      );
      return yield* Effect.all(
        result.results.map((row) =>
          decodeShopifySession(row).pipe(
            Effect.catchTag("RepositoryError", () =>
              Effect.succeed(null as Domain.ShopifySession | null),
            ),
          ),
        ),
      ).pipe(
        Effect.map((rows) =>
          rows.filter((r): r is Domain.ShopifySession => r !== null),
        ),
      );
    });
    const upsertShopifySession = Effect.fn("Repository.upsertShopifySession")(
      function* (row: Domain.ShopifySession) {
        yield* d1.run(
          d1
            .prepare(
              `insert into ShopifySession (id, shop, state, isOnline, scope, expires, accessToken, userId, firstName, lastName, email, accountOwner, locale, collaborator, emailVerified, refreshToken, refreshTokenExpires)
values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
on conflict(id) do update set
  shop = excluded.shop,
  state = excluded.state,
  isOnline = excluded.isOnline,
  scope = excluded.scope,
  expires = excluded.expires,
  accessToken = excluded.accessToken,
  userId = excluded.userId,
  firstName = excluded.firstName,
  lastName = excluded.lastName,
  email = excluded.email,
  accountOwner = excluded.accountOwner,
  locale = excluded.locale,
  collaborator = excluded.collaborator,
  emailVerified = excluded.emailVerified,
  refreshToken = excluded.refreshToken,
  refreshTokenExpires = excluded.refreshTokenExpires`,
            )
            .bind(
              row.id,
              row.shop,
              row.state,
              row.isOnline,
              row.scope,
              row.expires,
              row.accessToken,
              row.userId,
              row.firstName,
              row.lastName,
              row.email,
              row.accountOwner,
              row.locale,
              row.collaborator,
              row.emailVerified,
              row.refreshToken,
              row.refreshTokenExpires,
            ),
        );
      },
    );
    const deleteShopifySessionById = Effect.fn(
      "Repository.deleteShopifySessionById",
    )(function* (id: Domain.ShopifySession["id"]) {
      yield* d1.run(
        d1.prepare("delete from ShopifySession where id = ?1").bind(id),
      );
    });
    const deleteShopifySessionsByIds = Effect.fn(
      "Repository.deleteShopifySessionsByIds",
    )(function* (ids: readonly Domain.ShopifySession["id"][]) {
      if (ids.length === 0) return;
      const placeholders = ids.map((_, i) => `?${String(i + 1)}`).join(", ");
      yield* d1.run(
        d1
          .prepare(`delete from ShopifySession where id in (${placeholders})`)
          .bind(...ids),
      );
    });
    const deleteShopifySessionsByShop = Effect.fn(
      "Repository.deleteShopifySessionsByShop",
    )(function* (shop: Domain.ShopifySession["shop"]) {
      yield* d1.run(
        d1.prepare("delete from ShopifySession where shop = ?1").bind(shop),
      );
    });
    const updateShopifySessionScope = Effect.fn(
      "Repository.updateShopifySessionScope",
    )(function* (id: Domain.ShopifySession["id"], scope: Domain.ShopifySession["scope"]) {
      yield* d1.run(
        d1
          .prepare("update ShopifySession set scope = ?1 where id = ?2")
          .bind(scope, id),
      );
    });
    return {
      findShopifySessionById,
      findShopifySessionsByShop,
      upsertShopifySession,
      deleteShopifySessionById,
      deleteShopifySessionsByIds,
      deleteShopifySessionsByShop,
      updateShopifySessionScope,
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
