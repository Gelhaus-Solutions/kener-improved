import type { Knex } from "knex";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// Encrypts the OIDC client secret that has been sitting in `site_data` as
// plaintext.
//
// It was only ever masked on read, which protects it from a glance at the admin
// UI and from nothing else: a database backup, a read replica or a support dump
// contained the credential in full.
//
// **The crypto below is duplicated from `src/lib/server/crypto/secretBox.ts` on
// purpose.** Migrations run outside the application - under Node's TypeScript
// stripping, with no bundler and no path aliases - so they cannot import from
// `src`, which is why they also check `knex.client.config.client` directly
// instead of using `db/capabilities.ts`. Thirty duplicated lines is the price of
// that isolation. They must stay in step: if the format in secretBox.ts ever
// changes, this file keeps producing the old one and the application stops being
// able to read what this wrote.
//
// **The key comes from `KENER_SECRET_KEY`, so this is only meaningful when
// migrations run with the same value the application does.** That is already
// true of every deployment: the same variable signs every JWT and HMACs every
// API key hash.
//
// Reversible: `down` decrypts, so rolling back to a release that expects
// plaintext leaves a working login rather than a broken one.

const VERSION = "v1";
const PURPOSE = "oidc-client-secret";
const DUMMY_SECRET = "kener-dummy-secret";

function key(): Buffer {
  const master = process.env.KENER_SECRET_KEY || DUMMY_SECRET;
  return Buffer.from(hkdfSync("sha256", Buffer.from(master, "utf8"), Buffer.alloc(0), `kener:${PURPOSE}`, 32));
}

function isSealed(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return false;
  try {
    return Buffer.from(parts[1], "base64url").length === 12 && Buffer.from(parts[2], "base64url").length === 16;
  } catch {
    return false;
  }
}

function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function open(sealed: string): string | null {
  const [, ivB64, tagB64, dataB64] = sealed.split(".");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Reads the settings blob, or null when it is missing or unparseable. */
async function readSettings(knex: Knex): Promise<Record<string, unknown> | null> {
  if (!(await knex.schema.hasTable("site_data"))) return null;
  const row = (await knex("site_data").select("value").where("key", "oidcSettings").first()) as
    | { value: string | null }
    | undefined;
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as Record<string, unknown>;
  } catch {
    // Failing the migration over an unparseable settings blob would block every
    // later migration behind it, for a row that is already broken.
    console.warn("oidcSettings is not valid JSON; leaving it alone");
    return null;
  }
}

export async function up(knex: Knex): Promise<void> {
  const settings = await readSettings(knex);
  if (!settings) return;

  const secret = settings.client_secret;
  if (typeof secret !== "string" || secret.length === 0 || isSealed(secret)) return;

  settings.client_secret = seal(secret);
  await knex("site_data")
    .where("key", "oidcSettings")
    .update({ value: JSON.stringify(settings) });
  console.log("Encrypted the OIDC client secret at rest");
}

export async function down(knex: Knex): Promise<void> {
  const settings = await readSettings(knex);
  if (!settings) return;

  const secret = settings.client_secret;
  if (typeof secret !== "string" || !isSealed(secret)) return;

  const plain = open(secret);
  if (plain === null) {
    // Cannot decrypt, so cannot roll this row back. Leaving the ciphertext is
    // strictly better than writing an empty secret, which would look like a
    // working configuration and fail every login.
    console.warn("Could not decrypt the OIDC client secret; leaving it encrypted");
    return;
  }

  settings.client_secret = plain;
  await knex("site_data")
    .where("key", "oidcSettings")
    .update({ value: JSON.stringify(settings) });
}
