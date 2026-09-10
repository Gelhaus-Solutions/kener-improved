import { BaseRepository } from "./base.js";
import type {
  SubscriberUserRecord,
  SubscriberUserRecordInsert,
  SubscriberUserStatus,
  SubscriberMethodRecord,
  SubscriberMethodRecordInsert,
  SubscriptionMethodType,
  SubscriptionStatus,
  UserSubscriptionV2Record,
  UserSubscriptionV2RecordInsert,
  UserSubscriptionV2Filter,
  SubscriptionEventType,
  DbTimestamp,
} from "../../types/db.js";
import { GetDbType } from "../../tool.js";

/**
 * Repository for the new subscription system v2
 * Tables: subscriber_users, subscriber_methods, user_subscriptions_v2
 */
export class SubscriptionSystemRepository extends BaseRepository {
  // ============ Subscriber Users ============

  async createSubscriberUser(data: SubscriberUserRecordInsert): Promise<SubscriberUserRecord> {
    const dbType = GetDbType();
    const insertData = {
      email: data.email.toLowerCase().trim(),
      status: data.status || "PENDING",
      verification_code: data.verification_code || null,
      verification_expires_at: data.verification_expires_at || null,
      created_at: this.knexUnscoped.fn.now(),
      updated_at: this.knexUnscoped.fn.now(),
    };

    if (dbType === "postgresql") {
      const [user] = await this.table("subscriber_users").insert(insertData).returning("*");
      return user;
    } else {
      const result = await this.table("subscriber_users").insert(insertData);
      const id = result[0];
      return (await this.getSubscriberUserById(id))!;
    }
  }

  async getSubscriberUserById(id: number): Promise<SubscriberUserRecord | undefined> {
    return await this.table("subscriber_users").where("id", id).first();
  }

  async getSubscriberUserByEmail(email: string): Promise<SubscriberUserRecord | undefined> {
    return await this.table("subscriber_users").where("email", email.toLowerCase().trim()).first();
  }

  async updateSubscriberUser(id: number, data: Partial<SubscriberUserRecordInsert>): Promise<number> {
    const updateData: Record<string, unknown> = {
      updated_at: this.knexUnscoped.fn.now(),
    };
    if (data.email !== undefined) updateData.email = data.email.toLowerCase().trim();
    if (data.status !== undefined) updateData.status = data.status;
    if (data.verification_code !== undefined) updateData.verification_code = data.verification_code;
    if (data.verification_expires_at !== undefined) updateData.verification_expires_at = data.verification_expires_at;

    return await this.table("subscriber_users").where("id", id).update(updateData);
  }

  async deleteSubscriberUser(id: number): Promise<number> {
    return await this.table("subscriber_users").where("id", id).del();
  }

  async getSubscriberUsersCount(status?: SubscriberUserStatus): Promise<number> {
    let query = this.table("subscriber_users").count("id as count");
    if (status) {
      query = query.where("status", status);
    }
    const result = await query.first();
    return Number(result?.count || 0);
  }

  async getSubscriberUsersPaginated(
    page: number,
    limit: number,
    status?: SubscriberUserStatus,
  ): Promise<SubscriberUserRecord[]> {
    let query = this.table("subscriber_users").select("*");
    if (status) {
      query = query.where("status", status);
    }
    return await query
      .orderBy("created_at", "desc")
      .limit(limit)
      .offset((page - 1) * limit);
  }

  // ============ Subscriber Methods ============

  async createSubscriberMethod(data: SubscriberMethodRecordInsert): Promise<SubscriberMethodRecord> {
    const dbType = GetDbType();
    const insertData = {
      subscriber_user_id: data.subscriber_user_id,
      method_type: data.method_type,
      method_value: data.method_value.trim(),
      status: data.status || "ACTIVE",
      meta: data.meta || null,
      created_at: this.knexUnscoped.fn.now(),
      updated_at: this.knexUnscoped.fn.now(),
    };

    if (dbType === "postgresql") {
      const [method] = await this.table("subscriber_methods").insert(insertData).returning("*");
      return method;
    } else {
      const result = await this.table("subscriber_methods").insert(insertData);
      const id = result[0];
      return (await this.getSubscriberMethodById(id))!;
    }
  }

