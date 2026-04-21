# Shopify Local Dev Env Injection Research

## Question

Why does local dev work even though this repo does not define `SHOPIFY_API_KEY` or `SHOPIFY_API_SECRET` in `.env` or `.env.example`, and why does adding those vars as empty strings break `shopify app dev`?

## Short Answer

- `shopify app dev` is documented to inject `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `HOST`/`APP_URL`, ports, and scopes into the process started from `shopify.web.toml`.
- This repo relies on that injection for local dev.
- `shopify.web.toml` sets `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`, which lets Cloudflare local dev include those process env vars.
- `.env` only contains `PORT`, so today it does not overwrite the Shopify-injected values.
- If `.env` defines `SHOPIFY_API_KEY` or `SHOPIFY_API_SECRET` as empty strings, the break happens before Cloudflare merges anything: `package.json` explicitly runs `set -a && source .env && set +a`, so the shell replaces the injected values with empty strings before `vite dev` starts.

## Repo Facts

`src/lib/Shopify.ts` requires the API key and secret as non-empty values, and accepts app URL from three possible env vars:

```ts
const shopifyConfig = Config.all({
  apiKey: Config.nonEmptyString("SHOPIFY_API_KEY").pipe(
    Config.map(Redacted.make),
  ),
  apiSecretKey: Config.nonEmptyString("SHOPIFY_API_SECRET").pipe(
    Config.map(Redacted.make),
  ),
  appUrl: Config.nonEmptyString("SHOPIFY_APP_URL").pipe(
    Config.orElse(() => Config.nonEmptyString("APP_URL")),
    Config.orElse(() => Config.nonEmptyString("HOST")),
  ),
});
```

Current local files are intentionally minimal:

```txt
.env.example
PORT=3200

.env
PORT=3200
```

`shopify.web.toml` starts the dev server like this:

```toml
[commands]
dev = "env CLOUDFLARE_INCLUDE_PROCESS_ENV=true pnpm dev"
```

`package.json` then exports `.env` into the shell before starting Vite:

```json
"dev": "mkdir -p logs && set -a && source .env && set +a && vite dev --port $PORT --force 2>&1 | tee logs/server.log"
```

## What Shopify CLI Documents

From `refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md`:

> The following information is provided to the process as environment variables:
>
> - `SHOPIFY_API_KEY`: The client ID of the app.
> - `SHOPIFY_API_SECRET`: The client secret of the app.
> - `HOST`/`APP_URL`: The URL that stores will load.
> - `PORT`/`FRONTEND_PORT`/`SERVER_PORT`: The port in which the process' server should run.
> - `SCOPES`: The app's access scopes.

That text appears under the `shopify.web.toml` web-process conventions. So the current local setup is not undocumented luck; Shopify CLI explicitly says these vars are provided to the process started by `commands.dev`.

Shopify's app runtime docs also assume these env vars exist:

```ts
const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  appUrl: process.env.SHOPIFY_APP_URL!,
});
```

That matches how this repo reads `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`.

## What Cloudflare Docs Say

From `refs/cloudflare-docs/src/content/partials/workers/secrets-in-dev.mdx`:

> Choose to use either `.dev.vars` or `.env` but not both.

and:

> To include every environment variable defined in your system's process environment as a local development variable, ensure there is no `.dev.vars` and then set the `CLOUDFLARE_INCLUDE_PROCESS_ENV` environment variable to `"true"`.

This repo matches that guidance exactly:

- there is no `.dev.vars`
- `.env` is present
- `shopify.web.toml` sets `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`

So Cloudflare local dev is intentionally configured to expose the env vars Shopify CLI injected into the parent process.

## The Actual Runtime Chain

This is the local sequence when running `shopify app dev`:

1. Shopify CLI finds `shopify.web.toml`.
2. Shopify CLI runs `commands.dev` and injects `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `HOST`/`APP_URL`, ports, and scopes into that process environment.
3. `commands.dev` launches `pnpm dev` with `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`.
4. `pnpm dev` runs `set -a && source .env && set +a`.
5. Because `.env` only contains `PORT`, the shell keeps Shopify's injected key/secret/url vars intact and adds `PORT`.
6. `vite dev` starts.
7. Cloudflare local dev includes the process environment because `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`.
8. `src/lib/Shopify.ts` reads:
   - `SHOPIFY_API_KEY`
   - `SHOPIFY_API_SECRET`
   - `SHOPIFY_APP_URL`, else `APP_URL`, else `HOST`

