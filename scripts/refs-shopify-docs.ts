import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

const ORIGIN = "https://shopify.dev";
const OUTPUT_ROOT = path.join("refs", "shopify-docs");
const SITEMAP_URL = `${ORIGIN}/sitemap_standard.xml.gz`;
const USER_AGENT =
  "tanstack-cloudflare-effect-shopify-app/refs-shopify-docs (+https://github.com/mw10013/tanstack-cloudflare-effect-shopify-app)";

type DocSection = "graphql" | "app" | "cli";
type DiscoveryKind = "sitemap-prefix" | "crawl-prefix";

interface SectionSource {
  label: string;
  kind: DiscoveryKind;
  prefix: string;
}

const SECTION_SOURCES: Record<DocSection, readonly SectionSource[]> = {
  graphql: [
    {
      label: "admin-graphql",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/admin-graphql/latest`,
    },
  ],
  app: [
    {
      label: "admin-extensions",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/admin-extensions`,
    },
    {
      label: "react-router",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/shopify-app-react-router`,
    },
    {
      label: "webhooks-api",
      kind: "sitemap-prefix",
      prefix: `${ORIGIN}/docs/api/webhooks`,
    },
    {
      label: "apps-build",
      kind: "crawl-prefix",
      prefix: `${ORIGIN}/docs/apps/build`,
    },
    {
      label: "apps-launch",
      kind: "crawl-prefix",
      prefix: `${ORIGIN}/docs/apps/launch`,
    },
    {
      label: "app-home",
      kind: "crawl-prefix",
      prefix: `${ORIGIN}/docs/api/app-home`,
    },
    {
      label: "apps-store",
      kind: "crawl-prefix",
      prefix: `${ORIGIN}/docs/apps/store`,
    },
    {
      label: "apps-deployment",
      kind: "crawl-prefix",
      prefix: `${ORIGIN}/docs/apps/deployment`,
    },
    {
      label: "apps-structure",
      kind: "crawl-prefix",
      prefix: `${ORIGIN}/docs/apps/structure`,
    },
    {
      label: "apps-webhooks",
      kind: "crawl-prefix",
      prefix: `${ORIGIN}/docs/apps/webhooks`,
    },
  ],
  cli: [
    {
      label: "shopify-cli",
      kind: "crawl-prefix",
      prefix: `${ORIGIN}/docs/api/shopify-cli`,
    },
    {
      label: "shopify-cli-app",
      kind: "crawl-prefix",
      prefix: `${ORIGIN}/docs/api/shopify-cli/app`,
    },
    {
      label: "shopify-cli-general-commands",
      kind: "crawl-prefix",
      prefix: `${ORIGIN}/docs/api/shopify-cli/general-commands`,
    },
  ],
};

const DEFAULT_SECTIONS = Object.keys(SECTION_SOURCES) as DocSection[];

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
  url.pathname = url.pathname.replaceAll(/\/{2,}/g, "/");

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

function collectSitemapUrls(sitemapXml: string, prefix: string): Set<string> {
  const canonicalPrefix = canonicalizeDocUrl(prefix);
  if (!canonicalPrefix) {
    throw new Error(`Invalid section prefix ${prefix}`);
  }

  const urls = new Set<string>([canonicalPrefix]);

  for (const match of sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const canonical = canonicalizeDocUrl(match[1] ?? "");
    if (canonical && isUnderPrefix(canonical, canonicalPrefix)) {
      urls.add(canonical);
    }
  }

  return urls;
}

async function fetchMarkdown(docUrl: string): Promise<{ markdownUrl: string; content: string }> {
  const markdownUrl = `${docUrl}.md`;
  const content = await requestText(markdownUrl);
  return { markdownUrl, content };
}

async function persistMarkdown(
  docUrl: string,
  section: DocSection,
  markdownUrl: string,
  content: string,
  entries: SavedDoc[],
  savedUrls: Set<string>,
): Promise<boolean> {
  if (savedUrls.has(docUrl)) {
    return false;
  }

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
  savedUrls.add(docUrl);

  process.stdout.write(`saved ${section} ${docUrl}\n`);

  return true;
}

async function crawlPrefix(
  prefix: string,
  sourceLabel: string,
  section: DocSection,
  entries: SavedDoc[],
  savedUrls: Set<string>,
): Promise<number> {
  const canonicalPrefixCandidate = canonicalizeDocUrl(prefix);
  if (!canonicalPrefixCandidate) {
    throw new Error(`Invalid crawl prefix ${prefix}`);
  }
  const canonicalPrefix = canonicalPrefixCandidate;

  const queue = [canonicalPrefix];
  const queued = new Set<string>(queue);
  const visited = new Set<string>();
  let savedCount = 0;

  async function processPage(pageUrl: string): Promise<void> {
    visited.add(pageUrl);

    try {
      const { markdownUrl, content } = await fetchMarkdown(pageUrl);
      if (
        await persistMarkdown(pageUrl, section, markdownUrl, content, entries, savedUrls)
      ) {
        savedCount += 1;
      }

      for (const link of extractDocLinks(content)) {
        queueNewLink(link);
      }
    } catch (error) {
      process.stderr.write(`failed ${section}/${sourceLabel} ${pageUrl}: ${String(error)}\n`);
    }
  }

  function queueNewLink(link: string): void {
    const isNew =
      isUnderPrefix(link, canonicalPrefix) && !visited.has(link) && !queued.has(link);
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

function parseArgs(args: string[]): {
  listSections: boolean;
  selectedSections: DocSection[];
} {
  const selected: DocSection[] = [];
  let listSections = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--list-sections") {
      listSections = true;
    } else {
      let sectionValue: string | undefined;
      if (arg === "--section") {
        sectionValue = args[index + 1];
        if (arg === "--section") {
          index += 1;
        }
      } else if (arg.startsWith("--section=")) {
        sectionValue = arg.slice("--section=".length);
      }

      if (sectionValue !== undefined) {
        if (!DEFAULT_SECTIONS.includes(sectionValue as DocSection)) {
          throw new Error(
            `Unknown section ${sectionValue}. Valid sections: ${DEFAULT_SECTIONS.join(", ")}`,
          );
        }

        selected.push(sectionValue as DocSection);
      } else {
        throw new Error(`Unknown arg ${arg}`);
      }
    }
  }

  return {
    listSections,
    selectedSections:
      selected.length > 0 ? [...new Set(selected)] : [...DEFAULT_SECTIONS],
  };
}

async function collectAndSaveSitemapSource(
  section: DocSection,
  source: SectionSource,
  sitemapXml: string,
  entries: SavedDoc[],
  savedUrls: Set<string>,
): Promise<number> {
  const urls = [...collectSitemapUrls(sitemapXml, source.prefix)].toSorted();
  process.stdout.write(`collecting ${section}/${source.label} urls=${String(urls.length)}\n`);

  let savedCount = 0;
  for (const url of urls) {
    try {
      const { markdownUrl, content } = await fetchMarkdown(url);
      if (await persistMarkdown(url, section, markdownUrl, content, entries, savedUrls)) {
        savedCount += 1;
      }
    } catch (error) {
      process.stderr.write(`failed ${section}/${source.label} ${url}: ${String(error)}\n`);
    }
  }

  return savedCount;
}

async function main(): Promise<void> {
  const { listSections, selectedSections } = parseArgs(process.argv.slice(2));

  if (listSections) {
    for (const section of DEFAULT_SECTIONS) {
      process.stdout.write(`${section}\n`);
      for (const source of SECTION_SOURCES[section]) {
        process.stdout.write(`  - ${source.label} ${source.kind} ${source.prefix}\n`);
      }
    }
    return;
  }

  await mkdir(OUTPUT_ROOT, { recursive: true });

  const entries: SavedDoc[] = [];
  const savedUrls = new Set<string>();
  const sectionSavedCounts: Record<DocSection, number> = {
    graphql: 0,
    app: 0,
    cli: 0,
  };

  const needsSitemap = selectedSections.some((section) =>
    SECTION_SOURCES[section].some((source) => source.kind === "sitemap-prefix"),
  );
  const sitemapXml = needsSitemap ? await fetchSitemapXml() : undefined;

  for (const section of selectedSections) {
    process.stdout.write(`section ${section}\n`);

    for (const source of SECTION_SOURCES[section]) {
      if (source.kind === "sitemap-prefix") {
        if (!sitemapXml) {
          throw new Error("sitemap xml missing for sitemap-prefix section");
        }
        sectionSavedCounts[section] += await collectAndSaveSitemapSource(
          section,
          source,
          sitemapXml,
          entries,
          savedUrls,
        );
      } else {
        process.stdout.write(`crawling ${section}/${source.label}\n`);
        sectionSavedCounts[section] += await crawlPrefix(
          source.prefix,
          source.label,
          section,
          entries,
          savedUrls,
        );
      }
    }
  }

  process.stdout.write(
    `done saved=${String(entries.length)} graphql=${String(sectionSavedCounts.graphql)} app=${String(sectionSavedCounts.app)} cli=${String(sectionSavedCounts.cli)}\n`,
  );
}

await main();
