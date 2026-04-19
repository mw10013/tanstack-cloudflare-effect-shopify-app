# shopify.app.toml and shopify.web.toml Placement

## What happened

Both config files were committed under `.shopify-cli/` (a non-standard directory), and `package.json` scripts used `--path .shopify-cli` to point the CLI there. The `.shopify-cli/` name was a mistake — likely chosen to signal "Shopify CLI config" but it's not a special directory the CLI looks for.

As a side effect, `shopify app dev` created its runtime state at `.shopify-cli/.shopify/` (relative to where it found `shopify.app.toml`) instead of `.shopify/` at the project root.

**Fixed:** both files are now at the project root and `--path .shopify-cli` removed from all scripts.

---

## Where these files belong

### shopify.app.toml

The primary app configuration file. Shopify CLI reads and writes it at the project root.

- `shopify app config link` — creates/overwrites it at root, pulls from Partner Dashboard
- `shopify app config pull` — updates it from the linked app
- `shopify app deploy` — reads it to push config to Partner Dashboard (`include_config_on_deploy = true`)
- Belongs in git; is the source of truth for app config

Template reference: `refs/shopify-app-template/shopify.app.toml` is at root. Template `.gitignore` ignores `.shopify/*` (runtime state) but commits `shopify.app.toml`.

### shopify.web.toml

Tells `shopify app dev` how to start the app: `commands.dev`, port, roles, webhook reset path.

From `refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md`:
> The CLI expects at least one `shopify.web.toml` with `roles` including `frontend`, or with no type/roles specified. **This file can be at the root of the project, or in a project subdirectory.**

Key fields:

| Field | Required | Description |
|---|---|---|
| `roles` | No | `["frontend", "backend", "background"]` |
| `webhooks_path` | No | Path for `dev --reset` uninstall webhook |
| `port` | No | Fixed port; random if unset |
| `commands.dev` | **Yes** | Run by `shopify app dev` |
| `commands.build` | No | Run by `shopify app build` |

Template ships `shopify.web.toml.liquid` (scaffold template rendered to `shopify.web.toml` at root).

### .shopify/ (runtime state — not committed)

Created by the CLI at runtime alongside `shopify.app.toml`. Contains:

- `project.json` — maps `client_id` → dev store URL
- `dev-bundle/` — compiled app config bundle from last `shopify app dev` run
- `.gitignore` (ignores `*`) — written by CLI itself

Both `.shopify/` and `.shopify-cli/` are now in `.gitignore`.

---

## Re-linking after the move

The `.shopify/project.json` at root is empty (`{}`), so the CLI has lost its dev store association. On next `shopify app dev`:

1. CLI will find `shopify.app.toml` at root, read `client_id`
2. Prompt: "Which store do you want to use?" → enter `sandbox-shop-01.myshopify.com`
3. CLI writes the association to `.shopify/project.json` and proceeds

No full re-link or redeploy is needed for dev. For production, `shopify app deploy` works normally from the root-level config.

**Optional:** to pre-populate the dev store without running `shopify app dev`:
```sh
pnpm shopify:config:link --client-id 9a91c9ff6ba488dafb39a7c696429753
```

---

## Cleanup steps (one-time, after committing)

Remove the now-untracked `.shopify-cli/` directory from disk:

```sh
rm -rf .shopify-cli
```

The `.shopify/` at root is already ignored and will be recreated by the CLI on next `shopify app dev`.
