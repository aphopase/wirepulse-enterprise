import { audit } from "./db.mjs";
import { HttpError } from "./http.mjs";
import { enforce, lockWorkspace, usageOf } from "./quota.mjs";
import { announceRevoked } from "./stream.mjs";

// Everything that gives a provisioned person access to a workspace, or takes it away. Callers hold the workspace lock (lockWorkspace) and
// finish with their audit event, as everywhere else: the audit chain serializes writers until commit.

// A seat for someone who is about to count as a member: current members and everyone already waiting for one (invitations, provisioned
// people who have not signed in yet).
export async function enforceSeat(client, plan, workspaceId) {
  const usage = await usageOf(client, workspaceId);
  enforce(plan, "members", plan.limits.members, usage.members + usage.pendingInvitations);
}

export async function grantAccess(client, workspaceId, { subject, email, role }) {
  await client.query(
    "INSERT INTO workspace_members (workspace_id, subject, email, role) VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, subject) DO UPDATE SET role = EXCLUDED.role, email = EXCLUDED.email",
    [workspaceId, subject, email, role]
  );
}

// Locks the administrators so a concurrent demotion or removal cannot leave the workspace without one.
async function guardLastAdministrator(client, workspaceId, leaving) {
  const admins = (await client.query("SELECT subject FROM workspace_members WHERE workspace_id = $1 AND role = 'administrator' FOR UPDATE", [workspaceId])).rows.map((row) => row.subject);
  if (admins.length && admins.every((subject) => leaving.has(subject))) throw new HttpError(409, "last_administrator");
}

// A key outlives its creator's membership unless it is revoked with it: whoever leaves must not keep a working credential they made.
export async function revokeKeysCreatedBy(client, workspaceId, subjects) {
  return (await client.query("UPDATE api_keys SET revoked_at = now() WHERE workspace_id = $1 AND created_by = ANY($2::text[]) AND revoked_at IS NULL RETURNING id", [workspaceId, subjects])).rows.map((row) => row.id);
}

// Withdraws access from a provisioned person: the member they are bound to and any member that signed in with the same address (an invited
// person is not tied to the provisioning record until now, and must not outlive it), and the API keys those members created. Open live
// streams are ended on every instance. Returns the subjects removed and the ids of the keys revoked.
export async function revokeAccess(client, workspaceId, scimUser) {
  const targets = (await client.query("SELECT subject FROM workspace_members WHERE workspace_id = $1 AND (subject = $2 OR lower(email) = $3) FOR UPDATE", [workspaceId, scimUser.subject, scimUser.email])).rows.map((row) => row.subject);
  if (!targets.length) return { subjects: [], apiKeys: [] };
  await guardLastAdministrator(client, workspaceId, new Set(targets));
  await client.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND subject = ANY($2::text[])", [workspaceId, targets]);
  for (const subject of targets) await announceRevoked(client, workspaceId, subject);
  return { subjects: targets, apiKeys: await revokeKeysCreatedBy(client, workspaceId, targets) };
}

export async function changeRole(client, workspaceId, subject, role) {
  if (role !== "administrator") await guardLastAdministrator(client, workspaceId, new Set([subject]));
  await client.query("UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND subject = $2", [workspaceId, subject, role]);
}

// A person the identity provider has provisioned becomes a member the first time they sign in with the address it gave: the OIDC
// address must be verified (the same trust invitations rely on), and a provisioning record binds to one subject only, so a second account
// with the same address gets nothing. Called when a signed-in person has no role in a workspace (workspaceId) and when they list
// their workspaces (all of them). Returns whether any access was granted.
export async function bindProvisioned(db, req, workspaceId = null) {
  const { identity } = req;
  if (identity.kind !== "user" || !identity.email) return false;
  const waiting = (await db.query("SELECT workspace_id FROM scim_users WHERE email = $1 AND active AND subject IS NULL AND ($2::uuid IS NULL OR workspace_id = $2)", [identity.email, workspaceId])).rows;
  let granted = false;
  for (const { workspace_id: id } of waiting) {
    const done = await db.transaction(async (client) => {
      try { await lockWorkspace(client, id); } catch (error) { if (error.status === 404) return false; throw error; } // offboarded meanwhile
      const row = (await client.query("SELECT id, role FROM scim_users WHERE workspace_id = $1 AND email = $2 AND active AND subject IS NULL FOR UPDATE", [id, identity.email])).rows[0];
      if (!row) return false; // another request bound it first
      // An existing member (invited earlier) keeps their role; provisioning only attaches the record to them.
      await client.query("INSERT INTO workspace_members (workspace_id, subject, email, role) VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, subject) DO NOTHING", [id, identity.subject, identity.email, row.role]);
      await client.query("UPDATE scim_users SET subject = $2, bound_at = now(), updated_at = now() WHERE id = $1", [row.id, identity.subject]);
      await audit(client, { workspaceId: id, actor: identity.subject, action: "scim.member_bound", resourceType: "member", resourceId: row.id, requestId: req.requestId, ip: req.ip, details: { role: row.role } });
      return true;
    });
    granted ||= done;
  }
  return granted;
}
