import db from "../db/db.js";
import type { PaginationInput } from "$lib/types/common";
import { GenerateToken, HashPassword, ValidatePassword, VerifyToken } from "./commonController.js";
import { ResolveSession, BumpUserEpoch, RevokeUserSessions } from "./sessionController.js";
import type { Cookies } from "@sveltejs/kit";
import type { UserRecordPublic, UserRecordDashboard, RoleRecord } from "../types/db.js";
import { GetAllSiteData } from "./controller.js";
import { siteDataToVariables } from "../notification/notification_utils.js";
import sendEmail from "../notification/email_notification.js";
import { GetGeneralEmailTemplateById } from "./generalTemplateController.js";

export interface UserUpdateInput {
  userID: number;
  updateKey: string;
  updateValue: string;
}

interface ManualUserUpdateInput {
  updateType: string;
  role_ids?: string[];
  is_active?: number;
  password?: string;
  passwordPlain?: string;
}
interface PasswordUpdateInput {
  userID: number;
  newPassword: string;
  newPlainPassword: string;
}

interface NewUserInput {
  email: string;
  name: string;
  password: string;
  plainPassword: string;
  role_ids: string[];
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const normalizeName = (name: string): string => name.trim().replace(/\s+/g, " ");

const validateEmailOrThrow = (email: string): string => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error("Email cannot be empty");
  }
  if (!EMAIL_REGEX.test(normalizedEmail)) {
    throw new Error("Please enter a valid email address");
  }
  return normalizedEmail;
};

const validateNameOrThrow = (name: string): string => {
  const normalizedName = normalizeName(name);
  if (!normalizedName) {
    throw new Error("Name cannot be empty");
  }
  if (normalizedName.length < 2) {
    throw new Error("Name must be at least 2 characters");
  }
  if (normalizedName.length > 100) {
    throw new Error("Name must be less than 100 characters");
  }
  return normalizedName;
};

export const GetAllUsersPaginated = async (
  data: PaginationInput,
  filter?: { is_active?: number },
): Promise<UserRecordPublic[]> => {
  return await db.getUsersPaginated(data.page, data.limit, filter);
};

export const GetAllUsersPaginatedDashboard = async (
  data: PaginationInput,
  filter?: { is_active?: number },
): Promise<UserRecordDashboard[]> => {
  const users = await db.getUsersPaginated(data.page, data.limit, filter);
  if (users.length === 0) return [];

  // Batch fetch password statuses for all users
  const userIds = users.map((u) => u.id);
  const passwordData = await db.getUserPasswordHashesByIds(userIds);
  const passwordMap = new Map(passwordData.map((p: { id: number; password_hash: string }) => [p.id, p.password_hash]));

  return users.map((u) => ({
    ...u,
    has_password: !!(passwordMap.get(u.id) && passwordMap.get(u.id) !== ""),
  }));
};

export const GetAllUsers = async () => {
  return await db.getAllUsers();
};

/**
 * How many users the **instance** has.
 *
 * Kept instance-wide deliberately: the sign-in screen and the public layout use
 * it to decide whether the install has been set up at all, and an org with no
 * members of its own must not make the instance look empty. The admin users
 * list wants the org's count instead - see `GetOrgUsersCount`.
 */
export const GetUsersCount = async (filter?: { is_active?: number }) => {
  return await db.getTotalUsers(filter);
};

/** How many users the current org has, for the admin list's pagination. */
export const GetOrgUsersCount = async (filter?: { is_active?: number }) => {
  return await db.getOrgUsersCount(filter);
};

export const GetUserPasswordHashById = async (id: number) => {
  return await db.getUserPasswordHashById(id);
};

//getUserById
export const GetUserByID = async (userID: number): Promise<UserRecordPublic | undefined> => {
  return await db.getUserById(userID);
};

//getUserById with has_password for dashboard
export const GetUserByIDDashboard = async (userID: number): Promise<UserRecordDashboard | undefined> => {
  const user = await db.getUserById(userID);
  if (!user) return undefined;

  const passwordData = await db.getUserPasswordHashById(userID);
  return {
    ...user,
    has_password: !!(passwordData && passwordData.password_hash !== ""),
  };
};

