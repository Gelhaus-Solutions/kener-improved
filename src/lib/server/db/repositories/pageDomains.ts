import { BaseRepository } from "./base.js";
import { runAcrossOrgs } from "../orgContext.js";

/**
 * G4. Custom hostnames bound to a single status page.
 *
 * **Two access modes, and the difference is the whole security story.**
 *
 *   - `getActivePageDomains` reads across every org, because it is how the org
 *     is *determined* for an incoming request: there is no context to scope by
 *     yet. It is the only method here that does, it says so with
 *     `runAcrossOrgs`, and it returns nothing but what routing needs.
 *   - Everything else is management, called from an admin session where the org
 *     is already established, and goes through the scoped `this.table()`. An
 *     operator can therefore only ever see or change their own org's domains,
 *     including by id: `getPageDomainById` is scoped, so guessing another org's
 *     row id returns nothing rather than somebody else's hostname.
 */

export interface PageDomainRecord {
  id: number;
  org_id: number;
  page_id: number;
  hostname: string;
  status: string;
  is_primary: string;
  verified_at: number | null;
}

export interface PageDomainRoute {
  org_id: number;
  page_id: number;
  hostname: string;
  /** Joined at cache-build time so routing never costs a second lookup. */
  page_path: string;
}

const TABLE = "page_domains";

export class PageDomainsRepository extends BaseRepository {
  /**
   * Every hostname that may serve a page, across all orgs.
   *
   * Cross-tenant on purpose and by declaration. The caller
   * (`http/orgResolve.ts`) caches this for a minute; it is read on the routing
   * path of every public request and changes only when an operator adds a
   * domain.
   */
  async getActivePageDomains(): Promise<PageDomainRoute[]> {
    return await runAcrossOrgs(() =>
      this.knexUnscoped(`${TABLE} as pd`)
        // Inner join, not left: a domain whose page has been deleted must stop
        // resolving rather than resolve to nothing and 500 every request to it.
        .join("pages as p", "p.id", "pd.page_id")
        // KENER-31. The same reasoning applied to the org: a suspended tenant's
        // custom domain must stop serving. Suspension is otherwise enforced
        // everywhere - schedulers, switcher, `/o/<slug>` - and a per-page domain
        // was one of the two holes that let a suspended org keep answering the
        // public on a hostname of its own. See `getActiveOrgDomains`.
        .join("orgs as o", "o.id", "pd.org_id")
        .where("pd.status", "ACTIVE")
        .andWhere("o.status", "ACTIVE")
        .select("pd.org_id", "pd.page_id", "pd.hostname", "p.page_path"),
    );
  }

  /** The domains on one page, for the management screen. Org-scoped. */
  async getPageDomains(pageId: number): Promise<PageDomainRecord[]> {
    return await this.table(TABLE).where({ page_id: pageId }).orderBy("id", "asc").select("*");
  }

  /** Every domain in the current org, for building absolute URLs. */
  async getPageDomainsForOrg(): Promise<PageDomainRecord[]> {
    return await this.table(TABLE).orderBy("id", "asc").select("*");
  }

  async getPageDomainById(id: number): Promise<PageDomainRecord | undefined> {
    return await this.table(TABLE).where({ id }).first();
  }

  /**
   * The hostname to build this page's absolute URLs with, if it has one.
   *
   * Primary first, then any other active domain, so a page with domains but no
   * primary still gets a stable answer rather than none.
   */
  async getPrimaryHostnameForPage(pageId: number): Promise<string | null> {
    const row = await this.table(TABLE)
      .where({ page_id: pageId, status: "ACTIVE" })
      .orderByRaw("case when is_primary = 'YES' then 0 else 1 end")
      .orderBy("id", "asc")
      .first();
    return row?.hostname ?? null;
  }

  async createPageDomain(data: {
    page_id: number;
    hostname: string;
    status?: string;
    is_primary?: string;
  }): Promise<number> {
    const inserted = await this.table(TABLE).insert(
      {
        page_id: data.page_id,
        hostname: data.hostname,
        status: data.status ?? "PENDING",
        is_primary: data.is_primary ?? "NO",
      },
      ["id"],
    );
    const first = Array.isArray(inserted) ? inserted[0] : inserted;
    return typeof first === "object" ? Number((first as { id: number }).id) : Number(first);
  }

  async updatePageDomain(
    id: number,
    patch: { status?: string; is_primary?: string; verified_at?: number | null },
  ): Promise<number> {
    return await this.table(TABLE).where({ id }).update(patch);
  }

  /**
   * Makes one domain the page's primary and demotes the rest.
   *
   * Two statements rather than one, and both scoped: "primary" is a property of
   * the *set*, so promoting without demoting would leave two rows claiming it
   * and `getPrimaryHostnameForPage` picking by id.
   */
  async setPrimaryPageDomain(pageId: number, id: number): Promise<void> {
    await this.table(TABLE).where({ page_id: pageId }).update({ is_primary: "NO" });
    await this.table(TABLE).where({ id, page_id: pageId }).update({ is_primary: "YES" });
  }

  async deletePageDomain(id: number): Promise<number> {
    return await this.table(TABLE).where({ id }).delete();
  }

  /** Whether a hostname is already claimed anywhere, for a useful error message. */
  async hostnameExists(hostname: string): Promise<boolean> {
    const row = await runAcrossOrgs(() => this.knexUnscoped(TABLE).where({ hostname }).first());
    return !!row;
  }
}
