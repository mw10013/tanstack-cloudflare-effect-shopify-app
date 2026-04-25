/**
 * Export Shopify cookies from Chrome's local cookie database to Playwright storage state.
 * Does NOT require restarting Chrome or enabling remote debugging.
 *
 * Usage: node scripts/chrome-cookies-to-storage-state.ts
 * Output: playwright/.auth/shopify-admin.json
 *
 * macOS only. Reads Chrome's encrypted SQLite cookie database.
 * Prompts for Keychain access on first run — click "Allow".
 */

import { execSync } from "child_process";
import { copyFileSync, existsSync, writeFileSync } from "fs";
import { pbkdf2Sync, createDecipheriv } from "crypto";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(__dirname, "..", "playwright", ".auth", "shopify-admin.json");

const chromeCookiesPath = path.join(
  process.env["HOME"] ?? "",
  "Library/Application Support/Google/Chrome/Default/Cookies",
);

const pass = execSync('security find-generic-password -w -s "Chrome Safe Storage"', {
  encoding: "utf8",
}).trim();

const key = pbkdf2Sync(pass, "saltysalt", 1003, 16, "sha1");
const iv = Buffer.alloc(16, 0x20);

function decrypt(enc: Uint8Array): string {
  const buf = Buffer.from(enc);
  if (buf.length < 3 || buf.subarray(0, 3).toString() !== "v10") return buf.toString("utf8");
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]).subarray(32).toString("utf8");
}

const tmpPath = path.join(tmpdir(), `chrome-cookies-${Date.now().toString()}.db`);
copyFileSync(chromeCookiesPath, tmpPath);
const walSrc = `${chromeCookiesPath}-wal`;
if (existsSync(walSrc)) copyFileSync(walSrc, `${tmpPath}-wal`);

const db = new DatabaseSync(tmpPath);
const stmt = db.prepare(`
  select name, value, encrypted_value, host_key, path, is_secure, is_httponly, samesite, expires_utc, has_expires
  from cookies
  where host_key in ('.shopify.com', 'admin.shopify.com', 'accounts.shopify.com')
`);
stmt.setReadBigInts(true);

interface CookieRow {
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  host_key: string;
  path: string;
  is_secure: bigint;
  is_httponly: bigint;
  samesite: bigint;
  expires_utc: bigint;
  has_expires: bigint;
}

const sameSiteMap: Record<string, string> = { "-1": "Lax", "0": "None", "1": "Lax", "2": "Strict" };
const chromeEpochOffset = 11_644_473_600n;

const cookies = (stmt.all() as unknown as CookieRow[]).map(
  ({ name, value, encrypted_value, host_key, path: p, is_secure, is_httponly, samesite, expires_utc, has_expires }) => ({
    name,
    value: encrypted_value.length > 0 ? decrypt(encrypted_value) : value,
    domain: host_key,
    path: p,
    secure: is_secure === 1n,
    httpOnly: is_httponly === 1n,
    sameSite: sameSiteMap[samesite.toString()] ?? "Lax",
    expires: has_expires === 1n ? Number(expires_utc / 1_000_000n - chromeEpochOffset) : -1,
  }),
);

db.close();

writeFileSync(outputPath, JSON.stringify({ cookies, origins: [] }, null, 2));
console.log(`Wrote ${cookies.length.toString()} cookies to ${outputPath}`);
