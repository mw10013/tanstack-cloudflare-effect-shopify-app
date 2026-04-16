# SQLite Schema Migrations

## Overview

Schema migrations in Durable Objects are handled in code, NOT via wrangler. Wrangler migrations only manage class-level operations (creating, renaming, transferring, or deleting Durable Object classes).

## Migration Strategy

### Using PRAGMA user_version

The recommended approach uses SQLite's built-in `PRAGMA user_version` to track schema versions:

```typescript
import { DurableObject } from "cloudflare:workers";

export class ChatRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // blockConcurrencyWhile() ensures no requests are processed until this completes
    ctx.blockConcurrencyWhile(async () => {
      await this.migrate();
    });
  }

  private async migrate() {
    // Check current schema version
    const version =
      this.ctx.storage.sql
        .exec<{ version: number }>("PRAGMA user_version")
        .one()?.version ?? 0;

    if (version < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
        PRAGMA user_version = 1;
      `);
    }

    if (version < 2) {
      // Future migration: add a new column
      this.ctx.storage.sql.exec(`
        ALTER TABLE messages ADD COLUMN edited_at INTEGER;
        PRAGMA user_version = 2;
      `);
    }
  }
}
```

### How PRAGMA user_version Works

- **Storage:** SQLite reserves a 4-byte integer in the database header
- **Default:** 0 on new databases
- **Set:** `PRAGMA user_version = N`
- **Query:** `PRAGMA user_version`
- **Persistence:** Survives restarts, evictions, and crashes

## Alternative: Try-Catch with Duplicate Column Detection

For simple additive migrations, you can use error handling:

```typescript
const addColumnIfNotExists = (sql: string) => {
  try {
    this.ctx.storage.sql.exec(sql);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Only ignore "duplicate column" errors
    if (!message.toLowerCase().includes("duplicate column")) {
      throw e;
    }
  }
};

// Safe to run multiple times
addColumnIfNotExists("ALTER TABLE users ADD COLUMN age INTEGER");
addColumnIfNotExists("ALTER TABLE users ADD COLUMN city TEXT");
```

## blockConcurrencyWhile() Guidelines

**Purpose:** Blocks all concurrent requests during initialization/migration

**Use sparingly:**

- Reduces throughput (~200 req/sec if migration takes 5ms)
- Only use for initialization and schema migrations
- Do NOT use across I/O operations (fetch, KV, R2, external APIs)

**Best practice:**

```typescript
constructor(ctx: DurableObjectState, env: Env) {
  super(ctx, env);

  ctx.blockConcurrencyWhile(async () => {
    // Fast operations only: schema setup, state initialization
    await this.migrate();
    this.state = this.loadState();
  });
}
```

## Migration Types Reference

| Migration Type        | Where          | Purpose                                            |
| --------------------- | -------------- | -------------------------------------------------- |
| `new_sqlite_classes`  | wrangler.jsonc | Create new DO/Agent with SQLite                    |
| `renamed_classes`     | wrangler.jsonc | Rename class (same Worker)                         |
| `transferred_classes` | wrangler.jsonc | Transfer between classes (different Workers)       |
| `deleted_classes`     | wrangler.jsonc | Delete class and all data                          |
| Schema migrations     | Code           | Table/column changes via `blockConcurrencyWhile()` |

## Important Constraints

1. **Cannot convert KV to SQLite** - Must be configured from the start
2. **Migrations are atomic** - Cannot be gradually deployed
3. **Never modify existing migrations** - Always add new ones with unique tags
4. **Idempotent operations** - Use `IF NOT EXISTS` for CREATE statements

## Example: Complete Migration Flow

```typescript
export class MyAgent extends Agent<Env> {
  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      await this.runMigrations();
    });
  }

  private async runMigrations() {
    const version =
      this.ctx.storage.sql
        .exec<{ version: number }>("PRAGMA user_version")
        .one()?.version ?? 0;

    if (version < 1) {
      // Initial schema
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY DEFAULT (randomblob(9)),
          name TEXT NOT NULL,
          created_at INTEGER DEFAULT (unixepoch())
        );
        PRAGMA user_version = 1;
      `);
    }

    if (version < 2) {
      // Add email column
      this.ctx.storage.sql.exec(`
        ALTER TABLE users ADD COLUMN email TEXT;
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
        PRAGMA user_version = 2;
      `);
    }

    if (version < 3) {
      // Add posts table
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS posts (
          id TEXT PRIMARY KEY DEFAULT (randomblob(9)),
          user_id TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()),
          FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id);
        PRAGMA user_version = 3;
      `);
    }
  }
}
```

## References

- [Rules of Durable Objects - Migrations](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Durable Objects Migrations Reference](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