  async getSubscriberMethodById(id: number): Promise<SubscriberMethodRecord | undefined> {
    return await this.table("subscriber_methods").where("id", id).first();
  }

  async getSubscriberMethodsByUserId(subscriberUserId: number): Promise<SubscriberMethodRecord[]> {
    return await this.table("subscriber_methods")
      .where("subscriber_user_id", subscriberUserId)
      .orderBy("created_at", "asc");
  }

  async getSubscriberMethodByUserAndType(
    subscriberUserId: number,
    methodType: SubscriptionMethodType,
    methodValue?: string,
  ): Promise<SubscriberMethodRecord | undefined> {
    let query = this.table("subscriber_methods")
      .where("subscriber_user_id", subscriberUserId)
      .andWhere("method_type", methodType);

    if (methodValue) {
      query = query.andWhere("method_value", methodValue.trim());
    }

    return await query.first();
  }

  async updateSubscriberMethod(id: number, data: Partial<SubscriberMethodRecordInsert>): Promise<number> {
    const updateData: Record<string, unknown> = {
      updated_at: this.knexUnscoped.fn.now(),
    };
    if (data.method_value !== undefined) updateData.method_value = data.method_value.trim();
    if (data.status !== undefined) updateData.status = data.status;
    if (data.meta !== undefined) updateData.meta = data.meta;

    return await this.table("subscriber_methods").where("id", id).update(updateData);
  }

  async deleteSubscriberMethod(id: number): Promise<number> {
    return await this.table("subscriber_methods").where("id", id).del();
  }

  async getActiveMethodsByType(methodType: SubscriptionMethodType): Promise<SubscriberMethodRecord[]> {
    return await this.table("subscriber_methods").where("method_type", methodType).andWhere("status", "ACTIVE");
  }

  // ============ User Subscriptions V2 ============

  async createUserSubscriptionV2(data: UserSubscriptionV2RecordInsert): Promise<UserSubscriptionV2Record> {
    const dbType = GetDbType();
    const insertData = {
      subscriber_user_id: data.subscriber_user_id,
      subscriber_method_id: data.subscriber_method_id,
      event_type: data.event_type,
      status: data.status || "ACTIVE",
      created_at: this.knexUnscoped.fn.now(),
      updated_at: this.knexUnscoped.fn.now(),
    };

    let created: UserSubscriptionV2Record;
    if (dbType === "postgresql") {
      const [sub] = await this.table("user_subscriptions_v2").insert(insertData).returning("*");
      created = sub;
    } else {
      const result = await this.table("user_subscriptions_v2").insert(insertData);
      created = (await this.getUserSubscriptionV2ById(result[0]))!;
    }

    await this.mirrorToScopedSubscription(created);
    return created;
  }

  /**
   * Writes the equivalent scoped row for an inherited subscription (E1).
   *
   * The dual write lives here rather than at each caller for the same reason the
   * subscriber cutover gate does: every path that creates a subscription already
   * funnels through this method, so there is exactly one thing to get right and a
   * caller added later inherits it. `AdminAddSubscriber`, the public subscribe
   * endpoint and the preferences screen all arrive here.
   *
   * ALL scope with no severity floor, which is precisely what the old row means.
   * A subscription created through the *scoped* UI is written directly and does
   * not come through here.
   */
  private async mirrorToScopedSubscription(sub: UserSubscriptionV2Record): Promise<void> {
    await this.syncScopedStatus(
      sub.subscriber_user_id,
      sub.subscriber_method_id,
      sub.event_type,
      sub.status ?? "ACTIVE",
    );
  }

