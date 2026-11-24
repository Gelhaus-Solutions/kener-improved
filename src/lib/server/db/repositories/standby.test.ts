import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Knex from "knex";
import type { Knex as KnexType } from "knex";
import { StandbyRepository } from "./standby.js";
import { up as createRollupTables } from "../../../../../migrations/20260910110000_add_monitor_rollup_tables.js";
import { up as createRollupState } from "../../../../../migrations/20260910120000_add_rollup_state_and_dirty.js";
import { up as createRollup15m } from "../../../../../migrations/20260912100000_add_monitor_rollup_15m.js";
import { up as createStandbyState } from "../../../../../migrations/20261124120000_add_standby_state.js";
import type { StandbyExportPage } from "../../standby/tables.js";

/**
 * The mirror end to end on SQLite: a primary's export applied to a standby.
 * The rollup and standby tables come from their real migrations; the rest are
 * the columns these queries touch.
 */

const NOW = 1_800_000_000;
const DAY = 86400;
const SCHEMA = "20261124120000_add_standby_state.ts";

async function schema(db: KnexType, extraIncidentColumn = false): Promise<void> {
  await db.schema.createTable("knex_migrations", (t) => {
    t.increments("id");
    t.string("name");
  });
  await db("knex_migrations").insert([{ name: "20260101000000_first.ts" }, { name: SCHEMA }]);
  await db.schema.createTable("orgs", (t) => {
    t.increments("id");
    t.string("slug").unique();
    t.string("name");
    t.boolean("is_default");
    t.string("tag_prefix");
  });
  await db.schema.createTable("org_domains", (t) => {
    t.increments("id");
    t.integer("org_id");
    t.string("hostname");
  });
  await db.schema.createTable("site_data", (t) => {
    t.increments("id");
    t.integer("org_id");
    t.string("key");
    t.text("value");
    t.unique(["org_id", "key"]);
  });
  await db.schema.createTable("pages", (t) => {
    t.increments("id");
    t.integer("org_id");
    t.string("page_path");
    t.string("page_title");
    t.unique(["org_id", "page_path"]);
  });
  await db.schema.createTable("pages_monitors", (t) => {
    t.increments("id");
    t.integer("org_id");
    t.integer("page_id");
    t.string("monitor_tag");
  });
  await db.schema.createTable("page_domains", (t) => {
    t.increments("id");
    t.integer("org_id");
    t.integer("page_id");
    t.string("hostname");
  });
  await db.schema.createTable("monitors", (t) => {
    t.increments("id");
    t.integer("org_id");
    t.string("tag").unique();
    t.string("name");
    t.string("monitor_type");
    t.text("type_data");
  });
  for (const table of ["component_dependencies", "monitor_rollup_settings", "sla_targets", "sla_evaluations"]) {
    await db.schema.createTable(table, (t) => {
      t.increments("id");
      t.integer("org_id");
      t.string("note");
    });
  }
  await db.schema.createTable("incidents", (t) => {
    t.increments("id");
    t.integer("org_id");
    t.string("title");
    t.integer("start_date_time");
    t.integer("end_date_time").nullable();
    // A column one dialect's migration adds and the other's skips.
    if (extraIncidentColumn) t.text("search_vector");
  });
  for (const table of ["incident_monitors", "incident_comments"]) {
    await db.schema.createTable(table, (t) => {
      t.increments("id");
      t.integer("org_id");
      t.integer("incident_id");
      t.string("monitor_tag");
    });
  }
  await db.schema.createTable("incident_postmortems", (t) => {
    t.increments("id");
    t.integer("org_id");
    t.integer("incident_id");
    t.string("status");
  });
  await db.schema.createTable("maintenances", (t) => {
    t.increments("id");
    t.integer("org_id");
    t.string("title");
  });
  await db.schema.createTable("maintenances_events", (t) => {
    t.increments("id");
    t.integer("org_id");
    t.integer("maintenance_id");
    t.integer("start_date_time");
    t.integer("end_date_time");
  });
  await db.schema.createTable("maintenance_monitors", (t) => {
    t.increments("id");
    t.integer("org_id");
    t.integer("maintenance_id");
    t.string("monitor_tag");
  });
  await db.schema.createTable("images", (t) => {
    t.string("id").primary();
    t.integer("org_id");
    t.text("data");
    t.integer("size");
    t.string("updated_at");
  });
  await db.schema.createTable("monitoring_data", (t) => {
    t.integer("org_id");
    t.string("monitor_tag");
    t.integer("region_id");
    t.integer("timestamp");
    t.string("status");
    t.float("latency");
    t.primary(["monitor_tag", "region_id", "timestamp"]);
  });
  await createRollupTables(db);
  await createRollup15m(db);
  await createRollupState(db);
  await createStandbyState(db);
}