//getUserByEmail
export const GetUserByEmail = async (email: string): Promise<UserRecordPublic | undefined> => {
  return await db.getUserByEmail(normalizeEmail(email));
};

export const UpdateUserData = async (data: UserUpdateInput): Promise<number> => {
  let userID = data.userID;
  let updateKey = data.updateKey;
  let updateValue = data.updateValue;

  //if updateKey is password, throw error
  if (updateKey === "password") {
    throw new Error("Password cannot be updated using this method");
  }
  if (updateKey === "role") {
    throw new Error("Role cannot be updated using this method");
  }
  //if updateValue is empty, throw error
  if (!!!updateValue) {
    throw new Error("Update value cannot be empty");
  }

  switch (updateKey) {
    case "name":
      return await db.updateUserName(userID, updateValue);
    case "is_verified":
      return await db.updateIsVerified(userID, parseInt(updateValue));
    default:
      throw new Error("Invalid update key");
  }
};

export const CreateNewUser = async (data: NewUserInput): Promise<number[]> => {
  if (!data.role_ids || data.role_ids.length === 0) {
    throw new Error("At least one role is required");
  }

  // Validate all role_ids exist and are active
  for (const roleId of data.role_ids) {
    const role = await db.getRoleById(roleId);
    if (!role) {
      throw new Error(`Role "${roleId}" does not exist`);
    }
    if (role.status !== "ACTIVE") {
      throw new Error(`Role "${roleId}" is not active`);
    }
  }

  const normalizedEmail = validateEmailOrThrow(data.email);
  const normalizedName = validateNameOrThrow(data.name);

  //if data.password empty, throw error
  if (!!!data.password) {
    throw new Error("Password cannot be empty");
  }

  //if data.password not equal to data.plainPassword, throw error
  if (data.password !== data.plainPassword) {
    throw new Error("Passwords do not match");
  }

  if (!ValidatePassword(data.password)) {
    throw new Error(
      "Password must contain at least 8 characters, one uppercase letter, one lowercase letter and one number",
    );
  }
  let user = {
    email: normalizedEmail,
    password_hash: await HashPassword(data.password),
    name: normalizedName,
    role_ids: data.role_ids,
  };
  return await db.insertUser(user);
};

export const CreateFirstUser = async (data: { email: string; name: string; password: string }): Promise<number[]> => {
  const normalizedEmail = validateEmailOrThrow(data.email);
  const normalizedName = validateNameOrThrow(data.name);
  if (!data.password) {
    throw new Error("Password cannot be empty");
  }
  if (!ValidatePassword(data.password)) {
    throw new Error(
      "Password must contain at least one digit, one lowercase letter, one uppercase letter, and have a minimum length of 8 characters",
    );
  }
  const user = {
    email: normalizedEmail,
    password_hash: await HashPassword(data.password),
    name: normalizedName,
    role_ids: ["admin"],
    is_owner: "YES",
  };
  return await db.insertUser(user);
};

export const UpdatePassword = async (data: PasswordUpdateInput): Promise<number> => {
  let { userID, newPassword, newPlainPassword } = data;
  if (!ValidatePassword(newPassword)) {
    throw new Error(
      "Password must contain at least 8 characters, one uppercase letter, one lowercase letter and one number",
    );
  }
  // newPassword should match newPlainPassword
  if (newPassword !== newPlainPassword) {
    throw new Error("Passwords do not match");
  }

  //hash the password
  let hashedPassword = await HashPassword(newPassword);

  return await db.updateUserPassword({
    id: userID,
    password_hash: hashedPassword,
  });
};