  /**
   * Puts one method's scoped rows for an event class into the state the
   * inherited on/off switch says they should be in (E1b).
   *
   * **Why this is not simply "write the ALL row".** Scopes are OR'd in
   * `getRecipientsForScopedEvent`, and until E1b nothing could create a narrow
   * row through the product, so mirroring onto the ALL row alone was complete.
   * The moment the subscribe dialog can create a COMPONENT row, it stops being:
   * a subscriber who switched incident mail *off* would keep receiving mail for
   * their components, because only their ALL row was retired. Off has to mean
   * off, so off retires every row for the class.
   *
   * **Turning it back on cannot blindly revive the ALL row**, or a subscriber
   * who had narrowed to two components would silently come back subscribed to
   * everything. The rule is memoryless and reads straight off the data: the
   * existence of narrow rows *is* the record that this subscriber narrowed. So
   * on means revive the narrow rows if there are any, and otherwise fall back to
   * the ALL row, creating it when this is a first subscribe.
   *
   * The invariant that makes this work - **narrow rows exist if and only if the
   * subscriber has narrowed** - is why widening back to "everything" deletes
   * them rather than retiring them. See `deleteScopedSubscription`.
   */
  private async syncScopedStatus(userId: number, methodId: number, eventClass: string, status: string): Promise<void> {
    if (status !== "ACTIVE") {
      await this.table("subscriber_subscriptions")
        .where({ subscriber_method_id: methodId, event_class: eventClass })
        .update({ status, updated_at: this.knexUnscoped.fn.now() });
      return;
    }

    const narrow = await this.table("subscriber_subscriptions")
      .where({ subscriber_method_id: methodId, event_class: eventClass })
      .whereNot("scope_type", "ALL");

    if (narrow.length > 0) {
      // Narrowed. Revive exactly what they chose, and leave the ALL row retired
      // so switching the class back on does not quietly widen them.
      await this.table("subscriber_subscriptions")
        .where({ subscriber_method_id: methodId, event_class: eventClass })
        .whereNot("scope_type", "ALL")
        .update({ status: "ACTIVE", updated_at: this.knexUnscoped.fn.now() });
      return;
    }

    await this.table("subscriber_subscriptions")
      .insert({
        subscriber_user_id: userId,
        subscriber_method_id: methodId,
        scope_type: "ALL",
        scope_id: "",
        event_class: eventClass,
        min_severity: "ANY",
        notify_on: null,
        status: "ACTIVE",
        created_at: this.knexUnscoped.fn.now(),
        updated_at: this.knexUnscoped.fn.now(),
      })
      // Re-subscribing to something already held must revive it rather than
      // fail: the old table's UNIQUE is on (user, method, event) and this one's
      // is on (method, scope, scope_id, class), so the same second subscribe
      // reaches a conflict on both and both have to mean the same thing.
      //
      // `min_severity` is deliberately not in the merge: a subscriber who set a
      // floor and later toggled the class off and on again keeps their floor.
      .onConflict(["subscriber_method_id", "scope_type", "scope_id", "event_class"])
      .merge({ status: "ACTIVE", updated_at: this.knexUnscoped.fn.now() });
  }

  /**
   * Removes one scoped subscription outright.
   *
   * A delete rather than a retire, and the difference is load-bearing: INACTIVE
   * has to keep meaning "switched off by the inherited on/off toggle" so that
   * `syncScopedStatus` can revive precisely those rows. If removing a component
   * merely retired it, switching the class off and on again would bring it back.
   */
  async deleteScopedSubscription(
    methodId: number,
    eventClass: string,
    scopeType: string,
    scopeId: string,
  ): Promise<number> {
    return await this.table("subscriber_subscriptions")
      .where({
        subscriber_method_id: methodId,
        event_class: eventClass,
        scope_type: scopeType,
        scope_id: scopeId,
      })
      .del();
  }

  /** Every narrow (non-ALL) scope one method holds for an event class. */
  async deleteNarrowScopedSubscriptions(methodId: number, eventClass: string): Promise<number> {
    return await this.table("subscriber_subscriptions")
      .where({ subscriber_method_id: methodId, event_class: eventClass })
      .whereNot("scope_type", "ALL")
      .del();
  }

  async getUserSubscriptionV2ById(id: number): Promise<UserSubscriptionV2Record | undefined> {
    return await this.table("user_subscriptions_v2").where("id", id).first();
  }

