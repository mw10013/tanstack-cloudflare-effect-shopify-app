import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

const ORIGIN = "https://shopify.dev";
const OUTPUT_ROOT = path.join("refs", "shopify-docs");
const ADMIN_PREFIX = `${ORIGIN}/docs/api/admin-graphql/latest`;
const APPS_BUILD_PREFIX = `${ORIGIN}/docs/apps/build`;
const SITEMAP_URL = `${ORIGIN}/sitemap_standard.xml.gz`;
const USER_AGENT = "product-health-check/refs-shopify-docs";

type DocSection = "admin-graphql" | "apps-build";

interface SavedDoc {
  url: string;
  markdownUrl: string;
  localPath: string;
  section: DocSection;
  fetchedAt: string;
}

function canonicalizeDocUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // oxlint-disable-next-line prefer-string-replace-all
const cleaned = trimmed.replace(/^<|>$/g, "").replace(/[),.;]+$/, "");

  let url: URL;
  try {
    url = new URL(cleaned, ORIGIN);
  } catch {
    return null;
  }

  if (url.hostname !== "shopify.dev") return null;
  if (!url.pathname.startsWith("/docs/")) return null;

  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\.md$/i, "").replace(/\.txt$/i, "");

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

function isUnderPrefix(url: string, prefix: string): boolean {
  return url === prefix || url.startsWith(`${prefix}/`);
}

function toLocalPath(docUrl: string): string {
  const { pathname } = new URL(docUrl);
  const relativePath = pathname === "/" ? "index" : pathname.slice(1);
  return path.join(OUTPUT_ROOT, `${relativePath}.md`);
}

function extractDocLinks(markdown: string): Set<string> {
  const links = new Set<string>();

  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const canonical = canonicalizeDocUrl(match[1] ?? "");
    if (canonical) links.add(canonical);
  }

  for (const match of markdown.matchAll(
    /https:\/\/shopify\.dev\/docs\/[\w\-./#?=&%]+/g,
  )) {
    const canonical = canonicalizeDocUrl(match[0]);
    if (canonical) links.add(canonical);
  }

  return links;
}

async function requestText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) {
    throw new Error(`Failed ${url}: ${String(response.status)} ${response.statusText}`);
  }
  return response.text();
}

async function fetchSitemapXml(): Promise<string> {
  const response = await fetch(SITEMAP_URL, {
    headers: { "user-agent": USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(
      `Failed ${SITEMAP_URL}: ${String(response.status)} ${response.statusText}`,
    );
  }

  const compressed = Buffer.from(await response.arrayBuffer());
  return zlib.gunzipSync(compressed).toString("utf8");
}

async function collectAdminUrls(): Promise<Set<string>> {
  const sitemapXml = await fetchSitemapXml();
  const urls = new Set<string>([ADMIN_PREFIX]);

  for (const match of sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const canonical = canonicalizeDocUrl(match[1] ?? "");
    if (canonical && isUnderPrefix(canonical, ADMIN_PREFIX)) {
      urls.add(canonical);
    }
  }

  return urls;
}

async function saveMarkdown(
  docUrl: string,
  section: DocSection,
  entries: SavedDoc[],
): Promise<string> {
  const markdownUrl = `${docUrl}.md`;
  const content = await requestText(markdownUrl);
  const localPath = toLocalPath(docUrl);

  await mkdir(path.dirname(localPath), { recursive: true });
  await writeFile(localPath, content, "utf8");

  entries.push({
    url: docUrl,
    markdownUrl,
    localPath,
    section,
    fetchedAt: new Date().toISOString(),
  });

  process.stdout.write(`saved ${section} ${docUrl}\n`);

  return content;
}

async function crawlAppsBuild(entries: SavedDoc[]): Promise<number> {
  const queue = [APPS_BUILD_PREFIX];
  const queued = new Set<string>(queue);
  const visited = new Set<string>();
  let savedCount = 0;

  async function processPage(pageUrl: string): Promise<void> {
    visited.add(pageUrl);

    try {
      const content = await saveMarkdown(pageUrl, "apps-build", entries);
      savedCount += 1;

      for (const link of extractDocLinks(content)) {
        queueNewLink(link);
      }
    } catch (error) {
      process.stderr.write(`failed apps-build ${pageUrl}: ${String(error)}\n`);
    }
  }

  function queueNewLink(link: string): void {
    const isNew = isUnderPrefix(link, APPS_BUILD_PREFIX) && !visited.has(link) && !queued.has(link);
    if (isNew) {
      queue.push(link);
      queued.add(link);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (current) {
      queued.delete(current);
      if (!visited.has(current)) {
        await processPage(current);
      }
    }
  }

  return savedCount;
}

async function main(): Promise<void> {
  await mkdir(OUTPUT_ROOT, { recursive: true });

  const entries: SavedDoc[] = [];

  process.stdout.write("collecting admin-graphql urls\n");
  const adminUrls = [...(await collectAdminUrls())].toSorted();
  process.stdout.write(`admin-graphql urls: ${String(adminUrls.length)}\n`);

  let adminSaved = 0;
  for (const url of adminUrls) {
    try {
      await saveMarkdown(url, "admin-graphql", entries);
      adminSaved += 1;
    } catch (error) {
      process.stderr.write(`failed admin-graphql ${url}: ${String(error)}\n`);
    }
  }

  process.stdout.write("crawling apps/build docs\n");
  const appsSaved = await crawlAppsBuild(entries);

  process.stdout.write(
    `done saved=${String(entries.length)} admin=${String(adminSaved)} apps-build=${String(appsSaved)}\n`,
  );
}

await main();