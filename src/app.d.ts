// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      // Set by requestIdHandle, first in the hooks sequence. Always present.
      requestId?: string;
      // Example: set by hooks.server.ts after validating a cookie/JWT.
      user?: import("$lib/server/types/auth").SessionUser;
      // Set by hooks.server.ts for /api/monitors/:monitor_tag/* routes
      monitor?: import("$lib/server/types/db").MonitorRecordTyped;
      // Set by hooks.server.ts for /api/incidents/:incident_id/* routes
      incident?: Omit<import("$lib/server/types/db").IncidentRecord, "incident_source">;
      // Set by hooks.server.ts for /api/maintenances/:maintenance_id/* routes
      maintenance?: import("$lib/server/types/db").MaintenanceRecord;
      // Set by hooks.server.ts for /api/pages/:page_path/* routes
      page?: import("$lib/server/types/db").PageRecord;
      // The API key behind a bearer-authenticated /api/* request, with the
      // scopes it was granted. Set by hooks.server.ts once the key resolves,
      // and the thing route handlers should consult rather than re-reading the
      // Authorization header.
      apiKey?: import("$lib/server/controllers/apiController").ApiKeyPrincipal;
    }

    interface PageData {
      // Example: anything you return from load functions.
      currentUser?: import("$lib/server/types/auth").SessionUser;
    }
    // interface PageState {}
    // interface Platform {}
  }
}

export {};