function rollupRow(tag: string, bucket: number, computed: number, up = 60) {
  return {
    org_id: 1,
    monitor_tag: tag,
    region_id: 0,
    bucket_start: bucket,
    count_total: up,
    count_up: up,
    computed_at: computed,
  };
}

async function seedPrimary(db: KnexType): Promise<void> {
  await db("orgs").insert({ id: 1, slug: "default", name: "GPlatform", is_default: true, tag_prefix: "" });
  await db("org_domains").insert({ org_id: 1, hostname: "status.example.com" });
  await db("site_data").insert([
    { org_id: 1, key: "siteName", value: "GPlatform Status" },
    { org_id: 0, key: "oidcSettings", value: JSON.stringify({ client_secret: "sealed" }) },
    { org_id: 1, key: "webhookSecretToken", value: "nope" },
  ]);
  await db("pages").insert({ id: 1, org_id: 1, page_path: "", page_title: "Home" });
  await db("pages_monitors").insert([
    { org_id: 1, page_id: 1, monitor_tag: "api" },
    { org_id: 1, page_id: 1, monitor_tag: "all" },
  ]);
  await db("monitors").insert([
    {
      id: 1,
      org_id: 1,
      tag: "api",
      name: "API",
      monitor_type: "API",
      type_data: JSON.stringify({ headers: "Bearer xyz" }),
    },
    {
      id: 2,
      org_id: 1,
      tag: "all",
      name: "All",
      monitor_type: "GROUP",
      type_data: JSON.stringify({ monitors: [{ tag: "api" }] }),
    },
  ]);
  await db("incidents").insert([
    { id: 1, org_id: 1, title: "Open", start_date_time: NOW - 200 * DAY, end_date_time: null, search_vector: "x" },
    { id: 2, org_id: 1, title: "Recent", start_date_time: NOW - 2 * DAY, end_date_time: NOW - DAY, search_vector: "x" },
    {
      id: 3,
      org_id: 1,
      title: "Old",
      start_date_time: NOW - 200 * DAY,
      end_date_time: NOW - 199 * DAY,
      search_vector: "x",
    },
  ]);
  await db("incident_monitors").insert([
    { org_id: 1, incident_id: 2, monitor_tag: "api" },
    { org_id: 1, incident_id: 3, monitor_tag: "api" },
  ]);
  await db("incident_comments").insert({ org_id: 1, incident_id: 2, monitor_tag: null });
  await db("incident_postmortems").insert([
    { org_id: 1, incident_id: 2, status: "PUBLISHED" },
    { org_id: 1, incident_id: 2, status: "DRAFT" },
  ]);
  await db("maintenances").insert([
    { id: 1, org_id: 1, title: "Upcoming" },
    { id: 2, org_id: 1, title: "Long gone" },
  ]);
  await db("maintenances_events").insert([
    { org_id: 1, maintenance_id: 1, start_date_time: NOW + DAY, end_date_time: NOW + DAY + 3600 },
    { org_id: 1, maintenance_id: 2, start_date_time: NOW - 300 * DAY, end_date_time: NOW - 300 * DAY + 3600 },
  ]);
  await db("maintenance_monitors").insert([
    { org_id: 1, maintenance_id: 1, monitor_tag: "api" },
    { org_id: 1, maintenance_id: 2, monitor_tag: "api" },
  ]);
  await db("images").insert({ id: "logo", org_id: 1, data: "aGVsbG8=", size: 5, updated_at: "2026-11-01 10:00:00" });
  await db("rollup_state").insert([
    { org_id: 1, grain: "1h", region_id: 0, watermark_ts: NOW - 3600, backfill_complete: true, updated_at: NOW },
    { org_id: 1, grain: "5m", region_id: 0, watermark_ts: NOW - 300, backfill_complete: true, updated_at: NOW },
  ]);
  await db("monitoring_data").insert([
    { org_id: 1, monitor_tag: "api", region_id: 0, timestamp: NOW - 120, status: "UP", latency: 10 },
    { org_id: 1, monitor_tag: "api", region_id: 0, timestamp: NOW - 60, status: "UP", latency: 12 },
    // Another region, and a sample older than any window: neither travels.
    { org_id: 1, monitor_tag: "api", region_id: 2, timestamp: NOW - 60, status: "DOWN", latency: 0 },
    { org_id: 1, monitor_tag: "api", region_id: 0, timestamp: NOW - 30 * DAY, status: "UP", latency: 9 },
  ]);
  await db("monitor_rollup_1h").insert([
    rollupRow("api", NOW - 7200, NOW - 3000),
    rollupRow("api", NOW - 3600 - 3600 * 24, NOW - 3000),
    rollupRow("api", NOW - 200 * DAY, NOW - 3000),
  ]);
  await db("monitor_rollup_1d").insert(rollupRow("api", NOW - 2 * DAY, NOW - 3000, 1440));
}