export const ManualUpdateUserData = async (forUserId: number, data: ManualUserUpdateInput): Promise<number | void> => {
  let forUser = await db.getUserById(forUserId);
  if (!forUser) {
    throw new Error("User not found");
  }
  if (data.updateType == "role") {
    if (!data.role_ids || data.role_ids.length === 0) throw new Error("At least one role is required");
    // Owner must always retain the admin role.
    //
    // `users.is_owner` is the *instance* superadmin from P4 onwards, and
    // `org_members.is_org_owner` is the per-org owner. While there is exactly
    // one org the two coincide and this guard is correct as written. It becomes
    // org-aware in I3d, which is what establishes the org context this would
    // need to know *which* org's admin role to insist on.
    if (forUser.is_owner === "YES" && !data.role_ids.includes("admin")) {
      throw new Error("Owner must retain the admin role");
    }
    // Validate all role_ids exist and are active
    for (const roleId of data.role_ids) {
      const role = await db.getRoleById(roleId);
      if (!role) {
        throw new Error(`Role "${roleId}" does not exist`);
      }
      if (role.status !== "ACTIVE") {
        throw new Error(`Role "${roleId}" is not active`);
      }
    }
    const result = await db.updateUserRoles(forUser.id, data.role_ids);
    // Their permissions just changed, so every session they hold must stop
    // being honoured. One write, and it also catches a session created while
    // this was running.
    await BumpUserEpoch(forUser.id);
    return result;
  } else if (data.updateType == "is_active") {
    if (data.is_active === undefined) throw new Error("is_active is required");
    // Owner cannot be deactivated
    if (forUser.is_owner === "YES" && data.is_active === 0) {
      throw new Error("Owner account cannot be deactivated");
    }
    const result = await db.updateUserIsActive(forUser.id, data.is_active);
    if (data.is_active === 0) {
      // Deactivation has to reach sessions that already exist. `ResolveSession`
      // also refuses an inactive user, so this is belt and braces - but it is
      // the half that puts a reason on the row.
      await RevokeUserSessions(forUser.id, "deactivated");
      await BumpUserEpoch(forUser.id);
    }
    return result;
  } else if (data.updateType == "password") {
    if (!data.password || !data.passwordPlain) throw new Error("Password is required");
    const result = await UpdatePassword({
      userID: forUser.id,
      newPassword: data.password,
      newPlainPassword: data.passwordPlain,
    });
    // An administrator setting somebody else's password ends every session that
    // person holds, with no exception: unlike the self-service path there is no
    // session here that is known to belong to the account's owner.
    await RevokeUserSessions(forUser.id, "password_changed");
    return result;
  } else {
    throw new Error(`Unsupported update type: ${data.updateType}`);
  }
};

/**
 * The signed-in user, or null.
 *
 * Now a thin wrapper over `ResolveSession`: the session row decides, and this
 * keeps the signature its three callers already use. See sessionController.ts
 * for what the row is checked against.
 *
 * Two things changed underneath it. The user is fetched **by id**, not by email
 * - the old lookup was a latent identity bug the moment OIDC could change an
 * address, since the session would silently follow whoever held that email
 * next. And a revoked session, an expired one, or one whose permission epoch has
 * moved on now returns null instead of being honoured.
 */
export const GetLoggedInSession = async (cookies: Cookies): Promise<UserRecordPublic | null> => {
  const resolved = await ResolveSession(cookies);
  return resolved ? resolved.user : null;
};

/** The session itself, for callers that need its id or its MFA level. */
export const GetLoggedInSessionFull = async (cookies: Cookies) => {
  return await ResolveSession(cookies);
};

//given a limit return total pages
export const GetTotalUserPages = async (limit: number): Promise<number> => {
  let totalUsers = await db.getTotalUsers();
  if (!totalUsers) return 0;
  let totalPages = Math.ceil(Number(totalUsers.count) / limit);
  return totalPages;
};