  async getUserSubscriptionsV2(filter: UserSubscriptionV2Filter): Promise<UserSubscriptionV2Record[]> {
    let query = this.table("user_subscriptions_v2").select("*");

    if (filter.subscriber_user_id !== undefined) {
      query = query.where("subscriber_user_id", filter.subscriber_user_id);
    }
    if (filter.subscriber_method_id !== undefined) {
      query = query.where("subscriber_method_id", filter.subscriber_method_id);
    }
    if (filter.event_type !== undefined) {
      query = query.where("event_type", filter.event_type);
    }

    if (filter.status !== undefined) {
      query = query.where("status", filter.status);
    }

    return await query.orderBy("created_at", "desc");
  }

  async updateUserSubscriptionV2(id: number, data: Partial<UserSubscriptionV2RecordInsert>): Promise<number> {
    const updateData: Record<string, unknown> = {
      updated_at: this.knexUnscoped.fn.now(),
    };
    if (data.status !== undefined) updateData.status = data.status;

    // Read before the write, because after it the row no longer says which
    // scoped row to mirror onto.
    const existing = await this.getUserSubscriptionV2ById(id);
    const rows = await this.table("user_subscriptions_v2").where("id", id).update(updateData);

    if (existing && data.status !== undefined) {
      // Through the same rule as a first subscribe, not straight onto the ALL
      // row: off must retire every scope, and on must not widen a subscriber who
      // had narrowed. See `syncScopedStatus`.
      await this.syncScopedStatus(
        existing.subscriber_user_id,
        existing.subscriber_method_id,
        existing.event_type,
        data.status,
      );
    }
    return rows;
  }

  async deleteUserSubscriptionV2(id: number): Promise<number> {
    // Only the ALL-scoped mirror goes. A scoped subscription the subscriber
    // created deliberately is not a shadow of this row and must survive the
    // inherited one being removed.
    const existing = await this.getUserSubscriptionV2ById(id);
    if (existing) {
      await this.table("subscriber_subscriptions")
        .where({
          subscriber_method_id: existing.subscriber_method_id,
          scope_type: "ALL",
          scope_id: "",
          event_class: existing.event_type,
        })
        .del();
    }
    return await this.table("user_subscriptions_v2").where("id", id).del();
  }

  async subscriptionV2Exists(
    subscriberUserId: number,
    subscriberMethodId: number,
    eventType: SubscriptionEventType,
  ): Promise<boolean> {
    let query = this.table("user_subscriptions_v2")
      .where("subscriber_user_id", subscriberUserId)
      .andWhere("subscriber_method_id", subscriberMethodId)
      .andWhere("event_type", eventType);

    const result = await query.first();
    return !!result;
  }

  // ============ Complex Queries ============

