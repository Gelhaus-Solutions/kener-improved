import { BaseRepository } from "./base.js";
import type { MfaRecoveryCodeRecord, MfaTotpRecord } from "../../types/db.js";

export class MfaRepository extends BaseRepository {
  async getTotp(userId: number): Promise<MfaTotpRecord | undefined> {
    const row = await this.knex("user_mfa_totp").select("*").where("user_id", userId).first();
    return row ? this.mapTotp(row as Record<string, unknown>) : undefined;
  }

  /**
   * Stores a new, unconfirmed secret, replacing any previous one.
   *
   * Delete-then-insert rather than an upsert, because restarting enrolment must
   * clear `confirmed_at` and `last_used_step` as well as the secret. An upsert
   * that only wrote the secret would leave a fresh secret marked confirmed and a
   * replay guard pointing at a step from the old one.
   */
  async putUnconfirmedTotp(userId: number, secretEnc: string, now: number): Promise<void> {
    await this.knex("user_mfa_totp").where("user_id", userId).del();
    await this.knex("user_mfa_totp").insert({
      user_id: userId,
      secret_enc: secretEnc,
      confirmed_at: null,
      last_used_step: null,
      created_at: now,
      updated_at: now,
    });
  }

  /** Marks enrolment complete, and only from the unconfirmed state. */
  async confirmTotp(userId: number, now: number, step: number): Promise<boolean> {
    const updated = await this.knex("user_mfa_totp")
      .where("user_id", userId)
      .whereNull("confirmed_at")
      .update({ confirmed_at: now, last_used_step: step, updated_at: now })
      .then((n) => Number(n));
    return updated > 0;
  }

  /**
   * Consumes a time step, but only if it is newer than the last one used.
   *
   * The condition is the replay guard, and it lives in the UPDATE rather than in
   * a read-then-write for a reason: two requests presenting the same code at the
   * same moment would both pass a check-then-update, which is exactly the race an
   * attacker replaying an observed code creates. Here the database decides, and
   * exactly one of them gets the row.
   */
  async consumeTotpStep(userId: number, step: number, now: number): Promise<boolean> {
    const updated = await this.knex("user_mfa_totp")
      .where("user_id", userId)
      .andWhere((qb) => qb.whereNull("last_used_step").orWhere("last_used_step", "<", step))
      .update({ last_used_step: step, updated_at: now })
      .then((n) => Number(n));
    return updated > 0;
  }

  async deleteTotp(userId: number): Promise<void> {
    await this.knex("user_mfa_totp").where("user_id", userId).del();
  }

  /** Replaces every recovery code. Regenerating always invalidates the old set. */
  async replaceRecoveryCodes(userId: number, hashes: string[], now: number): Promise<void> {
    await this.knex("user_mfa_recovery_codes").where("user_id", userId).del();
    if (hashes.length === 0) return;
    await this.knex("user_mfa_recovery_codes").insert(
      hashes.map((code_hash) => ({ user_id: userId, code_hash, used_at: null, created_at: now })),
    );
  }

  async getUnusedRecoveryCodes(userId: number): Promise<MfaRecoveryCodeRecord[]> {
    const rows = (await this.knex("user_mfa_recovery_codes")
      .select("*")
      .where("user_id", userId)
      .whereNull("used_at")
      .orderBy("id", "asc")) as Record<string, unknown>[];
    return rows.map((r) => this.mapRecovery(r));
  }

  /**
   * Spends one recovery code, and only if it has not been spent.
   *
   * Conditional for the same reason as the TOTP step: without it, two requests
   * presenting the same code both succeed.
   */
  async useRecoveryCode(id: number, now: number): Promise<boolean> {
    const updated = await this.knex("user_mfa_recovery_codes")
      .where("id", id)
      .whereNull("used_at")
      .update({ used_at: now })
      .then((n) => Number(n));
    return updated > 0;
  }

  async countRecoveryCodes(userId: number): Promise<{ total: number; unused: number }> {
    const rows = (await this.knex("user_mfa_recovery_codes").select("used_at").where("user_id", userId)) as Record<
      string,
      unknown
    >[];
    return {
      total: rows.length,
      unused: rows.filter((r) => r.used_at === null || r.used_at === undefined).length,
    };
  }

  async deleteRecoveryCodes(userId: number): Promise<void> {
    await this.knex("user_mfa_recovery_codes").where("user_id", userId).del();
  }

  /**
   * The ids of every user holding a *confirmed* factor.
   *
   * Unconfirmed rows are excluded deliberately: a half-finished enrolment is
   * exactly the state the coverage screen must report as "not covered", and
   * counting it would tell an operator they are protected when they are not.
   *
   * Returned as a list rather than a count because both callers need it - the
   * settings screen counts it, and the users screen marks individual rows - and
   * the number of admin users is small enough that one query beats two.
   */
  async getUserIdsWithConfirmedTotp(): Promise<number[]> {
    const rows = (await this.knex("user_mfa_totp").select("user_id").whereNotNull("confirmed_at")) as Record<
      string,
      unknown
    >[];
    return rows.map((r) => Number(r.user_id));
  }

  private mapTotp(row: Record<string, unknown>): MfaTotpRecord {
    return {
      user_id: Number(row.user_id),
      secret_enc: String(row.secret_enc),
      confirmed_at: row.confirmed_at === null || row.confirmed_at === undefined ? null : Number(row.confirmed_at),
      last_used_step:
        row.last_used_step === null || row.last_used_step === undefined ? null : Number(row.last_used_step),
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  private mapRecovery(row: Record<string, unknown>): MfaRecoveryCodeRecord {
    return {
      id: Number(row.id),
      user_id: Number(row.user_id),
      code_hash: String(row.code_hash),
      used_at: row.used_at === null || row.used_at === undefined ? null : Number(row.used_at),
      created_at: Number(row.created_at),
    };
  }
}
