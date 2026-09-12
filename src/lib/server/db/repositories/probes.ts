import { BaseRepository } from "./base.js";
import { runAcrossOrgs } from "../orgContext.js";

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
  agent_id: number;
  mode: string;
  created_at: number;
  updated_at: number;
}

/** An assignment joined to the agent that holds it, which is what scheduling needs. */
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

const AGENTS = "probe_agents";
const ASSIGNMENTS = "monitor_probe_assignments";

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

  async deleteProbeAgent(id: number): Promise<number> {
    // The assignments first: they carry no foreign key (the schema deliberately
    // has none), so nothing in the database would otherwise remove them and they
    // would point at an agent id that may later be reused.
    const agent = await this.table(AGENTS).where({ id }).first();
    if (!agent) return 0;
    await this.table(ASSIGNMENTS).where({ agent_id: id }).delete();
    return await this.table(AGENTS).where({ id }).delete();
  }

  /** Every assignment in the org, joined to its agent, for the management screen. */
  async getProbeAssignments(): Promise<ProbeTarget[]> {
    return await this.table(`${ASSIGNMENTS} as a`)
      .join(`${AGENTS} as g`, "g.id", "a.agent_id")
      .orderBy("a.monitor_tag", "asc")
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
    return await this.table(`${ASSIGNMENTS} as a`)
      .join(`${AGENTS} as g`, "g.id", "a.agent_id")
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

  async createProbeAssignment(data: { monitor_tag: string; agent_id: number; mode?: string }): Promise<number> {
    const ts = nowSeconds();
    const inserted = await this.table(ASSIGNMENTS).insert(
      {
        monitor_tag: data.monitor_tag,
        agent_id: data.agent_id,
        mode: data.mode ?? "REMOTE_PREFERRED",
        created_at: ts,
        updated_at: ts,
      },
      ["id"],
    );
    const first = Array.isArray(inserted) ? inserted[0] : inserted;
    return typeof first === "object" ? Number((first as { id: number }).id) : Number(first);
  }

  async deleteProbeAssignment(id: number): Promise<number> {
    return await this.table(ASSIGNMENTS).where({ id }).delete();
  }

  /** Whether this monitor is already assigned to this agent, so the form can say so. */
  async probeAssignmentExists(monitorTag: string, agentId: number): Promise<boolean> {
    const row = await this.table(ASSIGNMENTS).where({ monitor_tag: monitorTag, agent_id: agentId }).first();
    return !!row;
  }

  /** Removes every assignment for a monitor. Called when the monitor itself goes. */
  async deleteProbeAssignmentsForMonitor(monitorTag: string): Promise<number> {
    return await this.table(ASSIGNMENTS).where({ monitor_tag: monitorTag }).delete();
  }
}
