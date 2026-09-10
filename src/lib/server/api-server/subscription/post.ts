import { json, error } from "@sveltejs/kit";
import type { APIServerRequest } from "$lib/server/types/api-server";
import type { SubscriptionsConfig } from "$lib/server/types/db.js";
import { GetSiteDataByKey } from "$lib/server/controllers/siteDataController";
import { VerifyCaptchaToken } from "$lib/server/controllers/captchaController";
import {
  SubscriberLogin,
  VerifySubscriberOTP,
  VerifySubscriberToken,
  UpdateSubscriberPreferences,
  UpdateSubscriberScope,
  RemoveSubscriberScope,
  SetSubscriberScopeMode,
  GetScopedSubscriptions,
  GetLabelledScopes,
  GetScopeMode,
} from "$lib/server/controllers/userSubscriptionsController";
import { GetScopeOptionsForPage } from "$lib/server/controllers/subscriptionScopeOptions";

interface LoginRequest {
  action: "login";
  email: string;
  captchaToken?: string | null;
}

interface VerifyRequest {
  action: "verify";
  email: string;
  code: string;
}

interface GetPreferencesRequest {
  action: "getPreferences";
  token: string;
  /**
   * The page the dialog is standing on, so it can offer that page and its
   * components (E1b). Absent, or unknown, simply means no pickers are offered -
   * the severity floor and the on/off switches still work everywhere.
   */
  page_path?: string;
}

interface UpdatePreferencesRequest {
  action: "updatePreferences";
  token: string;
  incidents?: boolean;
  maintenances?: boolean;
}

/**
 * Narrows an existing subscription (E1).
 *
 * Separate from `updatePreferences`, which owns the all-or-nothing pair, because
 * these are different questions: one is "do you want incident mail at all", the
 * other is "which of it". A bare subscribe still means everything.
 */
interface UpdateScopeRequest {
  action: "updateScope";
  token: string;
  event_class: "incidents" | "maintenances";
  scope_type?: "ALL" | "PAGE" | "COMPONENT" | "GROUP";
  scope_id?: string;
  min_severity?: string;
  enabled?: boolean;
}

/** Removes one narrow scope (E1b). Widens back to everything if it was the last. */
interface RemoveScopeRequest {
  action: "removeScope";
  token: string;
  event_class: "incidents" | "maintenances";
  scope_type: "PAGE" | "COMPONENT" | "GROUP";
  scope_id: string;
}

/** Switches an event class between everything and only-what-I-chose (E1b). */
interface SetScopeModeRequest {
  action: "setScopeMode";
  token: string;
  event_class: "incidents" | "maintenances";
  mode: "ALL" | "NARROW";
}

type PostRequestBody =
  | LoginRequest
  | VerifyRequest
  | GetPreferencesRequest
  | UpdatePreferencesRequest
  | UpdateScopeRequest
  | RemoveScopeRequest
  | SetScopeModeRequest;

export default async function post(req: APIServerRequest): Promise<Response> {
  const body = req.body as PostRequestBody;
  const { action } = body;

  // Check if subscriptions are enabled
  const config = await GetSubscriptionConfig();
  if (!config || !config.enable) {
    return error(400, { message: "Subscriptions are not enabled" });
  }

  const emailEnabled = config.methods?.emails?.incidents === true || config.methods?.emails?.maintenances === true;
  if (!emailEnabled) {
    return error(400, { message: "Email subscriptions are not enabled" });
  }

  switch (action) {
    case "login":
      return handleLogin((body as LoginRequest).email, (body as LoginRequest).captchaToken, config);
    case "verify":
      return handleVerify((body as VerifyRequest).email, (body as VerifyRequest).code);
    case "getPreferences":
      return handleGetPreferences(
        (body as GetPreferencesRequest).token,
        config,
        (body as GetPreferencesRequest).page_path,
      );
    case "updatePreferences":
      return handleUpdatePreferences(
        (body as UpdatePreferencesRequest).token,
        (body as UpdatePreferencesRequest).incidents,
        (body as UpdatePreferencesRequest).maintenances,
        config,
      );
    case "updateScope": {
      const scopeBody = body as UpdateScopeRequest;
      const result = await UpdateSubscriberScope(scopeBody.token, {
        event_class: scopeBody.event_class,
        scope_type: scopeBody.scope_type,
        scope_id: scopeBody.scope_id,
        min_severity: scopeBody.min_severity,
        enabled: scopeBody.enabled,
      });
      if (!result.success) return error(400, { message: result.error ?? "Could not update the subscription" });
      return json({ success: true });
    }
    case "removeScope": {
      const removeBody = body as RemoveScopeRequest;
      const result = await RemoveSubscriberScope(removeBody.token, {
        event_class: removeBody.event_class,
        scope_type: removeBody.scope_type,
        scope_id: removeBody.scope_id,
      });
      if (!result.success) return error(400, { message: result.error ?? "Could not remove the subscription" });
      // The dialog needs to know it was widened, because that flips the mode
      // control without the subscriber having touched it.
      return json({ success: true, widened: result.widened === true });
    }
    case "setScopeMode": {
      const modeBody = body as SetScopeModeRequest;
      const result = await SetSubscriberScopeMode(modeBody.token, modeBody.event_class, modeBody.mode);
      if (!result.success) return error(400, { message: result.error ?? "Could not change the subscription" });
      return json({ success: true });
    }
    default:
      return error(400, { message: "Invalid action" });
  }
}