  /**
   * Get all subscriptions for a user with method details
   */
  async getSubscriptionsWithMethodsForUser(subscriberUserId: number): Promise<
    Array<{
      subscription: UserSubscriptionV2Record;
      method: SubscriberMethodRecord;
    }>
  > {
    const rows = await this.table("user_subscriptions_v2 as us")
      .join("subscriber_methods as sm", "us.subscriber_method_id", "sm.id")
      .where("us.subscriber_user_id", subscriberUserId)
      .andWhere("us.status", "ACTIVE")
      .select("us.*", "sm.method_type", "sm.method_value", "sm.status as method_status", "sm.meta as method_meta");

    return rows.map((row) => ({
      subscription: {
        id: row.id,
        subscriber_user_id: row.subscriber_user_id,
        subscriber_method_id: row.subscriber_method_id,
        event_type: row.event_type,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        status: row.status,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      method: {
        id: row.subscriber_method_id,
        subscriber_user_id: row.subscriber_user_id,
        method_type: row.method_type,
        method_value: row.method_value,
        status: row.method_status,
        meta: row.method_meta,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    }));
  }

  /**
   * Who should receive one event, from the scoped subscription table (E1).
   *
   * One query rather than a fan of them, and `distinct` on the method rather
   * than on the address, because both of those are correctness rather than
   * performance. A subscriber who signed up for a page *and* for one of the
   * components on it matches two rows and must receive one email; the old path
   * deduplicated by putting addresses in a `Set`, which also silently collapsed
   * two different people who happen to share an address.
   *
   * The severity floor is passed in as the set of values that admit this event
   * rather than compared in SQL. Ranking a vocabulary in a query means a CASE
   * expression that reads differently on each dialect and has to be kept in step
   * with the enum by hand; a set membership test does not.
   */
  async getRecipientsForScopedEvent(args: {
    event_class: string;
    /** Monitor tags the event touches. Empty for an event that names none. */
    component_tags: string[];
    /** Ids of the pages those components appear on. */
    page_ids: number[];
    /**
     * `min_severity` values that admit this event, or null to skip the filter
     * entirely - which is what a maintenance does, because a severity floor must
     * not become a maintenance opt-out.
     */
    acceptable_min_severities: string[] | null;
    /**
     * True for an incident marked global.
     *
     * A global incident is the operator saying this affects everything, and such
     * an incident frequently names no components at all - so scope matching is
     * skipped rather than applied, or the biggest outages would reach only the
     * subscribers who asked for everything.
     */
    is_global: boolean;
  }): Promise<Array<{ subscriber_user_id: number; subscriber_method_id: number; email: string }>> {
    const query = this.table("subscriber_subscriptions as ss")
      .join("subscriber_users as su", "ss.subscriber_user_id", "su.id")
      .join("subscriber_methods as sm", "ss.subscriber_method_id", "sm.id")
      .where("ss.event_class", args.event_class)
      .andWhere("ss.status", "ACTIVE")
      .andWhere("su.status", "ACTIVE")
      .andWhere("sm.status", "ACTIVE")
      .andWhere("sm.method_type", "email");

    if (!args.is_global) {
      query.andWhere(function () {
        this.where("ss.scope_type", "ALL");
        if (args.component_tags.length > 0) {
          this.orWhere(function () {
            this.where("ss.scope_type", "COMPONENT").whereIn("ss.scope_id", args.component_tags);
          });
        }
        if (args.page_ids.length > 0) {
          this.orWhere(function () {
            this.where("ss.scope_type", "PAGE").whereIn(
              "ss.scope_id",
              args.page_ids.map((id) => String(id)),
            );
          });
        }
      });
    }

    if (args.acceptable_min_severities !== null) {
      query.whereIn("ss.min_severity", args.acceptable_min_severities);
    }

    const rows = await query
      .distinct("sm.id as subscriber_method_id", "sm.subscriber_user_id", "sm.method_value as email")
      .orderBy("sm.id", "asc");

    return rows as Array<{ subscriber_user_id: number; subscriber_method_id: number; email: string }>;
  }

  /**
   * Confirmed email subscribers of the named pages (F4).
   *
   * **Only ACTIVE users and ACTIVE methods.** An unconfirmed subscription is
   * somebody who typed an address, not somebody who agreed to receive mail at
   * it, and a monthly report is precisely the kind of unsolicited mail that gets
   * a sending domain blocked.
   *
   * **`scope_type = 'PAGE'` only, deliberately not `'ALL'`.** A report schedule
   * naming two pages means the people who asked about those pages. Sweeping in
   * every subscriber who chose "everything" would mail a detailed operational
   * PDF to an audience who subscribed to incident notices, which is a different
   * thing than they agreed to.
   */
  async getEmailSubscribersForPages(pageIds: ReadonlyArray<number>): Promise<string[]> {
    if (pageIds.length === 0) return [];
    const rows = await this.table("subscriber_subscriptions as ss")
      .join("subscriber_users as su", "ss.subscriber_user_id", "su.id")
      .join("subscriber_methods as sm", "ss.subscriber_method_id", "sm.id")
      .where("ss.status", "ACTIVE")
      .andWhere("su.status", "ACTIVE")
      .andWhere("sm.status", "ACTIVE")
      .andWhere("sm.method_type", "email")
      .andWhere("ss.scope_type", "PAGE")
      .whereIn(
        "ss.scope_id",
        pageIds.map((id) => String(id)),
      )
      .distinct("sm.method_value as email");

    return (rows as Array<{ email: string }>).map((row) => String(row.email)).filter((email) => email.includes("@"));
  }

  /**
   * Creates, revives or retires one scoped subscription (E1).
   *
   * An upsert rather than an insert because "subscribe to this again" and
   * "change my severity floor" are the same gesture from a subscriber's point of
   * view, and both collide with the UNIQUE. Retiring sets INACTIVE rather than
   * deleting, so a subscriber who turns something off and back on does not lose
   * the settings that came with it.
   */
  async upsertScopedSubscription(data: {
    subscriber_user_id: number;
    subscriber_method_id: number;
    scope_type: string;
    scope_id: string;
    event_class: string;
    min_severity: string;
    status: string;
  }): Promise<void> {
    await this.table("subscriber_subscriptions")
      .insert({
        subscriber_user_id: data.subscriber_user_id,
        subscriber_method_id: data.subscriber_method_id,
        scope_type: data.scope_type,
        scope_id: data.scope_id,
        event_class: data.event_class,
        min_severity: data.min_severity,
        status: data.status,
        created_at: this.knexUnscoped.fn.now(),
        updated_at: this.knexUnscoped.fn.now(),
      })
      .onConflict(["subscriber_method_id", "scope_type", "scope_id", "event_class"])
      .merge({
        min_severity: data.min_severity,
        status: data.status,
        updated_at: this.knexUnscoped.fn.now(),
      });
  }

  /** One method's scoped subscriptions, for the preferences screen. */
  async getScopedSubscriptionsForMethod(
    methodId: number,
  ): Promise<
    Array<{ scope_type: string; scope_id: string; event_class: string; min_severity: string; status: string }>
  > {
    return await this.table("subscriber_subscriptions").where("subscriber_method_id", methodId).select("*");
  }

  /** Every page a set of monitors appears on, for PAGE-scoped matching. */
  async getPageIdsForMonitorTags(monitorTags: string[]): Promise<number[]> {
    if (monitorTags.length === 0) return [];
    const rows = await this.table("pages_monitors").whereIn("monitor_tag", monitorTags).distinct("page_id");
    return rows.map((r: { page_id: number }) => r.page_id);
  }

  /**
   * Get subscribers for a specific event (for sending notifications)
   */
  async getSubscribersForEvent(eventType: SubscriptionEventType): Promise<
    Array<{
      user: SubscriberUserRecord;
      method: SubscriberMethodRecord;
      subscription: UserSubscriptionV2Record;
    }>
  > {
    let query = this.table("user_subscriptions_v2 as us")
      .join("subscriber_users as su", "us.subscriber_user_id", "su.id")
      .join("subscriber_methods as sm", "us.subscriber_method_id", "sm.id")
      .where("us.event_type", eventType)
      .andWhere("us.status", "ACTIVE")
      .andWhere("su.status", "ACTIVE")
      .andWhere("sm.status", "ACTIVE");

    const rows = await query.select(
      "su.id as user_id",
      "su.email as user_email",
      "su.status as user_status",
      "su.created_at as user_created_at",
      "sm.id as method_id",
      "sm.method_type",
      "sm.method_value",
      "sm.status as method_status",
      "sm.meta as method_meta",
      "us.id as sub_id",
      "us.event_type",
      "us.status as sub_status",
      "us.created_at as sub_created_at",
    );

    return rows.map((row) => ({
      user: {
        id: row.user_id,
        email: row.user_email,
        status: row.user_status,
        verification_code: null,
        verification_expires_at: null,
        created_at: row.user_created_at,
        updated_at: row.user_created_at,
      },
      method: {
        id: row.method_id,
        subscriber_user_id: row.user_id,
        method_type: row.method_type,
        method_value: row.method_value,
        status: row.method_status,
        meta: row.method_meta,
        created_at: row.sub_created_at,
        updated_at: row.sub_created_at,
      },
      subscription: {
        id: row.sub_id,
        subscriber_user_id: row.user_id,
        subscriber_method_id: row.method_id,
        event_type: row.event_type,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        status: row.sub_status,
        created_at: row.sub_created_at,
        updated_at: row.sub_created_at,
      },
    }));
  }

  /**
   * Get admin summary of all subscribers
   */
  async getSubscribersSummary(
    page: number,
    limit: number,
  ): Promise<
    Array<{
      user: SubscriberUserRecord;
      methods: SubscriberMethodRecord[];
      subscription_count: number;
    }>
  > {
    const users = await this.table("subscriber_users")
      .select("*")
      .where("status", "ACTIVE")
      .orderBy("created_at", "desc")
      .limit(limit)
      .offset((page - 1) * limit);

    const result = [];
    for (const user of users) {
      const methods = await this.getSubscriberMethodsByUserId(user.id);
      const subCount = await this.table("subscriber_subscriptions")
        .where("subscriber_user_id", user.id)
        .andWhere("status", "ACTIVE")
        .count("id as count")
        .first();

      result.push({
        user,
        methods,
        subscription_count: Number(subCount?.count || 0),
      });
    }

    return result;
  }

  // ============ Admin Methods for Listing by Method Type ============

  /**
   * Get count of unique users with methods of a specific type
   */
  async getMethodsCountByType(methodType: SubscriptionMethodType): Promise<number> {
    const result = await this.table("subscriber_methods")
      .countDistinct("subscriber_user_id as count")
      .where("method_type", methodType)
      .andWhere("status", "ACTIVE")
      .first();
    return Number(result?.count || 0);
  }

  /**
   * Get subscribers by method type with pagination for admin
   */
  async getSubscribersByMethodTypeV2(
    methodType: SubscriptionMethodType,
    page: number,
    limit: number,
  ): Promise<
    Array<{
      id: number;
      email: string;
      method_value: string;
      method_id: number;
      status: string;
      created_at: DbTimestamp;
      subscription_count: number;
      event_types: SubscriptionEventType[];
    }>
  > {
    // Get methods of this type with their users
    const methods = await this.table("subscriber_methods as sm")
      .join("subscriber_users as su", "sm.subscriber_user_id", "su.id")
      .where("sm.method_type", methodType)
      .andWhere("sm.status", "ACTIVE")
      .andWhere("su.status", "ACTIVE")
      .select("su.id as user_id", "su.email", "sm.id as method_id", "sm.method_value", "sm.status", "sm.created_at")
      .orderBy("sm.created_at", "desc")
      .limit(limit)
      .offset((page - 1) * limit);

    // Get subscription counts and event types for each method
    const result = [];
    for (const method of methods) {
      // Read from the scoped table (E1). The two agree for every inherited
      // subscription, because the migration backfilled them and every writer
      // mirrors - but a *scoped* subscription exists only here, and an admin
      // screen that could not see one would be showing subscriptions that no
      // longer decide who is emailed.
      const subCount = await this.table("subscriber_subscriptions")
        .where("subscriber_method_id", method.method_id)
        .andWhere("status", "ACTIVE")
        .count("id as count")
        .first();

      const eventTypes = await this.table("subscriber_subscriptions")
        .where("subscriber_method_id", method.method_id)
        .andWhere("status", "ACTIVE")
        .distinct("event_class")
        .pluck("event_class");

      result.push({
        id: method.user_id,
        email: method.email,
        method_value: method.method_value,
        method_id: method.method_id,
        status: method.status,
        created_at: method.created_at,
        subscription_count: Number(subCount?.count || 0),
        event_types: eventTypes as SubscriptionEventType[],
      });
    }

    return result;
  }

  /**
   * Get a specific subscriber's details for admin viewing
   */
  async getSubscriberDetailsByMethodId(methodId: number): Promise<{
    user: SubscriberUserRecord;
    method: SubscriberMethodRecord;
    subscriptions: UserSubscriptionV2Record[];
  } | null> {
    const method = await this.table("subscriber_methods").where("id", methodId).first();
    if (!method) return null;

    const user = await this.table("subscriber_users").where("id", method.subscriber_user_id).first();
    if (!user) return null;

    // The scoped rows, shaped like the inherited ones the admin screen expects.
    // `scope_type`, `scope_id` and `min_severity` ride along so a screen that
    // wants to show "incidents on api, major and above" can, without a second
    // query and without this method having two shapes.
    const rows = await this.table("subscriber_subscriptions")
      .where("subscriber_method_id", methodId)
      .andWhere("status", "ACTIVE")
      .orderBy("created_at", "desc");

    const subscriptions = rows.map((row: Record<string, unknown>) => ({
      ...row,
      event_type: row.event_class,
    })) as unknown as UserSubscriptionV2Record[];

    return { user, method, subscriptions };
  }
}
