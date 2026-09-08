import { describe, it, expect } from "vitest";
import { roleIdFor, ROLE_PERMISSIONS, DEFAULT_ORG_ID } from "./provisionOrg.js";
import { permissions } from "../../allPerms.js";
import { orgPermissions } from "../../orgPerms.js";

// The two pure decisions behind org provisioning. Both are the kind that look
// obviously right and are load-bearing in a way that only shows up much later:
// a wrong role id silently detaches a tenant's roles from its users, and a wrong
// permission mapping quietly hands an org more access than it should have.

describe("roleIdFor", () => {
  it("leaves the default org's role ids bare", () => {
    // This is what makes the whole migration invisible. Every existing
    // `users_roles` row, every seed and every `getRoleById` call site refers to
    // these strings, and namespacing them would break all three at once.
    expect(roleIdFor(DEFAULT_ORG_ID, "admin")).toBe("admin");
    expect(roleIdFor(DEFAULT_ORG_ID, "editor")).toBe("editor");
    expect(roleIdFor(DEFAULT_ORG_ID, "member")).toBe("member");
  });

  it("namespaces every other org", () => {
    expect(roleIdFor(2, "admin")).toBe("o2_admin");
    expect(roleIdFor(37, "member")).toBe("o37_member");
  });

  it("keeps ids unique across orgs for the same role key", () => {
    // `roles.id` is still a global primary key, so two orgs' administrator roles
    // have to be different strings.
    const ids = [1, 2, 3].map((org) => roleIdFor(org, "admin"));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("ROLE_PERMISSIONS", () => {
  const allIds = permissions.map((p) => p.id);
  const orgIds = orgPermissions.map((p) => p.id);

  it("gives admin everything, upstream and fork alike", () => {
    expect([...ROLE_PERMISSIONS.admin].sort()).toEqual([...allIds, ...orgIds].sort());
  });

  it("withholds api_keys.delete from editor", () => {
    // The one permission upstream reserves for admins.
    expect(ROLE_PERMISSIONS.editor).not.toContain("api_keys.delete");
    expect(ROLE_PERMISSIONS.admin).toContain("api_keys.delete");
  });

  it("gives member only read permissions", () => {
    expect(ROLE_PERMISSIONS.member.every((id) => id.endsWith(".read"))).toBe(true);
  });

  it("does not fan fork permissions out to editor or member", () => {
    // Deliberate: `audit.read` reaching every member purely because of how it is
    // spelled is a real access decision, and it should be made by an operator
    // rather than by a naming coincidence.
    for (const role of ["editor", "member"] as const) {
      for (const orgPermission of orgIds) {
        expect(ROLE_PERMISSIONS[role]).not.toContain(orgPermission);
      }
    }
  });

  it("grants nothing that is not a real permission", () => {
    const known = new Set([...allIds, ...orgIds]);
    for (const [role, granted] of Object.entries(ROLE_PERMISSIONS)) {
      for (const id of granted) {
        expect(known.has(id), `${role} is granted unknown permission ${id}`).toBe(true);
      }
    }
  });
});
