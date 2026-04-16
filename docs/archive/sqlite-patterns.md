# SQLite Patterns and Best Practices

## Table Creation Patterns

### Idempotent CREATE TABLE

Always use `IF NOT EXISTS` to make table creation safe to run on every DO activation:

```typescript
this.ctx.storage.sql.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY DEFAULT (randomblob(9)),
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  )
`);
```

### Indexes

Create indexes for frequently queried columns:

```typescript
this.ctx.storage.sql.exec(`
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);
`);
```

## Query Patterns

### Parameterized Queries

Always use parameterized queries to prevent SQL injection:

```typescript
// Good - uses parameters
const user = this.ctx.storage.sql
  .exec(`SELECT * FROM users WHERE email = ?`, email)
  .one();

// Or with Agents SQL template tag
const user = this.sql`SELECT * FROM users WHERE email = ${email}`.at(0);
```

### Batch Operations

For batch inserts, use multiple VALUES clauses or transactions:

```typescript
// Multiple inserts in one statement
const values = users.map((u) => `(?, ?, ?)`).join(", ");
const params = users.flatMap((u) => [u.name, u.email, u.age]);

this.ctx.storage.sql.exec(
  `INSERT INTO users (name, email, age) VALUES ${values}`,
  ...params,
);
```

### Querying with Limits

```typescript
// Paginated query
const page = this.ctx.storage.sql.exec(
  `SELECT * FROM posts ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  pageSize,
  offset,
);
```

## Data Types

### Timestamps

Use `unixepoch()` for automatic timestamp generation:

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY DEFAULT (randomblob(9)),
  name TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);
```

### JSON Storage

Store JSON as TEXT and parse/stringify in code:

```typescript
// Store
this.ctx.storage.sql.exec(
  `INSERT INTO data (id, payload) VALUES (?, ?)`,
  id,
  JSON.stringify(payload),
);

// Retrieve
const row = this.ctx.storage.sql
  .exec(`SELECT payload FROM data WHERE id = ?`, id)
  .one();
const payload = JSON.parse(row.payload);
```

### Binary Data

Use BLOB for binary data (respects 2MB limit):

```typescript
this.ctx.storage.sql.exec(
  `INSERT INTO files (id, content) VALUES (?, ?)`,
  id,
  binaryData, // Uint8Array or ArrayBuffer
);
```

## Transaction Patterns

SQLite in Durable Objects supports transactions:

```typescript
this.ctx.storage.sql.exec(`
  BEGIN TRANSACTION;
  INSERT INTO accounts (user_id, balance) VALUES ('user1', 100);
  INSERT INTO accounts (user_id, balance) VALUES ('user2', 200);
  COMMIT;
`);
```

## Error Handling

### Expected Errors

For migrations where errors are expected (e.g., column already exists):

```typescript
const addColumnSafe = (sql: string) => {
  try {
    this.ctx.storage.sql.exec(sql);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("duplicate column")) return; // Expected
    throw e; // Unexpected
  }
};
```

### Query Error Handling

```typescript
try {
  const result = this.ctx.storage.sql
    .exec(`SELECT * FROM users WHERE id = ?`, userId)
    .one();
  return result;
} catch (e) {
  if (e.message.includes("no such table")) {
    // Handle missing table
    return null;
  }
  throw e;
}
```

## Performance Tips

### 1. Use Appropriate Indexes

```sql
-- Good for lookups
CREATE INDEX idx_users_email ON users(email);

-- Good for range queries
CREATE INDEX idx_events_time ON events(created_at);

-- Composite index for multi-column queries
CREATE INDEX idx_posts_user_time ON posts(user_id, created_at);
```

### 2. Limit Result Sets

```typescript
// Always limit large queries
const recent = this.ctx.storage.sql.exec(
  `SELECT * FROM logs ORDER BY created_at DESC LIMIT 100`,
);
```

### 3. Batch Operations

```typescript
// Batch delete old records
this.ctx.storage.sql.exec(
  `DELETE FROM logs WHERE created_at < ?`,
  cutoffTimestamp,
);
```

### 4. Avoid N+1 Queries

```typescript
// Bad: N+1 queries
const users = this.ctx.storage.sql.exec(`SELECT * FROM users`);
for (const user of users) {
  const posts = this.ctx.storage.sql.exec(
    `SELECT * FROM posts WHERE user_id = ?`,
    user.id,
  );
}

// Good: Single JOIN query
const results = this.ctx.storage.sql.exec(`
  SELECT users.*, posts.* 
  FROM users 
  LEFT JOIN posts ON users.id = posts.user_id
`);
```

## Migration Best Practices

### Version Tracking

Use `PRAGMA user_version` for schema versioning:

```typescript
private async migrate() {
  const version = this.ctx.storage.sql
    .exec<{ version: number }>("PRAGMA user_version")
    .one()?.version ?? 0;

  if (version < 1) {
    this.ctx.storage.sql.exec(`-- v1 schema... PRAGMA user_version = 1;`);
  }

  if (version < 2) {
    this.ctx.storage.sql.exec(`-- v2 migration... PRAGMA user_version = 2;`);
  }
}
```

### Additive Changes Only

Never modify existing migrations. Always add new ones:

```typescript
// Good: Additive only
if (version < 3) {
  this.ctx.storage.sql.exec(`
    ALTER TABLE users ADD COLUMN avatar_url TEXT;
    PRAGMA user_version = 3;
  `);
}
```

## Testing

### Inspect Tables

```typescript
// List all tables
const tables = [
  ...this.ctx.storage.sql.exec(
    `SELECT name FROM sqlite_master WHERE type='table'`,
  ),
];

// Get table schema
const schema = [...this.ctx.storage.sql.exec(`PRAGMA table_info(users)`)];
```

### Reset for Testing

```typescript
// Drop all tables (testing only)
this.ctx.storage.sql.exec(`
  DROP TABLE IF EXISTS users;
  DROP TABLE IF EXISTS posts;
  PRAGMA user_version = 0;
`);
```

## References

- [SQLite Best Practices](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [SQLite Query Language](https://www.sqlite.org/lang.html)