//send invitation email to user for account creation
export const SendInvitationEmail = async (email: string, role_ids: string[], name: string) => {
  if (!role_ids || role_ids.length === 0) {
    throw new Error("At least one role is required");
  }

  // Validate all role_ids exist and are active
  for (const roleId of role_ids) {
    const role = await db.getRoleById(roleId);
    if (!role) {
      throw new Error(`Role "${roleId}" does not exist`);
    }
    if (role.status !== "ACTIVE") {
      throw new Error(`Role "${roleId}" is not active`);
    }
  }

  const normalizedEmail = validateEmailOrThrow(email);
  const normalizedName = validateNameOrThrow(name);

  // Check if user with this email already exists
  const existingUser = await db.getUserByEmail(normalizedEmail);
  if (existingUser) {
    throw new Error(`A user with email ${normalizedEmail} already exists`);
  }

  //create user with empty password and is_active = 0
  try {
    await db.insertUser({
      email: normalizedEmail,
      password_hash: "",
      name: normalizedName,
      role_ids: role_ids,
      is_active: 0,
    });
  } catch (error: unknown) {
    // Handle database constraint errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("UNIQUE constraint failed") || errorMessage.includes("duplicate")) {
      throw new Error(`A user with email ${normalizedEmail} already exists`);
    }
    throw error;
  }

  const token = await GenerateToken({
    email: normalizedEmail,
    validTill: Date.now() + 7 * 24 * 60 * 60 * 1000, //7 days
  });

  const siteData = await GetAllSiteData();
  const siteVars = siteDataToVariables(siteData);
  const siteUrl = siteVars.site_url || "";
  let link = `${siteUrl}account/invitation?view=confirm_token&token=${token}`;

  const emailVars = {
    ...siteVars,
    invitation_link: link,
  };

  const template = await GetGeneralEmailTemplateById("invite_user");
  if (template) {
    await sendEmail(
      template.template_html_body || "",
      template.template_subject || "Your Invitation to Join",
      emailVars,
      [normalizedEmail],
      undefined,
      template.template_text_body || "",
    );
  }
};

//resend invitation email to existing user with blank password
export const ResendInvitationEmail = async (email: string) => {
  const normalizedEmail = validateEmailOrThrow(email);

  const user = await db.getUserByEmail(normalizedEmail);
  if (!user) {
    throw new Error("User not found");
  }

  const passwordData = await db.getUserPasswordHashById(user.id);
  if (passwordData && passwordData.password_hash !== "") {
    throw new Error("User has already set their password");
  }

  const token = await GenerateToken({
    email: normalizedEmail,
    validTill: Date.now() + 7 * 24 * 60 * 60 * 1000, //7 days
  });

  const siteData = await GetAllSiteData();
  const siteVars = siteDataToVariables(siteData);
  const siteUrl = siteVars.site_url || "";
  let link = `${siteUrl}account/invitation?view=confirm_token&token=${token}`;

  const emailVars = {
    ...siteVars,
    invitation_link: link,
  };

  const template = await GetGeneralEmailTemplateById("invite_user");
  if (template) {
    await sendEmail(
      template.template_html_body || "",
      template.template_subject || "Your Invitation to Join",
      emailVars,
      [email],
      undefined,
      template.template_text_body || "",
    );
  }
};

// send verification email with verification link
export const SendVerificationEmail = async (toUserId: number, currentUserId: number) => {
  if (!toUserId) {
    throw new Error("User ID is required");
  }

  const user = await db.getUserById(toUserId);
  if (!user) {
    throw new Error("User not found");
  }

  if (user.is_verified) {
    throw new Error("User email is already verified");
  }

  const token = await GenerateToken({
    email: user.email,
    validTill: Date.now() + 24 * 60 * 60 * 1000, //24 hours
  });

  const siteData = await GetAllSiteData();
  const siteVars = siteDataToVariables(siteData);
  const siteUrl = siteVars.site_url || "";
  const verificationLink = `${siteUrl}account/verify?view=confirm_token&token=${token}`;

  const emailVars = {
    ...siteVars,
    verification_link: verificationLink,
  };

  const template = await GetGeneralEmailTemplateById("verify_email");
  if (!template) {
    throw new Error("Verify email template not found");
  }
  await sendEmail(
    template.template_html_body || "",
    template.template_subject || "Verify Your Email",
    emailVars,
    [user.email],
    undefined,
    template.template_text_body || "",
  );
};

