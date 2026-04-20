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
    const decodeSession = (input: unknown) =>
      Schema.decodeUnknownEffect(Domain.Session)(input).pipe(
        Effect.mapError(
          (cause) =>
            new RepositoryError({ message: "Invalid Session row", cause }),
        ),
      );
    const findSessionById = Effect.fn("Repository.findSessionById")(function* (
      id: Domain.Session["id"],
    ) {
      const row = yield* d1.first<Record<string, unknown>>(
        d1.prepare("select * from Session where id = ?1").bind(id),
      );
      if (Option.isNone(row)) return Option.none();
      return yield* decodeSession(row.value).pipe(
        Effect.map(Option.some),
        Effect.catchTag("RepositoryError", () => Effect.succeed(Option.none())),
      );
    });
    const findSessionsByShop = Effect.fn("Repository.findSessionsByShop")(
      function* (shop: Domain.Session["shop"]) {
        const result = yield* d1.run<Record<string, unknown>>(
          d1.prepare("select * from Session where shop = ?1").bind(shop),
        );
        return yield* Effect.all(
          result.results.map((row) =>
            decodeSession(row).pipe(
              Effect.catchTag("RepositoryError", () =>
                Effect.succeed(null as Domain.Session | null),
              ),
            ),
          ),
        ).pipe(
          Effect.map((rows) =>
            rows.filter((r): r is Domain.Session => r !== null),
          ),
        );
      },
    );
    const upsertSession = Effect.fn("Repository.upsertSession")(
      function* (row: Domain.Session) {
        yield* d1.run(
          d1
            .prepare(
              `insert into Session (id, shop, state, isOnline, scope, expires, accessToken, userId, firstName, lastName, email, accountOwner, locale, collaborator, emailVerified, refreshToken, refreshTokenExpires)
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
    const deleteSessionById = Effect.fn("Repository.deleteSessionById")(
      function* (id: Domain.Session["id"]) {
        yield* d1.run(
          d1.prepare("delete from Session where id = ?1").bind(id),
        );
      },
    );
    const deleteSessionsByIds = Effect.fn("Repository.deleteSessionsByIds")(
      function* (ids: readonly Domain.Session["id"][]) {
        if (ids.length === 0) return;
        const placeholders = ids.map((_, i) => `?${String(i + 1)}`).join(", ");
        yield* d1.run(
          d1
            .prepare(`delete from Session where id in (${placeholders})`)
            .bind(...ids),
        );
      },
    );
    const deleteSessionsByShop = Effect.fn("Repository.deleteSessionsByShop")(
      function* (shop: Domain.Session["shop"]) {
        yield* d1.run(
          d1.prepare("delete from Session where shop = ?1").bind(shop),
        );
      },
    );
    const updateSessionScope = Effect.fn("Repository.updateSessionScope")(
      function* (id: Domain.Session["id"], scope: Domain.Session["scope"]) {
        yield* d1.run(
          d1
            .prepare("update Session set scope = ?1 where id = ?2")
            .bind(scope, id),
        );
      },
    );
    return {
      findSessionById,
      findSessionsByShop,
      upsertSession,
      deleteSessionById,
      deleteSessionsByIds,
      deleteSessionsByShop,
      updateSessionScope,
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
