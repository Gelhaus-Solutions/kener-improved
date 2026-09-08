import { BaseRepository } from "./base.js";
import type { SessionInsert, SessionRecord } from "../../types/db.js";

// Session rows.
//
// Every query here treats the row as the authority on whether a caller is
// signed in. Nothing reads a session without also checking that it has not been
// revoked and has not expired, which is why there is no bare `getById`: a helper
// that returned a revoked session would eventually be used by someone who forgot
// to check, and that is the whole bug this table exists to prevent.

export class SessionsRepository extends BaseRepository {
  async createSession(row: SessionInsert): Promise<void> {
    await this.table("sessions").insert(row);
  }

  /**
   * A session that is still usable right now, or undefined.
   *
   * Revocation and expiry are in the WHERE clause rather than checked by the
   * caller. `now` is passed in rather than read here so one request cannot see
   * a session expire between two queries.
   *
   * The user's current epoch and active flag are joined in, which is not
   * premature: this runs on every authenticated request, and fetching them
   * separately would put two more round trips on the hot path. It also lets a
   * stale or deactivated session be rejected before the user record is loaded
   * at all, so the failing path is cheaper than the succeeding one.
   */
  async getLiveSession(
    id: string,
    now: number,
  ): Promise<(SessionRecord & { user_epoch: number; user_is_active: boolean }) | undefined> {
    const row = (await this.table("sessions as s")
      .join("users as u", "u.id", "s.user_id")
      .select("s.*", "u.session_epoch as user_epoch", "u.is_active as user_is_active")
      .where("s.id", id)
      .whereNull("s.revoked_at")
      .andWhere("s.expires_at", ">", now)
      .first()) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      ...this.mapSession(row),
      user_epoch: Number(row.user_epoch ?? 0),
      // SQLite stores this as 0/1 and Postgres as an integer too, so compare
      // rather than trusting truthiness of whatever the driver hands back.
      user_is_active: Number(row.user_is_active ?? 0) === 1,
    };
  }

  /** Every session for a user, newest first. Includes revoked and expired ones. */
  async getSessionsForUser(userId: number, limit = 100): Promise<SessionRecord[]> {
    const rows = (await this.table("sessions")
      .select("*")
      .where("user_id", userId)
      .orderBy("issued_at", "desc")
      .limit(limit)) as Record<string, unknown>[];
    return rows.map((r) => this.mapSession(r));
  }

  /**
   * Revokes one session, and only if it is live.
   *
   * Conditional so that a second revoke does not overwrite the first one's
   * reason: "revoked_by_admin" becoming "logout" a moment later would misreport
   * why somebody lost access, which is exactly what the audit trail is asked
   * about afterwards.
   */
  async revokeSession(id: string, reason: string, now: number): Promise<boolean> {
    const updated = await this.table("sessions")
      .where("id", id)
      .whereNull("revoked_at")
      .update({ revoked_at: now, revoked_reason: reason, updated_at: this.knexUnscoped.fn.now() })
      .then((n) => Number(n));
    return updated > 0;
  }

  /**
   * Revokes every live session for a user, optionally sparing one.
   *
   * `exceptId` is what makes "sign out my other devices" possible without
   * signing the caller out of the device they are asking from.
   */
  async revokeUserSessions(userId: number, reason: string, now: number, exceptId?: string): Promise<number> {
    let query = this.table("sessions").where("user_id", userId).whereNull("revoked_at");
    if (exceptId) query = query.andWhereNot("id", exceptId);
    return await query
      .update({ revoked_at: now, revoked_reason: reason, updated_at: this.knexUnscoped.fn.now() })
      .then((n) => Number(n));
  }

  /**
   * Records that a session was used, but only if the stored value is stale.
   *
   * The `<` guard is what keeps this off the hot path: an active session writes
   * once a minute rather than once a request. Without it, adding a "last active"
   * column to the session list would have added a write to every authenticated
   * request in the product.
   */
  async touchSession(id: string, now: number, staleBefore: number): Promise<void> {
    await this.table("sessions")
      .where("id", id)
      .andWhere("last_seen_at", "<", staleBefore)
      .update({ last_seen_at: now });
  }

  /** Sets the org a session is acting in. P4 uses this for org switching. */
  async setSessionOrg(id: string, orgId: number | null): Promise<void> {
    await this.table("sessions")
      .where("id", id)
      .update({ active_org_id: orgId, updated_at: this.knexUnscoped.fn.now() });
  }

  /** Raises the MFA level of a live session, for A2's enrolment and challenge flows. */
  async setSessionMfaLevel(id: string, level: string): Promise<void> {
    await this.table("sessions").where("id", id).update({ mfa_level: level, updated_at: this.knexUnscoped.fn.now() });
  }

  /**
   * Invalidates every session a user holds, by moving their epoch on.
   *
   * Returns the new epoch. This is the cheap half of revoke-on-permission-change:
   * one write here beats one write per session, and it also catches sessions
   * created concurrently with the change.
   */
  async bumpUserSessionEpoch(userId: number): Promise<number> {
    await this.table("users").where("id", userId).increment("session_epoch", 1);
    const row = await this.table("users").select("session_epoch").where("id", userId).first();
    return Number((row as { session_epoch?: number } | undefined)?.session_epoch ?? 0);
  }

  async getUserSessionEpoch(userId: number): Promise<number> {
    const row = await this.table("users").select("session_epoch").where("id", userId).first();
    return Number((row as { session_epoch?: number } | undefined)?.session_epoch ?? 0);
  }

  /**
   * Deletes sessions that expired a while ago.
   *
   * Kept past expiry on purpose, and the delay is the point: "when did that
   * session end, and was it revoked or did it just lapse" is a question asked
   * after an incident, not during one.
   */
  async pruneSessions(expiredBefore: number): Promise<number> {
    return await this.table("sessions")
      .where("expires_at", "<", expiredBefore)
      .del()
      .then((n) => Number(n));
  }

  private mapSession(row: Record<string, unknown>): SessionRecord {
    return {
      id: String(row.id),
      user_id: Number(row.user_id),
      active_org_id: row.active_org_id === null || row.active_org_id === undefined ? null : Number(row.active_org_id),
      issued_at: Number(row.issued_at),
      last_seen_at: Number(row.last_seen_at),
      expires_at: Number(row.expires_at),
      revoked_at: row.revoked_at === null || row.revoked_at === undefined ? null : Number(row.revoked_at),
      revoked_reason: (row.revoked_reason as string | null) ?? null,
      epoch: Number(row.epoch),
      mfa_level: String(row.mfa_level ?? "none"),
      ip: (row.ip as string | null) ?? null,
      user_agent: (row.user_agent as string | null) ?? null,
    };
  }
}