/**
 * The built-in role names an operator may not claim.
 *
 * **Keys, not ids.** They are the same string for the default org, whose roles
 * keep their bare ids, and they diverge for every org after it: a second org's
 * administrator role has id `o2_admin` and `role_key` `admin`. Checking the id
 * would let somebody in that org create a role literally called `admin`,
 * colliding with the seeded one in everything a human reads while being a
 * different row. Checking the key is what the guard always meant.
 */
const RESTRICTED_ROLE_KEYS = ["admin", "editor", "member"];
const ROLE_ID_REGEX = /^[a-z0-9_-]+$/;

const normalizeRoleId = (id: string): string => {
  return id.trim().toLowerCase().replace(/\s+/g, "_");
};

export const CreateRole = async (data: { role_id: string; name: string }): Promise<RoleRecord> => {
  const roleId = normalizeRoleId(data.role_id || "");
  const roleName = data.name?.trim();

  if (!roleId) {
    throw new Error("Role ID is required");
  }
  if (!ROLE_ID_REGEX.test(roleId)) {
    throw new Error("Role ID can only contain lowercase letters, numbers, underscores, and hyphens");
  }
  if (!roleName) {
    throw new Error("Role name is required");
  }

  if (RESTRICTED_ROLE_KEYS.includes(roleId)) {
    throw new Error(`Role ID "${roleId}" is restricted and cannot be used`);
  }

  const existing = await db.getRoleById(roleId);
  if (existing) {
    throw new Error(`Role with ID "${roleId}" already exists`);
  }

  await db.insertRole({ id: roleId, role_name: roleName });

  const created = await db.getRoleById(roleId);
  if (!created) {
    throw new Error("Failed to create role");
  }
  return created;
};

export const UpdateRole = async (roleId: string, data: { name?: string; status?: string }): Promise<RoleRecord> => {
  if (!roleId) {
    throw new Error("Role ID is required");
  }

  const existing = await db.getRoleById(roleId);
  if (!existing) {
    throw new Error(`Role "${roleId}" not found`);
  }

  if (existing.readonly === 1) {
    throw new Error("Readonly roles cannot be updated");
  }

  const updates: { role_name?: string; status?: string } = {};

  if (data.name !== undefined) {
    const trimmed = data.name.trim();
    if (!trimmed) {
      throw new Error("Role name cannot be empty");
    }
    updates.role_name = trimmed;
  }

  if (data.status !== undefined) {
    if (data.status !== "ACTIVE" && data.status !== "INACTIVE") {
      throw new Error("Status must be ACTIVE or INACTIVE");
    }
    updates.status = data.status;
  }

  if (Object.keys(updates).length === 0) {
    throw new Error("No valid fields to update");
  }

  await db.updateRole(roleId, updates);

  const updated = await db.getRoleById(roleId);
  if (!updated) {
    throw new Error("Failed to retrieve updated role");
  }
  return updated;
};

export const DeleteRole = async (
  roleId: string,
  options: { action: "migrate"; targetRoleId: string } | { action: "remove" },
): Promise<{ success: true }> => {
  if (!roleId) {
    throw new Error("Role ID is required");
  }

  const existing = await db.getRoleById(roleId);
  if (!existing) {
    throw new Error(`Role "${roleId}" not found`);
  }

  if (existing.readonly === 1) {
    throw new Error("Readonly roles cannot be deleted");
  }

  // Captured before anything moves. After `migrateUsersRole` or the cascade,
  // there is no longer a membership list to read, and these are exactly the
  // users whose permissions are about to change.
  const affectedUsers = await db.getUsersByRoleId(roleId);

  if (options.action === "migrate") {
    const targetRoleId = options.targetRoleId?.trim();
    if (!targetRoleId) {
      throw new Error("Target role ID is required for migration");
    }
    if (targetRoleId === roleId) {
      throw new Error("Target role cannot be the same as the role being deleted");
    }
    const targetRole = await db.getRoleById(targetRoleId);
    if (!targetRole) {
      throw new Error(`Target role "${targetRoleId}" not found`);
    }
    if (targetRole.status !== "ACTIVE") {
      throw new Error("Cannot migrate users to an inactive role");
    }
    await db.migrateUsersRole(roleId, targetRoleId);
  }

  // CASCADE on FK will clean up users_roles and roles_permissions
  await db.deleteRole(roleId);

  for (const user of affectedUsers) {
    await BumpUserEpoch(user.id);
  }

  return { success: true };
};

