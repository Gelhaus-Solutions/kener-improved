import crypto from "crypto";
import db from "../db/db.js";
import { CreateHash } from "../controllers/commonController.js";
import type { ProbeAgentRecord } from "../db/repositories/probes.js";

/**
 * Probe authentication (B1c).
 *
 * **Not JWTs, deliberately.** A bearer token checked against a stored hash is
 * what `probe_agents` was built for in B1b, and it is the primitive B1c lists as
 * foundation to keep. A JWT would add key management, expiry and rotation
 * semantics to a phase whose transport is explicitly throwaway - and it would
 * have to be revocable anyway, which means a database lookup on every connect,
 * which is the thing a JWT is supposed to avoid.
 *
 * The hash is `CreateHash`, the same HMAC-SHA256 keyed on `KENER_SECRET_KEY`
 * that already guards API keys. Hashed rather than encrypted because Kener never
 * needs to replay a probe's token, only to recognise one - the opposite of
 * `webhook_endpoints.secret_encrypted`, which has to sign outbound requests.
 */

const TOKEN_PREFIX = "kener_probe_";

/**
 * A new probe token.
 *
 * 32 random bytes, hex, behind a prefix that says what it is. The prefix matters
 * for the same reason `kener_` does on an API key: these end up in `.env` files
 * and process lists, and a bare hex string tells whoever finds it nothing about
 * what to revoke.
 */
export function generateProbeToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString("hex");
}

/**
 * The last four characters, which is all the UI ever gets to show.
 *
 * The token is displayed exactly once, at creation. After that `token_hint` is
 * the only thing distinguishing one agent's token from another's in the list,
 * and four hex characters is far too little to help anybody against a 256-bit
 * token but enough to match a row against a value in a config file.
 */
export function tokenHintOf(token: string): string {
  return token.slice(-4);
}

export function hashProbeToken(token: string): string {
  return CreateHash(token);
}

export type ProbeAuthResult =
  | { ok: true; agent: ProbeAgentRecord }
  | { ok: false; reason: "missing" | "unknown" | "disabled" };

/**
 * Resolves a presented token to the agent that holds it.
 *
 * **The index lookup is the real gate, and `timingSafeEqual` is not theatre for
 * it.** The token hash is indexed, so finding the row is an equality lookup
 * whose timing is the database's business, not ours - a constant-time compare
 * cannot change that and is not claimed to. What it does do is make the
 * *confirmation* constant-time, so that a future change which widens this lookup
 * (a prefix scan, a per-org narrowing, a cache) does not quietly introduce a
 * byte-by-byte comparison on the path a stranger can reach. It costs a
 * microsecond and it removes a whole category of later mistake.
 *
 * A disabled agent is refused but distinguished from an unknown token, so the
 * connect log can say which happened. The probe is told neither: both close with
 * the same `UNAUTHORIZED`, because "that token exists but is switched off" is
 * information a stranger should not be able to buy with a connection attempt.
 */
export async function authenticateProbe(token: unknown): Promise<ProbeAuthResult> {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "missing" };
  }

  const presented = hashProbeToken(token);
  const agent = await db.findProbeAgentByTokenHash(presented);
  if (!agent) return { ok: false, reason: "unknown" };

  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(agent.token_hash, "utf8");
  // `timingSafeEqual` throws on a length mismatch rather than returning false,
  // which for two hex digests of the same function can only mean a truncated or
  // hand-edited row. Refusing is right either way.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "unknown" };
  }

  if (agent.status !== "ACTIVE") {
    return { ok: false, reason: "disabled" };
  }

  return { ok: true, agent };
}
