import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The properties every migration in this repo claims, checked at authoring time.
 *
 * **This is the cheap half of I10.** `scripts/check-upgrade.ts` is the expensive
 * half: it needs a real database and actually rolls one back. This needs
 * neither, so it runs on every test invocation and catches the omission on the
 * commit that makes it rather than on the deploy that needs it.
 *
 * Migrations run automatically on container start, so a missing `down` is not
 * discovered until an operator is already trying to get out of trouble.
 */

const MIGRATIONS_DIR = join(process.cwd(), "migrations");

const files = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .sort();

const source = new Map(files.map((name) => [name, readFileSync(join(MIGRATIONS_DIR, name), "utf8")]));

describe("every migration", () => {
  /**
   * The footprint assertion. Every check below is correct about the files it
   * reads and says nothing about the ones it does not, so the count is asserted
   * first: a glob that silently stops matching would leave all of them passing
   * over an empty set.
   */
  it("is actually being read by this test", () => {
    expect(files.length).toBeGreaterThan(60);
    expect(files.every((name) => (source.get(name) ?? "").length > 0)).toBe(true);
  });

  it("exports an up", () => {
    const missing = files.filter((name) => !/export async function up\b/.test(source.get(name)!));
    expect(missing).toEqual([]);
  });

  /**
   * A `down` that does not exist is a rollback path that fails at the moment it
   * is needed. One that honestly cannot restore what it dropped is fine and is
   * what the comment in it is for; one that is simply absent is not.
   */
  it("exports a down", () => {
    const missing = files.filter((name) => !/export async function down\b/.test(source.get(name)!));
    expect(missing).toEqual([]);
  });

  /**
   * Postgres aborts the whole transaction on any error, so a `try/catch` around
   * a failed statement leaves the connection unusable: every later statement in
   * the same migration fails too, and the migration then reports success over a
   * schema it did not change. Guard with `hasTable`/`hasColumn` instead.
   *
   * Four inherited migrations predate the rule and are exempt by name rather
   * than by a pattern loose enough to let a new one through. All four are
   * `try { create index } catch {}`, all four have already run on every install
   * that exists, and rewriting applied migrations would buy nothing and cost a
   * merge conflict on every upstream sync.
   */
  const CATCH_EXEMPT = [
    "20260114120000_remove_monitors_name_unique.ts",
    "20260216095021_index_monitoring_data.ts",
    "20260328120000_fix_sqlite_monitor_alerts_config_nullable.ts",
    "20260617120000_add_monitoring_data_covering_index.ts",
  ];

  it("guards with hasTable or hasColumn rather than catching", () => {
    const offenders = files.filter((name) => {
      const text = source.get(name)!;
      return /\btry\s*{/.test(text) && !/hasTable|hasColumn|hasIndex/.test(text);
    });
    expect(offenders.filter((name) => !CATCH_EXEMPT.includes(name))).toEqual([]);
  });

  /**
   * An exemption that has stopped applying is an exemption nobody notices has
   * become a lie, and the next reader takes the list as a statement about the
   * repo. So each one has to still name a real file that still has the problem.
   */
  it("has no stale exemptions", () => {
    const gone = CATCH_EXEMPT.filter((name) => !source.has(name));
    expect(gone, "exempted migrations that no longer exist").toEqual([]);

    const fixed = CATCH_EXEMPT.filter((name) => {
      const text = source.get(name)!;
      return !(/\btry\s*{/.test(text) && !/hasTable|hasColumn|hasIndex/.test(text));
    });
    expect(fixed, "exempted migrations that no longer need the exemption").toEqual([]);
  });

  /**
   * A `down` that does nothing is sometimes the right answer - a backfill has no
   * meaningful reversal - and is sometimes a stub nobody finished. The two are
   * indistinguishable from an empty function body, and the difference matters at
   * exactly the moment somebody is trying to get out of trouble.
   *
   * So a `down` with no statement in it has to say why. No exemption list:
   * writing the sentence is the whole cost, and the sentence is the thing a
   * future reader actually needs.
   */
  it("explains itself when its down does nothing", () => {
    const silent = files.filter((name) => {
      const text = source.get(name)!;
      const body = text.slice(text.indexOf("export async function down"));
      if (/await/.test(body)) return false;
      // A comment of any length inside the body counts as the explanation.
      return !/\/\/|\/\*/.test(body);
    });
    expect(silent).toEqual([]);
  });
});
