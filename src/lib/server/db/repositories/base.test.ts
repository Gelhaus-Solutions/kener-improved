import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import knex, { type Knex } from "knex";
import { BaseRepository } from "./base";
import { MissingOrgContextError, runAcrossOrgs, runWithOrg } from "../orgContext";

// The tenancy chokepoint (I3c).
//
// `BaseRepository.table()` is the single thing standing between a repository
// method and a cross-tenant read, and the guarantee it provides is not visible
// in any individual repository. These tests state it directly: scoped reads,
// stamped writes, a hard failure with no context, and a deliberate bypass.

/** A repository that exposes the protected members, so the chokepoint can be driven directly. */
class ProbeRepository extends BaseRepository {
  scoped(spec: string) {
    return this.table(spec);
  }
  raw() {
    return this.knexUnscoped;
  }
}

describe("BaseRepository.table", () => {
  let db: Knex;
  let repo: ProbeRepository;

  beforeAll(async () => {
    db = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });

    // `monitors` is a tenant table; `users` is not. That difference is the whole
    // behaviour under test.
    await db.schema.createTable("monitors", (table) => {
      table.increments("id").primary();
      table.string("tag").notNullable();
      table.string("name").notNullable();
      table.integer("org_id").nullable();
    });
    await db.schema.createTable("users", (table) => {
      table.increments("id").primary();
      table.string("email").notNullable();
    });

    repo = new ProbeRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db("monitors").del();
    await db("users").del();
    await db("monitors").insert([
      { tag: "a", name: "Org 1 monitor", org_id: 1 },
      { tag: "b", name: "Org 2 monitor", org_id: 2 },
      { tag: "c", name: "Org 2 second", org_id: 2 },
    ]);
    await db("users").insert({ email: "someone@example.com" });
  });

  it("reads only the current org's rows", async () => {
    const rows = await runWithOrg(1, () => repo.scoped("monitors").select("tag"));
    expect(rows.map((r: { tag: string }) => r.tag)).toEqual(["a"]);

    const other = await runWithOrg(2, () => repo.scoped("monitors").select("tag"));
    expect(other.map((r: { tag: string }) => r.tag).sort()).toEqual(["b", "c"]);
  });

  it("stamps org_id onto inserts rather than filtering them", async () => {
    // A `where` clause does nothing on an insert, so scoping reads while leaving
    // writes unattributed would be the worst of both: rows that belong to
    // nobody and are invisible to every scoped read afterwards.
    await runWithOrg(2, () => repo.scoped("monitors").insert({ tag: "d", name: "New" }));

    const row = await db("monitors").where({ tag: "d" }).first();
    expect(row.org_id).toBe(2);
  });

  it("lets an explicit org_id on the row win", async () => {
    // What `provisionOrg` relies on: writing into an org it is creating while
    // running in another, or in none.
    await runWithOrg(1, () => repo.scoped("monitors").insert({ tag: "e", name: "Explicit", org_id: 2 }));

    const row = await db("monitors").where({ tag: "e" }).first();
    expect(row.org_id).toBe(2);
  });

  it("stamps every row of a bulk insert", async () => {
    await runWithOrg(2, () =>
      repo.scoped("monitors").insert([
        { tag: "f", name: "One" },
        { tag: "g", name: "Two" },
      ]),
    );

    const rows = await db("monitors").whereIn("tag", ["f", "g"]);
    expect(rows.map((r: { org_id: number }) => r.org_id)).toEqual([2, 2]);
  });

  it("scopes updates and deletes, not just reads", async () => {
    await runWithOrg(1, () => repo.scoped("monitors").update({ name: "Renamed" }));
    expect((await db("monitors").where({ tag: "a" }).first()).name).toBe("Renamed");
    expect((await db("monitors").where({ tag: "b" }).first()).name).toBe("Org 2 monitor");

    await runWithOrg(2, () => repo.scoped("monitors").del());
    expect(await db("monitors").count({ c: "*" }).first()).toEqual({ c: 1 });
  });

  it("throws rather than reading every tenant when there is no context", () => {
    // The guarantee. A missed scope must be a loud failure, never a quiet read
    // across every organisation.
    //
    // Thrown when the builder is *constructed*, not when it is awaited, which is
    // the more useful of the two: the stack points at the repository method that
    // forgot rather than at whoever happened to await it.
    expect(() => repo.scoped("monitors")).toThrow(MissingOrgContextError);
  });

  it("names the table in the error, so the failure points at its cause", () => {
    expect(() => repo.scoped("monitors")).toThrow(/monitors/);
    expect(() => repo.scoped("monitors")).toThrow(/runAcrossOrgs/);
  });

  it("leaves non-tenant tables alone, with or without a context", async () => {
    // `users` is a global identity: scoping it by org would be wrong, and
    // requiring a context to read it would break authentication, which happens
    // before any org is known.
    const withoutContext = await repo.scoped("users").select("email");
    expect(withoutContext).toHaveLength(1);

    const withContext = await runWithOrg(2, () => repo.scoped("users").select("email"));
    expect(withContext).toHaveLength(1);
  });

  it("runs unscoped inside runAcrossOrgs", async () => {
    const rows = await runAcrossOrgs(() => repo.scoped("monitors").select("tag"));
    expect(rows).toHaveLength(3);
  });

  it("qualifies the filter by the alias, so a join does not make it ambiguous", async () => {
    const rows = await runWithOrg(2, () =>
      repo.scoped("monitors as m").join("users as u", db.raw("1 = 1")).select("m.tag"),
    );
    expect(rows.map((r: { tag: string }) => r.tag).sort()).toEqual(["b", "c"]);
  });

  it("keeps knexUnscoped genuinely unscoped", async () => {
    // Not an endorsement: it is here for fn.now(), raw SQL and transactions, and
    // this test pins down that it does not quietly scope, so a reader who sees
    // `knexUnscoped("monitors")` knows exactly what it means.
    const rows = await runWithOrg(1, async () => await repo.raw()("monitors").select("tag"));
    expect(rows).toHaveLength(3);
  });
});