That is why the current setup works.

## Why Empty Strings In `.env` Break

The important nuance: the break is not primarily that Cloudflare gives `.env` higher precedence than `process.env`.

Wrangler source says the opposite when `includeProcessEnv` is enabled. In `refs/workers-sdk/packages/wrangler/src/config/dot-env.ts`:

```ts
const expandedEnv = {};
if (includeProcessEnv) {
  Object.assign(expandedEnv, process.env);
}
dotenvExpand.expand({
  processEnv: expandedEnv,
  parsed: parsedEnv,
});
```

The nearby comment says expanded `.env` values are added only if the key is not already defined in `expandedEnv`. So inside Wrangler's local env merge, `process.env` wins.

The real overwrite happens earlier in this repo's own shell command:

```json
"dev": "... set -a && source .env && set +a && vite dev ..."
```

If `.env` contains:

```txt
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
```

then `source .env` sets those shell variables to empty strings in the current process. Since the shell is the process that later launches `vite dev`, the Shopify-injected values are already gone by the time Cloudflare reads `process.env`.

So the failure mode is:

1. Shopify CLI injects real values.
2. `source .env` replaces them with empty strings.
3. `Config.nonEmptyString("SHOPIFY_API_KEY")` / `Config.nonEmptyString("SHOPIFY_API_SECRET")` fails.

## What About `SHOPIFY_APP_URL`

This repo is a little more careful for app URL than for key/secret.

`src/lib/Shopify.ts` resolves URL from:

1. `SHOPIFY_APP_URL`
2. `APP_URL`
3. `HOST`

That makes sense for mixed environments:

- pulled or deployed configs can provide `SHOPIFY_APP_URL`
- `shopify app dev` is documented to provide `HOST`/`APP_URL`

But defining a non-empty `SHOPIFY_APP_URL` in `.env` would make local dev less dynamic, because it would win over Shopify CLI's run-specific tunnel URL.

So even though the repo can read `SHOPIFY_APP_URL`, it is still reasonable to avoid putting that in the default local `.env` used by `shopify app dev`.

## What `shopify app env pull` Changes

From `refs/shopify-docs/docs/api/shopify-cli/app/app-env-pull.md`:

> Creates or updates an `.env` files that contains app and app extension environment variables.

and:

> Existing variables and commented variables are preserved.

So `shopify app env pull` is the documented way to materialize Shopify env vars into a file. That is different from `shopify app dev`, which documents that it provides env vars to the running web process.

This means there are really two separate mechanisms:

- `shopify app dev`: inject env vars into the running process
- `shopify app env pull`: persist env vars into an `.env` file

## Recommendation

Current recommendation: keep the existing behavior and document it.

- Do not add `SHOPIFY_API_KEY=` or `SHOPIFY_API_SECRET=` placeholders to `.env.example`.
- Do not add blank `SHOPIFY_API_KEY` or `SHOPIFY_API_SECRET` entries to `.env`.
- Keep `.env` focused on repo-owned values that are not supplied by Shopify CLI during `shopify app dev`, currently `PORT`.
- Keep `SHOPIFY_APP_URL` out of the default local `.env` so local dev continues to use the dynamic tunnel URL from Shopify CLI.

This is a little magical, but it is consistent with the documented responsibilities of Shopify CLI and Cloudflare local dev.

## If We Want Less Magic Later

If the team wants the setup to feel less implicit without changing runtime behavior, the safest low-effort options are:

1. Keep this doc and add a short README note that local `shopify app dev` relies on Shopify CLI env injection.
2. Use `shopify app env show` or `shopify app info --web-env` when debugging which Shopify env vars exist.
3. If persistent env materialization is needed for CI or non-`shopify app dev` flows, use `shopify app env pull --env-file <some-separate-file>` instead of adding blank placeholders to the default `.env`.

## Bottom Line

The current setup is not random magic.

- Shopify CLI is supposed to inject the key/secret/url-related vars into the `shopify.web.toml` dev process.
- Cloudflare is explicitly configured to include those process env vars.
- The repo's `.env` stays out of the way by only defining `PORT`.

The one truly fragile part is the shell-level `source .env` step: any blank Shopify vars added there will override the injected values before the app even starts.