export const GetAllRoles = async (): Promise<RoleRecord[]> => {
  return await db.getAllRoles();
};

export const GetAllPermissions = async () => {
  return await db.getAllPermissions();
};

export const GetRolePermissions = async (roleId: string) => {
  const role = await db.getRoleById(roleId);
  if (!role) {
    throw new Error(`Role "${roleId}" not found`);
  }
  return await db.getRolePermissions(roleId);
};

export const UpdateRolePermissions = async (roleId: string, permissionIds: string[]) => {
  const role = await db.getRoleById(roleId);
  if (!role) {
    throw new Error(`Role "${roleId}" not found`);
  }
  if (role.readonly === 1) {
    throw new Error("Readonly roles cannot have their permissions modified");
  }

  // Get current permissions
  const current = await db.getRolePermissions(roleId);
  const currentIds = new Set(current.map((p) => p.permissions_id));
  const desiredIds = new Set(permissionIds);

  // Add new permissions
  for (const pid of permissionIds) {
    if (!currentIds.has(pid)) {
      await db.addRolePermission(roleId, pid);
    }
  }

  // Remove old permissions
  for (const pid of currentIds) {
    if (!desiredIds.has(pid)) {
      await db.removeRolePermission(roleId, pid);
    }
  }

  // Every user holding this role just had their permissions change, so each one
  // needs their epoch moved on. Per user rather than a global flush: a role with
  // three members must not sign out the whole instance.
  await BumpEpochForRoleMembers(roleId);

  return await db.getRolePermissions(roleId);
};

/**
 * Moves the epoch on for everybody holding a role.
 *
 * Used wherever a *role* changes rather than a user's membership of one. Never
 * throws, for the same reason `BumpUserEpoch` does not: the permission change
 * itself has already been made, and failing here would report a completed change
 * as an error.
 */
async function BumpEpochForRoleMembers(roleId: string): Promise<void> {
  try {
    const users = await db.getUsersByRoleId(roleId);
    for (const user of users) {
      await BumpUserEpoch(user.id);
    }
  } catch (error) {
    console.error(`session: could not bump epochs for members of role "${roleId}":`, error);
  }
}

export const GetRoleUsers = async (roleId: string) => {
  const role = await db.getRoleById(roleId);
  if (!role) {
    throw new Error(`Role "${roleId}" not found`);
  }
  return await db.getUsersByRoleId(roleId);
};

export const AddUserToRole = async (roleId: string, userId: number) => {
  const role = await db.getRoleById(roleId);
  if (!role) {
    throw new Error(`Role "${roleId}" not found`);
  }
  if (role.status !== "ACTIVE") {
    throw new Error(`Role "${roleId}" is not active`);
  }
  // Check if user already in role
  const users = await db.getUsersByRoleId(roleId);
  if (users.some((u) => u.id === userId)) {
    throw new Error("User is already assigned to this role");
  }
  await db.addUserToRole(roleId, userId);
  await BumpUserEpoch(userId);
  return { success: true };
};

export const RemoveUserFromRole = async (roleId: string, userId: number) => {
  if (roleId === "admin") {
    const user = await db.getUserById(userId);
    if (user && user.is_owner === "YES") {
      throw new Error("The owner cannot be removed from the admin role");
    }
  }
  await db.removeUserFromRole(roleId, userId);
  await BumpUserEpoch(userId);
  return { success: true };
};

export const GetUserPermissions = async (userId: number): Promise<Set<string>> => {
  const permissionIds = await db.getUserPermissionIds(userId);
  return new Set(permissionIds);
};

export const RequirePermission = (userPermissions: Set<string>, permissionId: string): void => {
  if (!userPermissions.has(permissionId)) {
    throw new Error("You do not have permission to perform this action");
  }
};
