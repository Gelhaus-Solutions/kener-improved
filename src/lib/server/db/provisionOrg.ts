import type { Knex } from "knex";
import monitorSeed from "./seedMonitorData.ts";
import seedPagesData from "./seedPagesData.ts";
import seedSiteData from "./seedSiteData.ts";
import subscriptionAccountCodeTemplate from "../templates/general/subscription_account_code_template.ts";
import subscriptionUpdateTemplate from "../templates/general/subscription_update_template.ts";
import forgotPasswordTemplate from "../templates/general/forgot_password_template.ts";
import inviteUserTemplate from "../templates/general/invite_user_template.ts";
import verifyEmailTemplate from "../templates/general/verify_email_template.ts";
import { permissions } from "../../allPerms.ts";
import { orgPermissions } from "../../orgPerms.ts";
import { tagFromSlug } from "./monitorSlug.ts";

/**
 * Seeding a single organisation.
 *
 * The seeds under `seeds/` all asked "is this table empty?" and stopped there.
 * That was correct while there was exactly one org and is wrong the moment there
 * are two: the second org would find the table non-empty and silently provision
 * nothing, arriving with no monitors and no roles. Every check is now scoped to
 * an org, and the per-org work lives here so that creating an org (I3f) runs the
 * same code a fresh install does rather than a second copy of it that drifts.
 *
 * **Complete as of I3b.** Pages, site data and email templates used to be
 * missing here because `pages.page_path`, `site_data.key` and
 * `general_email_templates.template_id` were globally unique, so a second org's
 * home page (path `""`) or its copy of `siteName` collided with the default
 * org's on insert. I3b made all three keys per-org, so the provisioning that was
 * waiting on it now lives here too.
 *
 * The `seeds/` files are thin wrappers that call into this module with
 * `DEFAULT_ORG_ID`. That is the point: a fresh install and a newly created org
 * run the same code, so the two cannot drift.
 */

/** The org that owns everything predating tenancy. Mirrors `DEFAULT_ORG_ID` in eventContext.ts. */
export const DEFAULT_ORG_ID = 1;

/** The three roles every org gets, matching what `seeds/roles.ts` has always created. */
const READONLY_ROLES = [
  { key: "admin", role_name: "Administrator" },
  { key: "editor", role_name: "Editor" },
  { key: "member", role_name: "Member" },
];

const allPermissionIds = permissions.map((p) => p.id);
const readPermissionIds = allPermissionIds.filter((id) => id.endsWith(".read"));
const orgPermissionIdList = orgPermissions.map((p) => p.id);

/**
 * Which permissions each role key gets.
 *
 * Identical to the mapping `seeds/roles.ts` has always used, including the
 * deliberate choice not to fan fork permissions out to `member` by the
 * ".read goes to member" rule: `audit.read` reaching everybody because of how it
 * is spelled is a real access decision, not a naming coincidence.
 */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [...allPermissionIds, ...orgPermissionIdList],
  editor: allPermissionIds.filter((id) => id !== "api_keys.delete"),
  member: readPermissionIds,
};

/**
 * The primary key for a role in an org.
 *
 * The default org keeps the bare keys (`admin`), which is what makes this
 * migration invisible: every existing `users_roles` row, every seed and every
 * `getRoleById` call site keeps working untouched. Later orgs get namespaced
 * ids so the global string primary key still holds, while `role_key` carries
 * the name the UI shows.
 */
export function roleIdFor(orgId: number, roleKey: string): string {
  return orgId === DEFAULT_ORG_ID ? roleKey : `o${orgId}_${roleKey}`;
}

