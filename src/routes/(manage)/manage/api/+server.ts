import type { RequestHandler } from "./$types";
import { runAction } from "$lib/server/manage/pipeline";

// The admin write surface. Every action is resolved by the registry in
// $lib/server/manage, which also owns authentication, authorization and the
// rest of the middleware order. See manage/pipeline.ts.
export const POST: RequestHandler = (event) => runAction(event);
