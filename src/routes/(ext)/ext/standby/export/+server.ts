import type { RequestHandler } from "./$types";
import { HandleStandbyExport } from "$lib/server/standby/export";

export const GET: RequestHandler = async ({ request, url }) => HandleStandbyExport(request, url);
