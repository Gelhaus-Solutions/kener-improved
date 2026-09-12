/**
 * Stands in for `knexfile.ts` inside the probe bundle (B1c).
 *
 * `tool.ts` imports the knexfile, and `apiCall` imports `tool.ts` for its secret
 * helpers, so the real one would otherwise be pulled into a daemon that has no
 * database. It is a pure config module - it builds an object and logs which
 * driver it chose - so bundling it would not *break* anything. It would just be
 * a lie: the probe would announce "Configuring database with type sqlite" at
 * startup and carry connection-pool settings it can never use.
 *
 * The whole of the knexfile that anything reachable from here touches is
 * `databaseType`, read by `GetDbType()`, which the probe never calls. If that
 * ever stops being true the honest fix is to stop calling it from probe-reachable
 * code, not to fill this in: a probe that needs to know about Kener's database is
 * a probe that has stopped being a probe.
 */
export default {
  databaseType: "none",
};
