import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Knex from "knex";
import type { Knex as KnexType } from "knex";
import { SubscriptionSystemRepository } from "./subscriptionSystem.js";
import { unscoped } from "./testSupport";

// E1b's semantics, which are the part of this item that can actually be wrong.
//
// Scopes are OR'd in `getRecipientsForScopedEvent`, and every subscriber holds an
// ALL row written by the mirror. Three consequences follow, and none of them is
// obvious from reading either function alone:
//
//   1. A COMPONENT scope does nothing while the ALL row is live.
//   2. Switching an event class off has to retire *every* row, or a subscriber
//      who narrowed keeps receiving mail for their components after turning
//      incident mail off. This was unreachable until the dialog could create a
//      narrow row, which is exactly what E1b ships.
//   3. Switching it back on must not revive the ALL row for someone who had
//      narrowed, or they silently come back subscribed to everything.
//
// Own in-memory database rather than the app singleton, for the reason spelled
// out in monitoring.test.ts.

const METHOD = 1;
const USER = 1;

describe("scoped subscriptions: narrowing, and the on/off switch", () => {
  let db: KnexType;
  let repo: SubscriptionSystemRepository;

  beforeEach(async () => {
    db = Knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });

    await db.schema.createTable("subscriber_users", (t) => {
      t.increments("id").primary();
      t.string("email");
      t.string("status");
    });
    await db.schema.createTable("subscriber_methods", (t) => {
      t.increments("id").primary();
      t.integer("subscriber_user_id");
      t.string("method_type");
      t.string("method_value");
      t.string("status");
    });
    await db.schema.createTable("user_subscriptions_v2", (t) => {
      t.increments("id").primary();
      t.integer("subscriber_user_id");
      t.integer("subscriber_method_id");
      t.string("event_type");
      t.string("status");
      t.timestamp("created_at");
      t.timestamp("updated_at");
      t.unique(["subscriber_user_id", "subscriber_method_id", "event_type"]);
    });
    await db.schema.createTable("subscriber_subscriptions", (t) => {
      t.increments("id").primary();
      t.integer("subscriber_user_id");
      t.integer("subscriber_method_id");
      t.string("scope_type");
      t.string("scope_id");
      t.string("event_class");
      t.string("min_severity");
      t.string("notify_on");
      t.string("status");
      t.timestamp("created_at");
      t.timestamp("updated_at");
      t.unique(["subscriber_method_id", "scope_type", "scope_id", "event_class"]);
    });

    await db("subscriber_users").insert({ id: USER, email: "a@example.com", status: "ACTIVE" });
    await db("subscriber_methods").insert({
      id: METHOD,
      subscriber_user_id: USER,
      method_type: "email",
      method_value: "a@example.com",
      status: "ACTIVE",
    });

    repo = unscoped(new SubscriptionSystemRepository(db));
  });

  afterEach(async () => {
    await db.destroy();
  });

  /** Would this subscriber be mailed about an incident naming `tags`? */
  async function reached(tags: string[], pageIds: number[] = []): Promise<boolean> {
    const rows = await repo.getRecipientsForScopedEvent({
      event_class: "incidents",
      component_tags: tags,
      page_ids: pageIds,
      acceptable_min_severities: null,
      is_global: false,
    });
    return rows.length > 0;
  }

  async function subscribe(): Promise<number> {
    const created = await repo.createUserSubscriptionV2({
      subscriber_user_id: USER,
      subscriber_method_id: METHOD,
      event_type: "incidents",
      status: "ACTIVE",
    });
    return created.id;
  }

  async function addComponent(tag: string): Promise<void> {
    await repo.upsertScopedSubscription({
      subscriber_user_id: USER,
      subscriber_method_id: METHOD,
      scope_type: "COMPONENT",
      scope_id: tag,
      event_class: "incidents",
      min_severity: "ANY",
      status: "ACTIVE",
    });
  }

  /** Narrowing is retiring the ALL row. Nothing else narrows anything. */
  async function narrow(): Promise<void> {
    await repo.upsertScopedSubscription({
      subscriber_user_id: USER,
      subscriber_method_id: METHOD,
      scope_type: "ALL",
      scope_id: "",
      event_class: "incidents",
      min_severity: "ANY",
      status: "INACTIVE",
    });
  }

  it("a bare subscribe reaches everything", async () => {
    await subscribe();
    expect(await reached(["api"])).toBe(true);
    expect(await reached(["anything-else"])).toBe(true);
  });

  it("a component scope alone changes nothing, because scopes are OR'd", async () => {
    await subscribe();
    await addComponent("api");
    // The trap this whole design exists to avoid: a picker that appears to work
    // and does not. Still reached for an unrelated component.
    expect(await reached(["something-unrelated"])).toBe(true);
  });

  it("retiring the ALL row is what makes the component scope bite", async () => {
    await subscribe();
    await addComponent("api");
    await narrow();
    expect(await reached(["api"])).toBe(true);
    expect(await reached(["something-unrelated"])).toBe(false);
  });

  it("switching the class off stops component mail too", async () => {
    const id = await subscribe();
    await addComponent("api");
    await narrow();
    expect(await reached(["api"])).toBe(true);

    await repo.updateUserSubscriptionV2(id, { status: "INACTIVE" });
    // Before E1b the mirror only retired the ALL row, so this stayed true and a
    // subscriber who had switched incident mail off kept getting it.
    expect(await reached(["api"])).toBe(false);
  });

  it("switching it back on restores the narrowing rather than widening", async () => {
    const id = await subscribe();
    await addComponent("api");
    await narrow();
    await repo.updateUserSubscriptionV2(id, { status: "INACTIVE" });
    await repo.updateUserSubscriptionV2(id, { status: "ACTIVE" });

    expect(await reached(["api"])).toBe(true);
    // The failure that would matter: coming back subscribed to everything.
    expect(await reached(["something-unrelated"])).toBe(false);
  });

  it("a subscriber who never narrowed comes back to everything", async () => {
    const id = await subscribe();
    await repo.updateUserSubscriptionV2(id, { status: "INACTIVE" });
    expect(await reached(["api"])).toBe(false);
    await repo.updateUserSubscriptionV2(id, { status: "ACTIVE" });
    expect(await reached(["anything-at-all"])).toBe(true);
  });

  it("removing a narrow scope deletes it, so off-and-on cannot resurrect it", async () => {
    const id = await subscribe();
    await addComponent("api");
    await addComponent("db");
    await narrow();

    await repo.deleteScopedSubscription(METHOD, "incidents", "COMPONENT", "db");
    expect(await reached(["db"])).toBe(false);

    // A retire would come back here. A delete does not.
    await repo.updateUserSubscriptionV2(id, { status: "INACTIVE" });
    await repo.updateUserSubscriptionV2(id, { status: "ACTIVE" });
    expect(await reached(["db"])).toBe(false);
    expect(await reached(["api"])).toBe(true);
  });

  it("widening deletes the narrow rows, which is what keeps INACTIVE unambiguous", async () => {
    const id = await subscribe();
    await addComponent("api");
    await narrow();

    await repo.deleteNarrowScopedSubscriptions(METHOD, "incidents");
    await repo.upsertScopedSubscription({
      subscriber_user_id: USER,
      subscriber_method_id: METHOD,
      scope_type: "ALL",
      scope_id: "",
      event_class: "incidents",
      min_severity: "ANY",
      status: "ACTIVE",
    });
    expect(await reached(["anything"])).toBe(true);

    // And an off/on cycle keeps them widened rather than restoring old picks.
    await repo.updateUserSubscriptionV2(id, { status: "INACTIVE" });
    await repo.updateUserSubscriptionV2(id, { status: "ACTIVE" });
    expect(await reached(["anything"])).toBe(true);
  });

  it("a global incident still reaches a narrowed subscriber", async () => {
    await subscribe();
    await addComponent("api");
    await narrow();
    const rows = await repo.getRecipientsForScopedEvent({
      event_class: "incidents",
      component_tags: [],
      page_ids: [],
      acceptable_min_severities: null,
      is_global: true,
    });
    // A global incident is the operator saying this affects everything; narrowing
    // is not an opt-out from that.
    expect(rows.length).toBe(1);
  });

  it("maintenances are untouched by narrowing incidents", async () => {
    await repo.createUserSubscriptionV2({
      subscriber_user_id: USER,
      subscriber_method_id: METHOD,
      event_type: "maintenances",
      status: "ACTIVE",
    });
    await subscribe();
    await addComponent("api");
    await narrow();

    const rows = await repo.getRecipientsForScopedEvent({
      event_class: "maintenances",
      component_tags: ["something-unrelated"],
      page_ids: [],
      acceptable_min_severities: null,
      is_global: false,
    });
    expect(rows.length).toBe(1);
  });
});
