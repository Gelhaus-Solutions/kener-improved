import crypto from "crypto";
import { CreateHash } from "../controllers/commonController.js";

/**
 * H1. The credential an inbound endpoint is addressed by.
 *
 * **Hashed, never stored in the clear**, the same arrangement as a probe token
 * and an API key. Kener only ever needs to *recognise* a presented token, not to
 * replay one, so there is no reason to be able to read it back and every reason
 * not to: this value sits in somebody else's Alertmanager configuration and in a
 * URL, and a database backup should not hand over the ability to post incidents
 * to a status page.
 *
 * The prefix matters for the same reason `kener_` does on an API key. These end
 * up pasted into third-party configuration screens and support tickets, and a
 * bare hex string tells whoever finds one nothing about what it opens or where
 * to revoke it.
 */

const TOKEN_PREFIX = "kener_inbound_";

export function generateInboundToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString("hex");
}

/**
 * The last four characters, which is all the UI ever shows.
 *
 * The token is displayed exactly once, at creation or rotation. After that this
 * is the only thing distinguishing one endpoint's token from another's in a
 * list: useless to an attacker against 256 bits, enough for an operator to match
 * a row against the value in their Alertmanager config.
 */
export function inboundTokenHint(token: string): string {
  return token.slice(-4);
}

export function hashInboundToken(token: string): string {
  return CreateHash(token);
}
