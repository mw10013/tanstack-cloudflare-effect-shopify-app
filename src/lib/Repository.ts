import type * as ShopifyApi from "@shopify/shopify-api";
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
    )(function* (id: string) {
      const row = yield* d1.first<Record<string, unknown>>(
        d1
          .prepare(
            "select id, shop, payload, createdAt, updatedAt from ShopifySession where id = ?1",
          )
          .bind(id),
      );
      if (Option.isNone(row)) {
        return Option.none();
      }
      return yield* decodeShopifySession(row.value).pipe(
        Effect.map(Option.some),
        Effect.catchTag("RepositoryError", () => Effect.succeed(Option.none())),
      );
    });
    const upsertShopifySession = Effect.fn("Repository.upsertShopifySession")(
      function* (session: ShopifyApi.Session) {
        yield* d1.run(
          d1
            .prepare(
              `
insert into ShopifySession (id, shop, payload)
values (?1, ?2, ?3)
on conflict(id) do update set
  shop = excluded.shop,
  payload = excluded.payload,
  updatedAt = datetime('now')
`,
            )
            .bind(
              session.id,
              session.shop,
              JSON.stringify(session.toPropertyArray(true)),
            ),
        );
      },
    );
    const deleteShopifySessionsByShop = Effect.fn(
      "Repository.deleteShopifySessionsByShop",
    )(function* (shop: string) {
      yield* d1.run(
        d1.prepare("delete from ShopifySession where shop = ?1").bind(shop),
      );
    });
    const updateShopifySessionPayload = Effect.fn(
      "Repository.updateShopifySessionPayload",
    )(function* ({ id, payload }: { id: string; payload: string }) {
      yield* d1.run(
        d1
          .prepare(
            "update ShopifySession set payload = ?1, updatedAt = datetime('now') where id = ?2",
          )
          .bind(payload, id),
      );
    });
    return {
      upsertShopifySession,
      findShopifySessionById,
      deleteShopifySessionsByShop,
      updateShopifySessionPayload,
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
