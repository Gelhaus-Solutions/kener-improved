import type { Knex } from "knex";

// I6: grandfather every monitor that is already sending a secret in clear text.
//
// **Why this migration exists at all.** From this release a monitor whose
// resolved config carries a `$SECRET` refuses to run against an unencrypted URL,
// and refuses to be dispatched to a probe, which is a plaintext WebSocket. That
// is the right default and it is also a behaviour change that would break
// working setups on upgrade: an internal API monitor on `http://` with a bearer
// token has been fine for months, and turning it DOWN at 03:00 because the
// operator upgraded is not a security improvement, it is an outage.
//
// So the flag is set here on exactly the monitors that would break. Nothing an
// operator already runs stops working, and everything created or edited
// afterwards is secure unless somebody ticks the box deliberately. The same
// trade `dataRetentionPolicy` made: keep today's behaviour, change the default.
//
// **Deliberately broader than the runtime rule.** The check refuses only when a
// `$NAME` actually resolves to a value in the environment; this grandfathers any
// monitor that *mentions* one. A migration cannot know what the environment will
// look like when the scheduler next runs - it may not even run on the same host
// - so matching the runtime rule exactly would mean guessing, and guessing wrong
// here means an outage. Over-granting the flag costs an unticked box on a
// monitor that never needed it; under-granting costs a broken check.
//
// Idempotent: a monitor that already carries the flag is left alone, and one
// whose `type_data` is unparseable is skipped rather than rewritten.

const MONITORS = "monitors";
const ASSIGNMENTS = "monitor_probe_assignments";

/** Only these two substitute secrets. See `apiCall.ts` and `prometheusCall.ts`. */
const SECRET_BEARING_TYPES = ["API", "PROMETHEUS"];

/**
 * A `$NAME` reference anywhere in the config.
 *
 * Mirrors the shape `GetWordsStartingWithDollar` matches, restated rather than
 * imported: a migration has to keep working against a checkout of `src/` from
 * any later point in time, and this is three lines rather than I3g's 57 keys.
 */
const SECRET_REFERENCE = /\$[A-Za-z_][A-Za-z0-9_]*/;

function isPlaintextUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url) return false;
  try {
    const scheme = new URL(url).protocol;
    return scheme !== "https:" && scheme !== "wss:";
  } catch {
    // Unparseable counts as plaintext, matching `isEncryptedUrl`. Grandfathering
    // it is the safe direction: the runtime rule will refuse it, so a monitor
    // that has been working needs the flag.
    return true;
  }
}

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(MONITORS))) return;

  // Which monitors a probe would be handed. A probe connection is plain `ws://`
  // today - Kener opens no TLS listener - so a secret-bearing monitor assigned
  // to one is already crossing a network in clear text, whatever its own URL
  // scheme says.
  const probed = new Set<string>();
  if (await knex.schema.hasTable(ASSIGNMENTS)) {
    const rows: Array<{ monitor_tag: string }> = await knex(ASSIGNMENTS).select("monitor_tag");
    for (const row of rows) probed.add(row.monitor_tag);
  }

  const monitors: Array<{ tag: string; monitor_type: string; type_data: string | null }> = await knex(MONITORS)
    .whereIn("monitor_type", SECRET_BEARING_TYPES)
    .select("tag", "monitor_type", "type_data");

  for (const monitor of monitors) {
    if (!monitor.type_data) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(monitor.type_data);
    } catch {
      // A row whose config is not JSON is already broken in a way this migration
      // cannot improve, and rewriting it would destroy whatever is in there.
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

    // Already decided, either way. `false` is a deliberate choice too.
    if (parsed.allowPlaintextSecrets !== undefined) continue;

    if (!SECRET_REFERENCE.test(monitor.type_data)) continue;

    const wouldBreak = isPlaintextUrl(parsed.url) || probed.has(monitor.tag);
    if (!wouldBreak) continue;

    parsed.allowPlaintextSecrets = true;
    await knex(MONITORS)
      .where({ tag: monitor.tag })
      .update({ type_data: JSON.stringify(parsed) });
  }
}

export async function down(knex: Knex): Promise<void> {
  // Removes only the flag this migration adds, and only where it is `true`.
  // A monitor an operator has since set to `false` is a decision, not something
  // to undo.
  if (!(await knex.schema.hasTable(MONITORS))) return;

  const monitors: Array<{ tag: string; type_data: string | null }> = await knex(MONITORS)
    .whereIn("monitor_type", SECRET_BEARING_TYPES)
    .select("tag", "type_data");

  for (const monitor of monitors) {
    if (!monitor.type_data) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(monitor.type_data);
    } catch {
      continue;
    }
    if (parsed?.allowPlaintextSecrets !== true) continue;
    delete parsed.allowPlaintextSecrets;
    await knex(MONITORS)
      .where({ tag: monitor.tag })
      .update({ type_data: JSON.stringify(parsed) });
  }
}
