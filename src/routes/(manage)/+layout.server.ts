import { redirect } from "@sveltejs/kit";
import MobileDetect from "mobile-detect";
import type { LayoutServerLoad } from "./$types";
import { IsEmailSetup } from "$lib/server/controllers/controller.js";
import { RequirePermission } from "$lib/server/controllers/userController.js";
import seedSiteData from "$lib/server/db/seedSiteData.js";
import serverResolve from "$lib/server/resolver.js";
import { MERGED_ROUTE_PERMISSION_MAP } from "$lib/routePermissions.js";
import { error } from "@sveltejs/kit";

import { resolve } from "$app/paths";
import { GetAllSiteData, IsSetupComplete, GetLocaleFromCookie } from "$lib/server/controllers/controller.js";
import { GetUserPermissions, GetLoggedInSessionFull } from "$lib/server/controllers/userController.js";
import { RequiresMfaEnrolment } from "$lib/server/controllers/mfaController.js";

export const load: LayoutServerLoad = async ({ cookies, route }) => {
  let isSetupComplete = await IsSetupComplete();
  if (!isSetupComplete) {
    throw redirect(302, serverResolve(`/account/signin`));
  }

  const resolvedSession = await GetLoggedInSessionFull(cookies);
  let loggedInUser = resolvedSession?.user ?? null;

  //if user not set throw redirect to signin
  if (!loggedInUser) {
    throw redirect(302, serverResolve("/account/signin"));
  }

  // A2b: the instance's MFA policy, made binding.
  //
  // Everything under (manage) is behind this, and the enrolment page is
  // deliberately NOT under (manage) - it lives in the (account) group, which has
  // no such guard, so it cannot redirect to itself. `/account/logout` is in the
  // same group for the same reason: a user who cannot enrol must still be able
  // to leave.
  //
  // This covers page loads only. `/manage/api` never runs a layout, so it has
  // its own copy of the check in the action pipeline; see requireMfa.ts.
  if (await RequiresMfaEnrolment(loggedInUser.auth_provider, loggedInUser.id, resolvedSession?.session.mfa_level)) {
    throw redirect(302, serverResolve("/account/mfa-setup"));
  }

  const siteData = await GetAllSiteData();
  const userPermissions = await GetUserPermissions(loggedInUser.id);
  const routeId = route.id || "";

  const requiredPermission = MERGED_ROUTE_PERMISSION_MAP[routeId];
  if (requiredPermission === undefined) {
    throw error(403, "Forbidden");
  }
  if (requiredPermission !== null) {
    try {
      RequirePermission(userPermissions, requiredPermission);
    } catch {
      throw error(403, "Forbidden");
    }
  }

  const siteStatusColors = siteData.colors;
  const siteStatusColorsDark = siteData.colorsDark || siteStatusColors;
  const font = siteData.font || { cssSrc: "", family: "" };
  const defaultSiteTheme = siteData.theme || "system";
  return {
    userDb: loggedInUser,
    userPermissions: [...userPermissions],
    siteStatusColors,
    siteStatusColorsDark,
    font,
    defaultSiteTheme,
    canSendEmail: IsEmailSetup(),
    seedSiteData,
  };
};