/** Creates this org's roles and grants, without disturbing any other org's. */
export async function provisionOrgRoles(knex: Knex, orgId: number): Promise<void> {
  const existingPermRows: Array<{ id: string }> = await knex("permissions").select("id");
  const existingPermIds = new Set(existingPermRows.map((p) => p.id));

  for (const role of READONLY_ROLES) {
    const roleId = roleIdFor(orgId, role.key);

    const existing = await knex("roles").where("id", roleId).first();
    if (!existing) {
      await knex("roles").insert({
        id: roleId,
        role_key: role.key,
        org_id: orgId,
        role_name: role.role_name,
        readonly: 1,
        status: "ACTIVE",
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
    }

    // Only grant permissions that exist, so this is safe to run before or after
    // the permissions vocabulary is seeded.
    const wanted = (ROLE_PERMISSIONS[role.key] ?? []).filter((id) => existingPermIds.has(id));
    const held: Array<{ permissions_id: string }> = await knex("roles_permissions")
      .where("roles_id", roleId)
      .select("permissions_id");
    const heldSet = new Set(held.map((h) => h.permissions_id));

    for (const permissionId of wanted) {
      if (heldSet.has(permissionId)) continue;
      await knex("roles_permissions").insert({
        roles_id: roleId,
        permissions_id: permissionId,
        org_id: orgId,
        status: "ACTIVE",
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
    }
  }
}

/**
 * Creates this org's starter monitors.
 *
 * `tag` is built from the org's `tag_prefix` plus the slug, which is what keeps
 * it globally unique across orgs while the slug stays the per-org name. The
 * default org's prefix is empty, so its tags are exactly the slugs and are
 * byte-identical to what every existing install already has.
 */
export async function provisionOrgMonitors(knex: Knex, orgId: number): Promise<void> {
  const org = await knex("orgs").where("id", orgId).first();
  const prefix: string = org?.tag_prefix ?? "";

  const existing = await knex("monitors").where("org_id", orgId).count({ c: "*" }).first();
  if (Number((existing as { c: string | number } | undefined)?.c ?? 0) > 0) return;

  for (const monitor of monitorSeed) {
    const slug = monitor.tag;
    const tag = tagFromSlug(slug, prefix);

    await knex("monitors").insert({
      org_id: orgId,
      tag,
      slug,
      name: monitor.name,
      description: monitor.description,
      image: monitor.image,
      cron: monitor.cron,
      default_status: monitor.default_status,
      status: monitor.status,
      category_name: monitor.category_name,
      monitor_type: monitor.monitor_type,
      type_data: monitor.type_data,
      day_degraded_minimum_count: monitor.day_degraded_minimum_count,
      day_down_minimum_count: monitor.day_down_minimum_count,
      include_degraded_in_downtime: monitor.include_degraded_in_downtime,
      is_hidden: monitor.is_hidden || "NO",
      monitor_settings_json: monitor.monitor_settings_json || null,
      created_at: knex.fn.now(),
      updated_at: knex.fn.now(),
    });
  }
}

/**
 * Creates this org's starter pages and attaches its starter monitors to the home page.
 *
 * The monitor lookups go through the org's `tag_prefix`, because `monitors.tag`
 * is still globally unique and a second org's copy of `earth` is `beta_earth`.
 * Looking up the bare tag would attach the *default org's* monitor to a new
 * tenant's page, which is the exact failure the old code was avoiding by not
 * existing.
 */
export async function provisionOrgPages(knex: Knex, orgId: number): Promise<void> {
  const existing = await knex("pages").where("org_id", orgId).count({ c: "*" }).first();
  if (Number((existing as { c: string | number } | undefined)?.c ?? 0) > 0) return;

  const org = await knex("orgs").where("id", orgId).first();
  const prefix: string = org?.tag_prefix ?? "";
  const taggedAs = (slug: string) => tagFromSlug(slug, prefix);

  for (const page of seedPagesData) {
    const [insertedPage] = await knex("pages")
      .insert({
        org_id: orgId,
        page_path: page.page_path,
        page_title: page.page_title,
        page_header: page.page_header,
        page_subheader: page.page_subheader,
        page_logo: page.page_logo,
        page_settings_json: page.page_settings_json,
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      })
      .returning("id");

    if (page.page_path !== "") continue;

    const pageId = typeof insertedPage === "object" ? insertedPage.id : insertedPage;
    let position = 0;
    for (const slug of ["earth", "kener"]) {
      const tag = taggedAs(slug);
      const monitor = await knex("monitors").where({ tag, org_id: orgId }).first();
      if (!monitor) continue;
      await knex("pages_monitors").insert({
        org_id: orgId,
        page_id: pageId,
        monitor_tag: tag,
        monitor_settings_json: "",
        position,
        created_at: knex.fn.now(),
        updated_at: knex.fn.now(),
      });
      position++;
    }
  }
}

/**
 * Settings that a migration introduced rather than `seedSiteData`, and their defaults.
 *
 * Both were seeded by a one-off migration into whatever org existed at the time,
 * so a newly provisioned org would not have them - and neither code fallback is
 * the value the default org actually got:
 *
 *   - `mfaPolicy` falls back to `local_only`, which would silently make a second
 *     factor **mandatory** for every password user in the new org. A2b changed
 *     the seeded default to `none` precisely to avoid forcing enrolment on
 *     people who had not asked for it, and a new org must inherit that decision
 *     rather than the pre-A2b one.
 *   - `eventBusConsumers` falls back to an empty map, so every consumer would
 *     take its built-in declared mode instead of the instance's chosen ones.
 *
 * These are arguably instance-level rather than per-org, and I3g is where that
 * gets decided properly (instance defaults with per-org overrides). Until then a
 * new org gets its own copy of the same defaults, which is the behaviour that
 * matches the default org.
 */
const MIGRATION_SEEDED_DEFAULTS: Record<string, { value: string; data_type: string }> = {
  mfaPolicy: { value: "none", data_type: "string" },
  eventBusConsumers: {
    value: JSON.stringify({ audit: "live", webhook: "live", email: "live", subscribers: "shadow", triggers: "shadow" }),
    data_type: "object",
  },
};

/**
 * Creates this org's settings from the shipped defaults.
 *
 * Scoped per key rather than "is the table empty", so an org that gained a
 * setting in a later release picks up the new default without losing the values
 * it has already changed. The lookup includes `org_id`: without it a second org
 * finds the default org's row, decides the key is present and provisions
 * nothing, which is exactly what the seed did before I3b made the key per-org.
 */
export async function provisionOrgSiteData(knex: Knex, orgId: number): Promise<void> {
  for (const [key, entry] of Object.entries(MIGRATION_SEEDED_DEFAULTS)) {
    const existing = await knex("site_data").where({ key, org_id: orgId }).first();
    if (existing) continue;
    await knex("site_data").insert({ key, value: entry.value, data_type: entry.data_type, org_id: orgId });
  }

  const defaults = seedSiteData as Record<string, unknown>;
  for (const key of Object.keys(defaults)) {
    const existing = await knex("site_data").where({ key, org_id: orgId }).first();
    if (existing) continue;

    let value = defaults[key];
    const data_type = typeof value;
    if (data_type === "object") value = JSON.stringify(value);

    await knex("site_data").insert({ key, value, data_type, org_id: orgId });
  }
}

/** The templates every org starts with, in the order the seed created them. */
const STARTER_TEMPLATES = [
  subscriptionAccountCodeTemplate,
  subscriptionUpdateTemplate,
  forgotPasswordTemplate,
  inviteUserTemplate,
  verifyEmailTemplate,
];

/**
 * Creates this org's copy of the transactional email templates.
 *
 * Same org-scoped lookup, for the same reason: `general_email_templates` is
 * keyed on `(org_id, template_id)` as of I3b, and a lookup by `template_id`
 * alone would find another org's row.
 */
export async function provisionOrgTemplates(knex: Knex, orgId: number): Promise<void> {
  for (const template of STARTER_TEMPLATES) {
    const existing = await knex("general_email_templates")
      .where({ template_id: template.template_id, org_id: orgId })
      .first();
    if (existing) continue;

    await knex("general_email_templates").insert({
      org_id: orgId,
      template_id: template.template_id,
      template_subject: template.template_subject,
      template_html_body: template.template_html_body,
      template_text_body: template.template_text_body,
    });
  }
}

/**
 * Everything a newly created org needs to be usable.
 *
 * I3e/I3f call this when an operator creates an org. It is deliberately unused
 * until then: extracting it while there is still exactly one org, and the
 * behaviour can be compared against the old seeds row for row, is far safer than
 * retrofitting it alongside the UI that first depends on it.
 *
 * Order matters. Monitors come before pages because the home page attaches them,
 * and roles come first because everything else is meaningless without somebody
 * able to administer it.
 */
export async function provisionOrg(knex: Knex, orgId: number): Promise<void> {
  await provisionOrgRoles(knex, orgId);
  await provisionOrgMonitors(knex, orgId);
  await provisionOrgPages(knex, orgId);
  await provisionOrgSiteData(knex, orgId);
  await provisionOrgTemplates(knex, orgId);
}