async function GetSubscriptionConfig(): Promise<SubscriptionsConfig | null> {
  const subscriptionsSettings = await GetSiteDataByKey("subscriptionsSettings");
  if (!subscriptionsSettings) {
    return null;
  }
  return subscriptionsSettings as SubscriptionsConfig;
}

async function handleLogin(
  email: string,
  captchaToken: string | null | undefined,
  config: SubscriptionsConfig,
): Promise<Response> {
  const captchaResult = await VerifyCaptchaToken(captchaToken);
  if (!captchaResult.success) {
    return error(400, { message: "Captcha verification failed" });
  }

  const result = await SubscriberLogin(email);
  if (!result.success) {
    return error(400, { message: result.error || "Failed to send verification code" });
  }

  return json({ success: true, message: "Verification code sent" });
}

async function handleVerify(email: string, code: string): Promise<Response> {
  const result = await VerifySubscriberOTP(email, code);
  if (!result.success) {
    return error(400, { message: result.error || "Verification failed" });
  }

  return json({ success: true, token: result.token });
}

async function handleGetPreferences(token: string, config: SubscriptionsConfig, pagePath?: string): Promise<Response> {
  const result = await VerifySubscriberToken(token);
  if (!result.success) {
    return error(401, { message: result.error || "Invalid token" });
  }

  // The severity floor on the all-scope incidents subscription, which is the one
  // the preferences screen can show without knowing anything about pages or
  // components. A subscriber with no scoped row yet has no floor: ANY.
  //
  // Read off the ALL row whatever its status, because a subscriber who narrowed
  // has a retired ALL row and would otherwise see their floor silently reset to
  // "Everything" on the very screen that is meant to show it.
  let minSeverity = "ANY";
  let scopes: Awaited<ReturnType<typeof GetLabelledScopes>> = [];
  let scopeMode = { incidents: "ALL" as "ALL" | "NARROW", maintenances: "ALL" as "ALL" | "NARROW" };
  if (result.method) {
    const scoped = await GetScopedSubscriptions(result.method.id);
    minSeverity = scoped.find((r) => r.event_class === "incidents" && r.scope_type === "ALL")?.min_severity ?? "ANY";
    scopes = await GetLabelledScopes(result.method.id);
    scopeMode = {
      incidents: await GetScopeMode(result.method.id, "incidents"),
      maintenances: await GetScopeMode(result.method.id, "maintenances"),
    };
  }

  return json({
    success: true,
    email: result.user?.email,
    subscriptions: result.subscriptions,
    minSeverity,
    scopes,
    scopeMode,
    // What this particular page can offer as a scope. Null when the dialog did
    // not say where it is, or said somewhere that is not a page.
    scopeOptions: await GetScopeOptionsForPage(pagePath),
    availableSubscriptions: {
      incidents: config.methods?.emails?.incidents === true,
      maintenances: config.methods?.emails?.maintenances === true,
    },
  });
}

async function handleUpdatePreferences(
  token: string,
  incidents: boolean | undefined,
  maintenances: boolean | undefined,
  config: SubscriptionsConfig,
): Promise<Response> {
  // Only allow updating subscriptions that are enabled in config
  const preferences: { incidents?: boolean; maintenances?: boolean } = {};

  if (incidents !== undefined && config.methods?.emails?.incidents) {
    preferences.incidents = incidents;
  }
  if (maintenances !== undefined && config.methods?.emails?.maintenances) {
    preferences.maintenances = maintenances;
  }

  const result = await UpdateSubscriberPreferences(token, preferences);
  if (!result.success) {
    return error(400, { message: result.error || "Failed to update preferences" });
  }

  return json({ success: true });
}
