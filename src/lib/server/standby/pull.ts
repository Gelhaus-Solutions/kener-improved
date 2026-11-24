import db from "../db/db.js";
import { GetNowTimestampUTC } from "../tool.js";
import { InvalidateAllSiteDataCaches } from "../cache/siteDataCache.js";
import { bumpRollupVersion } from "../cache/rollupVersion.js";
import { StandbyPrimaryUrl, StandbyToken } from "./config.js";
import { STANDBY_EXPORT_FORMAT, type StandbyExportPage } from "./tables.js";

export const PULL_INTERVAL_MS = 60_000;
const PAGE_TIMEOUT_MS = 60_000;
// A full first copy of a large instance is a few hundred pages.
const MAX_PAGES = 2000;

export interface PullResult {
  pages: number;
  rows: number;
  dataAt: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function assertPage(body: unknown): StandbyExportPage {
  const page = body as StandbyExportPage;
  if (!page || typeof page !== "object" || page.format !== STANDBY_EXPORT_FORMAT) {
    throw new Error(`the primary answered an unknown export format (${(page as { format?: unknown })?.format})`);
  }
  if (!Number.isInteger(page.generatedAt) || !page.windows || !page.delta || typeof page.delta !== "object") {
    throw new Error("the primary's export page is incomplete");
  }
  return page;
}

/**
 * One pull: every page from the primary's export, applied in order. Recorded as
 * good only once the last page is written; a failure leaves the previous good
 * pull as the standby's data time.
 */
export async function PullFromPrimary(fetchImpl: FetchLike = fetch): Promise<PullResult> {
  const baseUrl = StandbyPrimaryUrl();
  const token = StandbyToken();
  if (!baseUrl || !token) throw new Error("KENER_STANDBY_PRIMARY_URL and KENER_STANDBY_TOKEN must both be set");

  const state = await db.getStandbyState();
  const since = Number(state?.data_at ?? 0) || 0;
  const localSchema = await db.getLatestMigrationName();

  let after: string | null = null;
  let first: StandbyExportPage | null = null;
  let pages = 0;
  let rows = 0;
  const touched = new Set<string>();
  const orgIds = new Set<number>();

  do {
    if (++pages > MAX_PAGES) throw new Error(`the export did not finish within ${MAX_PAGES} pages`);
    const url = new URL(`${baseUrl}/ext/standby/export`);
    url.searchParams.set("since", String(since));
    if (after) url.searchParams.set("after", after);
    else if (state?.images_fingerprint) url.searchParams.set("images", state.images_fingerprint);

    const response = await fetchImpl(url.toString(), {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`the primary answered ${response.status} for ${url.pathname}`);
    const page = assertPage(await response.json());

    if (!first) {
      first = page;
      if (page.schema !== localSchema) {
        throw new Error(`schema differs: primary at ${page.schema}, standby at ${localSchema}; run the same release`);
      }
    }

    const result = await db.applyStandbyPage(page, {
      first: page === first,
      final: !page.next,
      dataAt: first.generatedAt,
      schema: first.schema,
      // Unchanged images come back as null with the same fingerprint.
      imagesFingerprint: first.imagesFingerprint ?? state?.images_fingerprint ?? null,
      nowSeconds: GetNowTimestampUTC(),
    });
    rows += result.rows;
    for (const tag of result.touchedTags) touched.add(tag);
    for (const id of result.orgIds) orgIds.add(id);
    after = page.next;
  } while (after);

  if (orgIds.size > 0) await InvalidateAllSiteDataCaches([...orgIds]);
  for (const tag of touched) await bumpRollupVersion(tag);
  return { pages, rows, dataAt: first!.generatedAt };
}

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const result = await PullFromPrimary();
    if (result.pages > 1) console.log(`Standby: pulled ${result.rows} rows in ${result.pages} pages from the primary`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Standby: pull from the primary failed:", message);
    try {
      await db.recordStandbyPullFailure(message, GetNowTimestampUTC());
    } catch (recordError) {
      console.error("Standby: could not record the failed pull:", recordError);
    }
  } finally {
    inFlight = false;
  }
}

/** Pulls now and then every minute. The first copy may take several minutes, so nothing waits for it. */
async function start(): Promise<void> {
  if (timer) return;
  console.log(`Standby: pulling from ${StandbyPrimaryUrl() ?? "(KENER_STANDBY_PRIMARY_URL unset)"} every minute`);
  void tick();
  timer = setInterval(() => void tick(), PULL_INTERVAL_MS);
}

async function shutdown(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
}

export default { start, shutdown };
