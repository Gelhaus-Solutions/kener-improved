import { BaseRepository } from "./base.js";
import { runAcrossOrgs, currentOrgIdOrDefault } from "../orgContext.js";

/**
 * Remote probe agents and what they are assigned to check (B1b schema, B1c use).
 *
 * **One method here is cross-tenant, and it is the whole security story.**
 * `findProbeAgentByTokenHash` is how the org is *determined* for an arriving
 * probe: a daemon presents a token over a socket and there is no session, no
 * host header and no context to scope by yet. It is the only method that reads
 * across orgs, it says so with `runAcrossOrgs`, and it returns one row found by
 * an unguessable 256-bit token.
 *
 * Everything else is management or scheduling, called from somewhere the org is
 * already established - an admin session, or a BullMQ worker that `q.ts` has
 * already re-entered into the job's org - and goes through the scoped
 * `this.table()`. An operator therefore cannot see or change another org's
 * agents, including by id: `getProbeAgentById` is scoped, so guessing a row id
 * returns nothing rather than somebody else's fleet.
 */

export interface ProbeAgentRecord {
  id: number;
  org_id: number;
  name: string;
  region_id: number;
  token_hash: string;
  token_hint: string | null;
  status: string;
  connection_state: string;
  agent_version: string | null;
  capabilities: string | null;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ProbeAssignmentRecord {
  id: number;
  org_id: number;
  monitor_tag: string;
  region_id: number;
  mode: string;
  /** RULE or OVERRIDE: which half of B1e's configuration produced this row. */
  source: string;
  created_at: number;
  updated_at: number;
}

/** An assignment joined to the agent serving its region, which is what scheduling needs. */
export interface ProbeTarget {
  assignment_id: number;
  monitor_tag: string;
  mode: string;
  agent_id: number;
  agent_name: string;
  region_id: number;
  status: string;
  connection_state: string;
}

/**
 * An assignment as the management screen shows it.
 *
 * Region and no agent, which is the point of B1e: an assignment belongs to a
 * region, so a region whose agents have all been deleted still has its monitors
 * and the screen can say "nothing is serving this region" rather than the rows
 * having quietly disappeared with the agent. Who is serving the region is a
 * separate question with a separate answer, and since a region may hold several
 * agents it is no longer one an assignment row could carry.
 */
export interface ProbeAssignmentView {
  assignment_id: number;
  monitor_tag: string;
  mode: string;
  source: string;
  region_id: number;
}

/** One region's default: what it checks, and how. */
export interface ProbeRegionRuleRecord {
  id: number;
  org_id: number;
  region_id: number;
  rule: string;
  mode: string;
  created_at: number;
  updated_at: number;
}

/** One monitor's exception to a region's rule. */
export interface MonitorRegionOverrideRecord {
  id: number;
  org_id: number;
  monitor_tag: string;
  region_id: number;
  decision: string;
  created_at: number;
  updated_at: number;
}

/**
 * A `regions` row with B1d's cascade columns.
 *
 * The three defaults are nullable and null means "inherit the instance
 * default". A weight of 0 is a real setting - "this region cannot carry a vote"
 * - so absence cannot be spelled 0.
 */
export interface RegionDefaultsRecord {
  id: number;
  org_id: number | null;
  code: string;
  name: string;
  is_active: boolean | number;
  default_weight: number | null;
  default_trust_rank: number | null;
  default_mode: string | null;
}

/** One monitor's policy override. Every setting nullable: null means inherit. */
export interface MonitorMergePolicyRecord {
  id: number;
  org_id: number;
  monitor_tag: string;
  policy: string | null;
  quorum_threshold: number | null;
  degraded_on_disagreement: boolean | number | null;
  created_at: number;
  updated_at: number;
}

/** One monitor's override of one source. `region_id` is -1 for the local check. */
export interface MonitorSourcePolicyRecord {
  id: number;
  org_id: number;
  monitor_tag: string;
  region_id: number;
  weight: number | null;
  trust_rank: number | null;
  mode: string | null;
  created_at: number;
  updated_at: number;
}

const AGENTS = "probe_agents";
const ASSIGNMENTS = "monitor_probe_assignments";
const REGION_RULES = "probe_region_rules";
const REGION_OVERRIDES = "monitor_region_overrides";
const MERGE_POLICIES = "monitor_merge_policies";
const SOURCE_POLICIES = "monitor_source_policies";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export class ProbesRepository extends BaseRepository {
  /**
   * The agent holding this token hash, across every org.
   *
   * Cross-tenant on purpose and by declaration: this is the connect path, and
   * the token is the only thing the caller has presented. The hash is indexed
   * (`idx_probe_agents_token_hash`), so this is one equality lookup rather than
   * a scan of the fleet.
   *
   * Disabled agents are returned rather than filtered out, so the caller can
   * tell "no such token" from "that agent is switched off" and log the second
   * usefully. Both still refuse the connection.
   */
  async findProbeAgentByTokenHash(tokenHash: string): Promise<ProbeAgentRecord | undefined> {
    return await runAcrossOrgs(() => this.knexUnscoped(AGENTS).where({ token_hash: tokenHash }).first());
  }

  /**
   * The regions an agent can be configured for, for the management screen.
   *
   * Region 0 is deliberately **not** here. `regions` is a tenant table and row 0
   * carries a null `org_id`, so a scoped read never returns it - which is
   * correct, because region 0 is a constant (`db/regions.ts`) rather than
   * something to look up. The caller adds it, with the label that explains what
   * choosing it does.
   */
  async getAssignableRegions(): Promise<Array<{ id: number; code: string; name: string; is_active: boolean }>> {
    return await this.table("regions").orderBy("id", "asc").select("id", "code", "name", "is_active");
  }

  /**
   * Adds a region to this org's catalogue.
   *
   * Lives here rather than in a repository of its own because the probes screen
   * is the only thing in Kener that creates one: B1a added the table and seeded
   * the merged verdict, and until an agent needs somewhere to report from, a
   * region is a row nobody has a reason to write. If regions ever gain a manager
   * of their own, this moves there.
   *
   * `code` is unique across the whole table, not per org, so the caller checks
   * for a collision first and reports it as a sentence rather than letting a
   * driver error surface.
   */
  async createRegion(data: { code: string; name: string; description?: string | null }): Promise<number> {
    const inserted = await this.table("regions").insert(
      {
        code: data.code,
        name: data.name,
        description: data.description ?? null,
        is_active: true,
      },
      ["id"],
    );
    const first = Array.isArray(inserted) ? inserted[0] : inserted;
    return typeof first === "object" ? Number((first as { id: number }).id) : Number(first);
  }

  /**
   * Whether a region code is already taken anywhere.
   *
   * Deliberately across orgs: the unique index is global, so a code another
   * tenant holds would fail the insert however well-scoped the caller is.
   */
  async regionCodeExists(code: string): Promise<boolean> {
    const row = await runAcrossOrgs(() => this.knexUnscoped("regions").where({ code }).first());
    return !!row;
  }

  /** Every agent in the current org, for the management screen. */
  async getProbeAgents(): Promise<ProbeAgentRecord[]> {
    return await this.table(AGENTS).orderBy("region_id", "asc").orderBy("id", "asc").select("*");
  }

  async getProbeAgentById(id: number): Promise<ProbeAgentRecord | undefined> {
    return await this.table(AGENTS).where({ id }).first();
  }

  /**
   * Whether another agent already claims this region in this org.
   *
   * B1c runs one agent per region, so two agents sharing one would mean the
   * second could never connect - a failure that would show up as a probe that
   * silently never works rather than as a refused form. `excludeId` lets an edit
   * of an existing agent not collide with itself.
   */
  async regionHasAgent(regionId: number, excludeId?: number): Promise<boolean> {
    const query = this.table(AGENTS).where({ region_id: regionId });
    if (excludeId !== undefined) query.whereNot({ id: excludeId });
    const row = await query.first();
    return !!row;
  }

  async createProbeAgent(data: {
    name: string;
    region_id: number;
    token_hash: string;
    token_hint: string | null;
  }): Promise<number> {
    const ts = nowSeconds();
    const inserted = await this.table(AGENTS).insert(
      {
        name: data.name,
        region_id: data.region_id,
        token_hash: data.token_hash,
        token_hint: data.token_hint,
        status: "ACTIVE",
        connection_state: "DISCONNECTED",
        created_at: ts,
        updated_at: ts,
      },
      ["id"],
    );
    const first = Array.isArray(inserted) ? inserted[0] : inserted;
    return typeof first === "object" ? Number((first as { id: number }).id) : Number(first);
  }

  async updateProbeAgent(
    id: number,
    patch: { name?: string; region_id?: number; status?: string; token_hash?: string; token_hint?: string | null },
  ): Promise<number> {
    return await this.table(AGENTS)
      .where({ id })
      .update({ ...patch, updated_at: nowSeconds() });
  }

  /**
   * Records what a connection observed about an agent.
   *
   * Separate from `updateProbeAgent` because the two have different writers and
   * different meanings: that one is an operator changing configuration, this is
   * the WS server reporting a fact. Folding them together would make it easy for
   * a connection handler to overwrite a name or a region by passing a stale
   * object.
   */
  async setProbeAgentConnection(
    id: number,
    patch: {
      connection_state: string;
      last_seen_at?: number | null;
      agent_version?: string | null;
      capabilities?: string | null;
    },
  ): Promise<number> {
    return await this.table(AGENTS)
      .where({ id })
      .update({ ...patch, updated_at: nowSeconds() });
  }

  /**
   * Resets every agent in the org to DISCONNECTED.
   *
   * Run once at startup. `connection_state` describes a socket held by *this*
   * process, so a row left saying CONNECTED by a process that has since died is
   * not merely stale, it is a claim nothing can retract - the sweeper only ever
   * looks at agents it has a connection for.
   */
  async resetProbeConnectionStates(): Promise<number> {
    return await this.table(AGENTS)
      .whereNot({ connection_state: "DISCONNECTED" })
      .update({ connection_state: "DISCONNECTED", updated_at: nowSeconds() });
  }

  /**
   * Deletes an agent, and deliberately leaves the assignments alone (B1e).
   *
   * This used to delete them, because they named the agent. That made the
   * ordinary way of rotating a probe - delete it, create a new one with a fresh
   * token - silently forget every monitor it was checking, and the operator got
   * an agent that connected, reported healthy and checked nothing. Assignments
   * belong to the region now, so the replacement agent picks them straight back
   * up and the region keeps its configuration between the two.
   */
  async deleteProbeAgent(id: number): Promise<number> {
    const agent = await this.table(AGENTS).where({ id }).first();
    if (!agent) return 0;
    return await this.table(AGENTS).where({ id }).delete();
  }

  /**
   * Every assignment in the org, for the management screen.
   *
   * **No join to `probe_agents`, and that is a correctness fix rather than a
   * tidy-up.** This used to left-join agents on `region_id` so a row could name
   * who was serving it. A region may now hold several agents, and a left join
   * returns one row per matching agent: every assignment in a two-agent region
   * came back twice, with the same `assignment_id`. The screen keys its list on
   * that id, so the duplicate crashed the render outright
   * (`each_key_duplicate`) and the whole page hung on its spinner.
   *
   * Nothing was lost with the join. The screen has been region-first since B1e:
   * it lists a region's agents from the fleet's own `agents` array and its
   * monitors from here, so the agent columns on an assignment row were already
   * dead by the time they became ambiguous. An assignment belongs to a region,
   * never to an agent, which is the whole of B1e.
   */
  async getProbeAssignments(): Promise<ProbeAssignmentView[]> {
    return await this.table(`${ASSIGNMENTS} as a`)
      .orderBy([
        { column: "a.region_id", order: "asc" },
        { column: "a.monitor_tag", order: "asc" },
      ])
      .select("a.id as assignment_id", "a.monitor_tag", "a.mode", "a.source", "a.region_id");
  }

  /**
   * The agents that should check one monitor, for the execute worker.
   *
   * Filtered to ACTIVE agents here rather than by the caller: a disabled agent
   * is one an operator has switched off, and a scheduling path that had to
   * remember to exclude them is a scheduling path that eventually forgets.
   * Connection state is deliberately *not* filtered - whether a probe is
   * reachable right now is the registry's answer, not the database's, and this
   * row can be stale by a whole heartbeat interval.
   */
  async getProbeTargetsForMonitor(monitorTag: string): Promise<ProbeTarget[]> {
    // Joined on the region, not on an agent id the assignment used to carry.
    // A region with no agent simply produces no target, which is the correct
    // answer for scheduling: there is nothing to send the check to.
    return await this.table(`${ASSIGNMENTS} as a`)
      .join(`${AGENTS} as g`, "g.region_id", "a.region_id")
      .where("a.monitor_tag", monitorTag)
      .andWhere("g.status", "ACTIVE")
      .orderBy("g.region_id", "asc")
      .select(
        "a.id as assignment_id",
        "a.monitor_tag",
        "a.mode",
        "g.id as agent_id",
        "g.name as agent_name",
        "g.region_id",
        "g.status",
        "g.connection_state",
      );
  }

  // ---- B1e. The rule, its exceptions, and the rows they resolve to ---------

  async getProbeRegionRules(): Promise<ProbeRegionRuleRecord[]> {
    return await this.table(REGION_RULES).orderBy("region_id", "asc").select("*");
  }

  async setProbeRegionRule(data: { region_id: number; rule: string; mode: string }): Promise<void> {
    const ts = nowSeconds();
    await this.table(REGION_RULES)
      .insert({ ...data, created_at: ts, updated_at: ts })
      .onConflict(["org_id", "region_id"])
      .merge({ rule: data.rule, mode: data.mode, updated_at: ts });
  }

  async getMonitorRegionOverrides(): Promise<MonitorRegionOverrideRecord[]> {
    return await this.table(REGION_OVERRIDES).orderBy(["region_id", "monitor_tag"]).select("*");
  }

  async setMonitorRegionOverride(data: { monitor_tag: string; region_id: number; decision: string }): Promise<void> {
    const ts = nowSeconds();
    await this.table(REGION_OVERRIDES)
      .insert({ ...data, created_at: ts, updated_at: ts })
      .onConflict(["monitor_tag", "region_id"])
      .merge({ decision: data.decision, updated_at: ts });
  }

  /** Drops an exception, so the monitor goes back to whatever the region's rule says. */
  async deleteMonitorRegionOverride(monitorTag: string, regionId: number): Promise<number> {
    return await this.table(REGION_OVERRIDES).where({ monitor_tag: monitorTag, region_id: regionId }).delete();
  }

  /** The stored resolved rows, in the shape the resolver compares against. */
  async getResolvedAssignments(): Promise<
    Array<{ monitor_tag: string; region_id: number; mode: string; source: string }>
  > {
    return await this.table(ASSIGNMENTS).select("monitor_tag", "region_id", "mode", "source");
  }

  /**
   * Brings the stored rows in line with what the rules and exceptions mean.
   *
   * The caller wraps this in `db.withTransaction`: a half-applied reconcile is a
   * fleet checking a set of monitors nobody configured, and the next reconcile
   * would have no way to tell that from a deliberate state. It is not opened
   * here because a repository has no business deciding transaction boundaries
   * for work that also reads the monitor list.
   */
  async applyAssignmentDiff(diff: {
    create: Array<{ monitor_tag: string; region_id: number; mode: string; source: string }>;
    update: Array<{ monitor_tag: string; region_id: number; mode: string; source: string }>;
    remove: Array<{ monitor_tag: string; region_id: number }>;
  }): Promise<void> {
    const ts = nowSeconds();

    for (const row of diff.remove) {
      await this.table(ASSIGNMENTS).where({ monitor_tag: row.monitor_tag, region_id: row.region_id }).delete();
    }
    for (const row of diff.update) {
      await this.table(ASSIGNMENTS)
        .where({ monitor_tag: row.monitor_tag, region_id: row.region_id })
        .update({ mode: row.mode, source: row.source, updated_at: ts });
    }
    if (diff.create.length > 0) {
      await this.table(ASSIGNMENTS).insert(diff.create.map((row) => ({ ...row, created_at: ts, updated_at: ts })));
    }
  }

  /**
   * Removes a monitor's assignments and its exceptions. Called when the monitor
   * itself goes.
   *
   * The exceptions matter as much as the assignments: an `INCLUDE` left behind
   * for a deleted tag would silently reassign a monitor created with the same
   * tag later.
   */
  async deleteProbeAssignmentsForMonitor(monitorTag: string): Promise<number> {
    await this.table(REGION_OVERRIDES).where({ monitor_tag: monitorTag }).delete();
    return await this.table(ASSIGNMENTS).where({ monitor_tag: monitorTag }).delete();
  }

  // ---- B1d. The merge cascade -------------------------------------------

  /**
   * Every region this org can be told about, including the two instance rows.
   *
   * Unscoped on purpose, and this is the one place in B1d that needs saying out
   * loud. `regions` is a tenant table, but ids 0 and -1 carry a null `org_id`
   * because the merged verdict and the server's own check belong to the
   * instance, not to a tenant - so a scoped read returns a tenant's own regions
   * and silently omits `local`, which is the source the cascade most needs to
   * configure. Reading across orgs here exposes nothing: a region row is a code,
   * a name and three default numbers, and the samples that name it are still
   * scoped everywhere they are read.
   */
  async getMergeRegions(): Promise<RegionDefaultsRecord[]> {
    const orgId = currentOrgIdOrDefault();
    return await runAcrossOrgs(() =>
      this.knexUnscoped("regions")
        .where("org_id", orgId)
        .orWhereNull("org_id")
        .orderBy("id", "asc")
        .select("id", "org_id", "code", "name", "is_active", "default_weight", "default_trust_rank", "default_mode"),
    );
  }

  /**
   * Renames a region: its code, its display name, or its description.
   *
   * Separate from `updateRegionDefaults` rather than one wider patch, because
   * the two carry different risk. The defaults are numbers the merge reads;
   * `code` is an identifier under a global unique index, and a caller that can
   * write one has no business writing the other by passing an extra key.
   *
   * Scoped, unlike the defaults update. That one is unscoped so an operator can
   * configure `local` and `merged`, which carry a null org. Nothing here needs
   * that: a renameable region always belongs to somebody, and the reserved rows
   * are refused at the action before they reach this method. So the `org_id`
   * predicate stays on, and one tenant cannot rename another's region even if
   * the id is guessed.
   */
  async updateRegion(
    regionId: number,
    patch: { code?: string; name?: string; description?: string | null },
  ): Promise<number> {
    if (Object.keys(patch).length === 0) return 0;
    // `regions.created_at`/`updated_at` are real timestamp columns, not the
    // integer seconds most of this schema uses, so `nowSeconds()` would write a
    // small integer into a timestamp here.
    return await this.table("regions")
      .where({ id: regionId })
      .update({ ...patch, updated_at: this.knexUnscoped.fn.now() });
  }

  async updateRegionDefaults(
    regionId: number,
    patch: { default_weight?: number | null; default_trust_rank?: number | null; default_mode?: string | null },
  ): Promise<number> {
    // Unscoped for the same reason as the read: the rows an operator most wants
    // to configure are `local` and `merged`, and both carry a null org.
    return await runAcrossOrgs(() => this.knexUnscoped("regions").where({ id: regionId }).update(patch));
  }

  /** One monitor's policy override, or undefined when it inherits everything. */
  async getMonitorMergePolicy(monitorTag: string): Promise<MonitorMergePolicyRecord | undefined> {
    return await this.table(MERGE_POLICIES).where({ monitor_tag: monitorTag }).first();
  }

  /**
   * Writes one monitor's policy override.
   *
   * Upserts on `monitor_tag`, matching the unique index exactly. Naming the
   * composite `["org_id", "monitor_tag"]` here would have no arbiter to resolve
   * against on Postgres and would throw - the index is on the tag alone, because
   * the tag is already globally unique.
   */
  async setMonitorMergePolicy(
    monitorTag: string,
    patch: { policy?: string | null; quorum_threshold?: number | null; degraded_on_disagreement?: boolean | null },
  ): Promise<void> {
    const ts = nowSeconds();
    await this.table(MERGE_POLICIES)
      .insert({ monitor_tag: monitorTag, ...patch, created_at: ts, updated_at: ts })
      .onConflict("monitor_tag")
      .merge({ ...patch, updated_at: ts });
  }

  async deleteMonitorMergePolicy(monitorTag: string): Promise<number> {
    return await this.table(MERGE_POLICIES).where({ monitor_tag: monitorTag }).delete();
  }

  /** One monitor's per-source overrides. Usually empty. */
  async getMonitorSourcePolicies(monitorTag: string): Promise<MonitorSourcePolicyRecord[]> {
    return await this.table(SOURCE_POLICIES).where({ monitor_tag: monitorTag }).orderBy("region_id", "asc");
  }

  async setMonitorSourcePolicy(
    monitorTag: string,
    regionId: number,
    patch: { weight?: number | null; trust_rank?: number | null; mode?: string | null },
  ): Promise<void> {
    const ts = nowSeconds();
    await this.table(SOURCE_POLICIES)
      .insert({ monitor_tag: monitorTag, region_id: regionId, ...patch, created_at: ts, updated_at: ts })
      .onConflict(["monitor_tag", "region_id"])
      .merge({ ...patch, updated_at: ts });
  }

  async deleteMonitorSourcePolicy(monitorTag: string, regionId: number): Promise<number> {
    return await this.table(SOURCE_POLICIES).where({ monitor_tag: monitorTag, region_id: regionId }).delete();
  }

  /** Clears both override levels for a monitor. Called when the monitor itself goes. */
  async deleteMergePoliciesForMonitor(monitorTag: string): Promise<void> {
    await this.table(SOURCE_POLICIES).where({ monitor_tag: monitorTag }).delete();
    await this.table(MERGE_POLICIES).where({ monitor_tag: monitorTag }).delete();
  }
}