function memory(): KnexType {
  return Knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
}

let primaryDb: KnexType;
let standbyDb: KnexType;
let primary: StandbyRepository;
let standby: StandbyRepository;

beforeEach(async () => {
  primaryDb = memory();
  standbyDb = memory();
  await schema(primaryDb, true);
  await schema(standbyDb);
  await seedPrimary(primaryDb);
  // What a fresh standby's seeds left: its own instance settings, and a sample monitor.
  await standbyDb("orgs").insert({ id: 1, slug: "default", name: "Default", is_default: true, tag_prefix: "" });
  await standbyDb("site_data").insert({ org_id: 0, key: "oidcSettings", value: "{}" });
  await standbyDb("monitors").insert({ id: 99, org_id: 1, tag: "sample", name: "Sample", monitor_type: "API" });
  primary = new StandbyRepository(primaryDb);
  standby = new StandbyRepository(standbyDb);
});

afterEach(async () => {
  await primaryDb.destroy();
  await standbyDb.destroy();
});

async function exportAll(since = 0, pageRows?: number, imagesFingerprint: string | null = null) {
  const pages: StandbyExportPage[] = [];
  let after = null;
  do {
    const page = await primary.exportStandbyPage({ since, after, imagesFingerprint, nowSeconds: NOW, pageRows });
    pages.push(page);
    after = page.next ? JSON.parse(Buffer.from(page.next, "base64url").toString("utf8")) : null;
  } while (after);
  return pages;
}

async function applyAll(pages: StandbyExportPage[]) {
  const first = pages[0];
  for (const [i, page] of pages.entries()) {
    await standby.applyStandbyPage(page, {
      first: i === 0,
      final: i === pages.length - 1,
      dataAt: first.generatedAt,
      schema: first.schema,
      imagesFingerprint: first.imagesFingerprint,
      nowSeconds: NOW + 5,
    });
  }
}

async function dump(db: KnexType) {
  const tables = ["orgs", "pages", "pages_monitors", "monitors", "incidents", "incident_monitors"];
  const out: Record<string, unknown[]> = {};
  for (const table of [...tables, "incident_postmortems", "maintenances", "maintenances_events", "images"]) {
    out[table] = await db(table).select("*").orderBy("id");
  }
  // A mirrored setting gets a fresh id on every pull; only its content is the mirror.
  out.site_data = await db("site_data").select("org_id", "key", "value").orderBy("key");
  out.monitoring_data = await db("monitoring_data").select("*").orderBy(["monitor_tag", "timestamp"]);
  out.monitor_rollup_1h = await db("monitor_rollup_1h").select("*").orderBy("bucket_start");
  out.rollup_state = await db("rollup_state").select("*").orderBy("grain");
  return out;
}

