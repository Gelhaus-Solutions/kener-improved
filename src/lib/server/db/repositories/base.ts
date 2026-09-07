import type { Knex as KnexType } from "knex";
import { getWorkerKnex } from "../poolContext.js";
import { getTrx } from "../trxContext.js";

// Filter types for queries
export interface MonitorFilter {
  status?: string;
  category_name?: string;
  id?: number;
  monitor_type?: string;
  tag?: string;
  is_hidden?: string;
  tags?: string[];
  search?: string;
}

export interface TriggerFilter {
  status?: string;
  id?: number;
}

export interface IncidentFilter {
  status?: string;
  start?: number;
  end?: number;
  state?: string;
  id?: number;
  incident_type?: string;
  incident_source?: string;
}

export interface CountResult {
  count: string | number;
}

/**
 * Base repository class that provides access to the Knex instance
 */
export abstract class BaseRepository {
  private readonly fallbackKnex: KnexType;

  constructor(knex: KnexType) {
    this.fallbackKnex = knex;
  }

  /**
   * The Knex instance for the current execution context.
   *
   * Resolved per call, in priority order:
   *
   *   1. An ambient transaction, if one is open (db.withTransaction). Everything
   *      inside it must go through the same connection or it is not in the
   *      transaction at all, so this wins over any pool choice.
   *   2. The worker connection pool, when running inside a background job
   *      (set in queues/q.ts). This keeps a burst of jobs from exhausting the
   *      connections that serve page loads.
   *   3. The web pool this repository was constructed with: SvelteKit requests,
   *      startup, anything else.
   *
   * See trxContext.ts, poolContext.ts and knexfile.ts.
   */
  protected get knex(): KnexType {
    return getTrx() ?? getWorkerKnex() ?? this.fallbackKnex;
  }
}