describe("the primary's export", () => {
  it("leaves out secrets and anything the public page cannot show", async () => {
    const [page] = await exportAll();
    const snapshot = page.snapshot!;
    expect(page.schema).toBe(SCHEMA);
    expect(snapshot.site_data!.map((r) => r.key)).toEqual(["siteName"]);
    const monitors = Object.fromEntries(snapshot.monitors!.map((m) => [m.tag, m]));
    expect(monitors.api.type_data).toBeNull();
    expect(JSON.parse(String(monitors.all.type_data))).toEqual({ monitors: [{ tag: "api" }] });
    expect(snapshot.incidents!.map((i) => i.title).sort()).toEqual(["Open", "Recent"]);
    expect(snapshot.incident_monitors!.map((r) => r.incident_id)).toEqual([2]);
    expect(snapshot.incident_postmortems!.map((r) => r.status)).toEqual(["PUBLISHED"]);
    expect(snapshot.maintenances!.map((m) => m.title)).toEqual(["Upcoming"]);
    expect(snapshot.maintenance_monitors!.map((r) => r.maintenance_id)).toEqual([1]);
    expect(snapshot.rollup_state!.map((r) => r.grain)).toEqual(["1h"]);
    expect(snapshot.orgs![0].is_default).toBe(1);
    expect(page.delta.monitoring_data.map((r) => r.timestamp)).toEqual([NOW - 120, NOW - 60]);
    expect(page.delta.monitor_rollup_1h).toHaveLength(2);
    expect(page.delta.monitor_rollup_1d).toHaveLength(1);
    expect(page.images!.map((i) => i.id)).toEqual(["logo"]);
  });

  it("skips the images when the standby already has them", async () => {
    const [first] = await exportAll();
    const [again] = await exportAll(0, undefined, first.imagesFingerprint);
    expect(again.images).toBeNull();
    expect(again.imagesFingerprint).toBe(first.imagesFingerprint);
  });

  it("pages the time series by cursor, every row once and in order", async () => {
    const whole = await exportAll();
    const paged = await exportAll(0, 2);
    expect(paged.length).toBeGreaterThan(2);
    expect(paged.slice(1).every((p) => p.snapshot === null && p.images === null)).toBe(true);
    for (const table of Object.keys(whole[0].delta)) {
      const rows = paged.flatMap((p) => p.delta[table] ?? []);
      expect(rows, table).toEqual(whole[0].delta[table]);
    }
  });

  it("sends only what changed since the last pull, with an overlap", async () => {
    const [page] = await exportAll(NOW - 60);
    // Samples from the last six minutes (the five-minute overlap), rollups recomputed since.
    expect(page.delta.monitoring_data.map((r) => r.timestamp)).toEqual([NOW - 120, NOW - 60]);
    expect(page.delta.monitor_rollup_1h).toHaveLength(0);
    const [later] = await exportAll(NOW - 3000);
    expect(later.delta.monitor_rollup_1h).toHaveLength(2);
  });
});

describe("the standby's apply", () => {
  it("mirrors the export and is idempotent", async () => {
    const pages = await exportAll(0, 2);
    await applyAll(pages);
    const once = await dump(standbyDb);

    expect(once.monitors.map((m) => (m as { tag: string }).tag)).toEqual(["api", "all"]);
    expect(once.site_data.map((r) => (r as { key: string }).key).sort()).toEqual(["oidcSettings", "siteName"]);
    expect((once.site_data.find((r) => (r as { key: string }).key === "oidcSettings") as { value: string }).value).toBe(
      "{}",
    );
    expect(once.incidents).toHaveLength(2);
    expect(once.monitoring_data).toHaveLength(2);
    expect(once.monitor_rollup_1h).toHaveLength(2);
    expect(once.images).toHaveLength(1);

    await applyAll(pages);
    expect(await dump(standbyDb)).toEqual(once);
  });

  it("upserts a changed sample in place and prunes what fell out of the window", async () => {
    await applyAll(await exportAll());
    await standbyDb("monitoring_data").insert({
      org_id: 1,
      monitor_tag: "api",
      region_id: 0,
      timestamp: NOW - 40 * DAY,
      status: "UP",
      latency: 1,
    });
    await primaryDb("monitoring_data")
      .where({ monitor_tag: "api", region_id: 0, timestamp: NOW - 60 })
      .update({ status: "DOWN" });

    await applyAll(await exportAll(NOW));
    const rows = await standbyDb("monitoring_data").select("timestamp", "status").orderBy("timestamp");
    expect(rows).toEqual([
      { timestamp: NOW - 120, status: "UP" },
      { timestamp: NOW - 60, status: "DOWN" },
    ]);
  });

  it("records the pull only once its last page is written", async () => {
    const pages = await exportAll(0, 2);
    await standby.applyStandbyPage(pages[0], {
      first: true,
      final: false,
      dataAt: pages[0].generatedAt,
      schema: pages[0].schema,
      imagesFingerprint: pages[0].imagesFingerprint,
      nowSeconds: NOW + 5,
    });
    expect(await standby.getStandbyState()).toBeNull();

    await applyAll(pages);
    expect(await standby.getStandbyState()).toMatchObject({
      last_pull_at: NOW + 5,
      data_at: NOW,
      schema_version: SCHEMA,
      images_fingerprint: pages[0].imagesFingerprint,
      last_error: null,
    });
  });

  it("keeps the last good pull when a later one fails", async () => {
    await applyAll(await exportAll());
    await standby.recordStandbyPullFailure("the primary answered 502", NOW + 70);
    expect(await standby.getStandbyState()).toMatchObject({
      last_pull_at: NOW + 5,
      data_at: NOW,
      last_attempt_at: NOW + 70,
      last_error: "the primary answered 502",
    });
  });
});
