import express from "express";
import { z } from "zod";
import { HttpError, h, isDatabaseUnavailable } from "./http.mjs";
import { newToken, requireHuman, sha256 } from "./auth.mjs";
import { enforce, lockWorkspace, usageOf } from "./quota.mjs";
import { changeRole, enforceSeat, grantAccess, revokeAccess } from "./provision.mjs";

// SCIM 2.0 (RFC 7643/7644) provisioning for one workspace per bearer token: an identity provider (Okta, Microsoft Entra ID, ...)
// creates, updates and deactivates people, and keeps directory Groups in sync. Group membership is descriptive: it never grants access
// or changes a person's workspace role. Bulk and sorting are not supported. Roles come from the User `roles` attribute.
const ROLES = ["viewer", "engineer", "maintainer", "administrator"];
const NS = "urn:ietf:params:scim";
const SCHEMA = { user: `${NS}:schemas:core:2.0:User`, group: `${NS}:schemas:core:2.0:Group`, list: `${NS}:api:messages:2.0:ListResponse`, patch: `${NS}:api:messages:2.0:PatchOp`, error: `${NS}:api:messages:2.0:Error`, config: `${NS}:schemas:core:2.0:ServiceProviderConfig`, type: `${NS}:schemas:core:2.0:ResourceType`, schema: `${NS}:schemas:core:2.0:Schema` };
const UNIQUE = { scim_users_user_name: "userName", scim_users_email: "email", scim_users_external_id: "externalId", scim_groups_display_name: "displayName", scim_groups_external_id: "externalId" };
const MAX_PAGE = 200;

const fail = (status, scimType, detail) => new HttpError(status, detail, { scimType });
const send = (res, status, body) => res.status(status).type("application/scim+json").send(JSON.stringify(body));

// ---- the User resource ----
const resource = (row, base) => ({
  schemas: [SCHEMA.user], id: row.id,
  ...(row.external_id ? { externalId: row.external_id } : {}),
  userName: row.user_name,
  ...(row.given_name || row.family_name ? { name: { ...(row.given_name ? { givenName: row.given_name } : {}), ...(row.family_name ? { familyName: row.family_name } : {}) } } : {}),
  ...(row.display_name ? { displayName: row.display_name } : {}),
  emails: [{ value: row.email, type: "work", primary: true }],
  active: row.active,
  roles: [{ value: row.role, primary: true }],
  meta: { resourceType: "User", created: row.created_at, lastModified: row.updated_at, location: `${base}/Users/${row.id}` }
});
const groupResource = (row, members, base) => ({
  schemas: [SCHEMA.group], id: row.id,
  ...(row.external_id ? { externalId: row.external_id } : {}),
  displayName: row.display_name,
  ...(members.length ? { members: members.map((member) => ({ value: member.id, ...(member.user_name ? { display: member.user_name } : {}) })) } : {}),
  meta: { resourceType: "Group", created: row.created_at, lastModified: row.updated_at, location: `${base}/Groups/${row.id}` }
});
const GROUP_MEMBER_COLUMNS = "u.id, u.user_name";
async function groupMembers(executor, workspaceId, groupId) {
  return (await executor.query(`SELECT ${GROUP_MEMBER_COLUMNS} FROM scim_group_members gm JOIN scim_users u ON u.id = gm.user_id AND u.workspace_id = gm.workspace_id WHERE gm.workspace_id = $1 AND gm.group_id = $2 ORDER BY u.user_name, u.id`, [workspaceId, groupId])).rows;
}
async function groupWithMembers(executor, workspaceId, groupId) {
  const row = (await executor.query("SELECT * FROM scim_groups WHERE id = $1 AND workspace_id = $2", [groupId, workspaceId])).rows[0];
  return row ? { row, members: await groupMembers(executor, workspaceId, groupId) } : null;
}
function groupIdFromMember(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.value !== "string" || !value.value) throw fail(400, "invalidValue", "each group member needs a user id in value");
  return value.value;
}
function memberIdsFrom(value) {
  const members = Array.isArray(value) ? value : [value];
  return [...new Set(members.map(groupIdFromMember))];
}
async function replaceGroupMembers(client, workspaceId, groupId, memberIds) {
  const found = memberIds.length ? (await client.query("SELECT id FROM scim_users WHERE workspace_id = $1 AND id = ANY($2::uuid[])", [workspaceId, memberIds])).rows.map((row) => row.id) : [];
  if (found.length !== memberIds.length) throw fail(400, "invalidValue", "every group member must be a provisioned user in this workspace");
  await client.query("DELETE FROM scim_group_members WHERE workspace_id = $1 AND group_id = $2", [workspaceId, groupId]);
  if (found.length) await client.query("INSERT INTO scim_group_members (workspace_id, group_id, user_id) SELECT $1, $2, id FROM unnest($3::uuid[]) AS member_id(id)", [workspaceId, groupId, found]);
}
function groupChangesFromResource(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "invalidSyntax", "the body must be a Group resource");
  const displayName = textFrom(body.displayName, "displayName", 256);
  if (!displayName?.trim()) throw fail(400, "invalidValue", "displayName is required and at most 256 characters");
  return { displayName: displayName.trim(), externalId: textFrom(body.externalId, "externalId", 256), members: body.members === undefined ? [] : memberIdsFrom(body.members) };
}
function groupChangesFromPatch(body) {
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) throw fail(400, "invalidSyntax", "a PatchOp needs an Operations array of {op, path?, value?}");
  const changes = {};
  const set = (path, value, remove) => {
    const key = path.replace(new RegExp(`^${SCHEMA.group}:`, "i"), "").toLowerCase();
    if (key === "displayname") { if (remove) throw required("displayName"); const displayName = textFrom(value, "displayName", 256)?.trim(); if (!displayName) throw fail(400, "invalidValue", "displayName is required and at most 256 characters"); changes.displayName = displayName; }
    else if (key === "externalid") changes.externalId = remove ? null : textFrom(value, "externalId", 256);
    else if (key === "members") changes.members = remove ? [] : memberIdsFrom(value);
  };
  for (const operation of parsed.data.Operations) {
    const op = operation.op.toLowerCase();
    if (!["add", "replace", "remove"].includes(op)) throw fail(400, "invalidSyntax", `unsupported op ${operation.op}`);
    if (operation.path) {
      const key = operation.path.replace(new RegExp(`^${SCHEMA.group}:`, "i"), "").toLowerCase();
      if (key === "members" && op === "add") { changes.addMembers = [...new Set([...(changes.addMembers ?? []), ...memberIdsFrom(operation.value)])]; continue; }
      if (key === "members" && op === "remove" && operation.value !== undefined) { changes.removeMembers = [...new Set([...(changes.removeMembers ?? []), ...memberIdsFrom(operation.value)])]; continue; }
      set(operation.path, operation.value, op === "remove"); continue;
    }
    if (op === "remove" || !operation.value || typeof operation.value !== "object" || Array.isArray(operation.value)) throw fail(400, "invalidValue", "without a path the value must be an object of attributes");
    for (const [path, value] of Object.entries(operation.value)) {
      const key = path.replace(new RegExp(`^${SCHEMA.group}:`, "i"), "").toLowerCase();
      if (key === "members" && op === "add") changes.addMembers = [...new Set([...(changes.addMembers ?? []), ...memberIdsFrom(value)])];
      else set(path, value, false);
    }
  }
  return changes;
}

const emailSchema = z.string().trim().toLowerCase().email().max(254);
function parseEmail(value) {
  const parsed = emailSchema.safeParse(value);
  if (!parsed.success) throw fail(400, "invalidValue", "the email address is not valid");
  return parsed.data;
}
function emailFrom(emails, userName) {
  const list = Array.isArray(emails) ? emails.filter((entry) => entry && typeof entry.value === "string") : [];
  const chosen = list.find((entry) => entry.primary === true) ?? list.find((entry) => entry.type === "work") ?? list[0];
  const value = chosen?.value ?? (userName?.includes("@") ? userName : null);
  if (!value) throw fail(400, "invalidValue", "an email address is required: send emails, or an email-format userName");
  return parseEmail(value);
}
function roleFrom(roles) {
  const list = (Array.isArray(roles) ? roles : [roles]).map((entry) => (typeof entry === "string" ? { value: entry } : entry)).filter((entry) => entry && typeof entry.value === "string");
  const chosen = list.find((entry) => entry.primary === true) ?? list[0];
  if (!chosen) return "viewer"; // an emptied role list is least privilege, not an error
  const role = chosen.value.trim().toLowerCase();
  if (!ROLES.includes(role)) throw fail(400, "invalidValue", `role must be one of ${ROLES.join(", ")}`);
  return role;
}
function activeFrom(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|false)$/i.test(value)) return value.toLowerCase() === "true"; // Entra sends "True"/"False"
  throw fail(400, "invalidValue", "active must be true or false");
}
function textFrom(value, name, max) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > max) throw fail(400, "invalidValue", `${name} must be text of at most ${max} characters`);
  return value;
}
function userNameFrom(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 254) throw fail(400, "invalidValue", "userName is required and at most 254 characters");
  return value.trim();
}

// A full User (POST, PUT) as the set of attributes it states. `active` and `role` are only present when the client sent them.
function changesFromResource(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "invalidSyntax", "the body must be a User resource");
  const userName = userNameFrom(body.userName);
  const changes = {
    userName, email: emailFrom(body.emails, userName), externalId: textFrom(body.externalId, "externalId", 256), displayName: textFrom(body.displayName, "displayName", 256),
    givenName: textFrom(body.name?.givenName, "name.givenName", 128), familyName: textFrom(body.name?.familyName, "name.familyName", 128)
  };
  if (body.active !== undefined) changes.active = activeFrom(body.active);
  if (body.roles !== undefined) changes.role = roleFrom(body.roles);
  return changes;
}

const patchSchema = z.object({ Operations: z.array(z.looseObject({ op: z.string(), path: z.string().max(300).optional(), value: z.unknown().optional() })).min(1).max(50) });
const required = (name) => fail(400, "mutability", `${name} is required and cannot be removed`);
function patchOne(changes, op, rawPath, value) {
  const key = rawPath.replace(new RegExp(`^${SCHEMA.user}:`, "i"), "").toLowerCase();
  const clear = op === "remove";
  if (key === "active") { if (clear) throw required("active"); changes.active = activeFrom(value); }
  else if (key === "username") { if (clear) throw required("userName"); changes.userName = userNameFrom(value); }
  else if (key === "externalid") changes.externalId = clear ? null : textFrom(value, "externalId", 256);
  else if (key === "displayname") changes.displayName = clear ? null : textFrom(value, "displayName", 256);
  else if (key === "name.givenname") changes.givenName = clear ? null : textFrom(value, "name.givenName", 128);
  else if (key === "name.familyname") changes.familyName = clear ? null : textFrom(value, "name.familyName", 128);
  else if (key === "name") {
    if (clear) { changes.givenName = null; changes.familyName = null; return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw fail(400, "invalidValue", "name must be an object");
    if ("givenName" in value) changes.givenName = textFrom(value.givenName, "name.givenName", 128);
    if ("familyName" in value) changes.familyName = textFrom(value.familyName, "name.familyName", 128);
  } else if (/^emails(\[.*\])?(\.value)?$/.test(key)) {
    if (clear) throw required("emails");
    changes.email = typeof value === "string" ? parseEmail(value) : Array.isArray(value) ? emailFrom(value) : emailFrom([value]);
  } else if (/^roles(\[.*\])?(\.value)?$/.test(key)) changes.role = clear ? "viewer" : roleFrom(value);
  // Any other attribute is something WirePulse does not keep (RFC 7644 lets a service provider ignore those).
}
function changesFromPatch(body) {
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) throw fail(400, "invalidSyntax", "a PatchOp needs an Operations array of {op, path?, value?}");
  const changes = {};
  for (const operation of parsed.data.Operations) {
    const op = operation.op.toLowerCase();
    if (!["add", "replace", "remove"].includes(op)) throw fail(400, "invalidSyntax", `unsupported op ${operation.op}`);
    if (operation.path) { patchOne(changes, op, operation.path, operation.value); continue; }
    // Okta sends the attributes as one object with no path.
    if (op === "remove") throw fail(400, "noTarget", "remove needs a path");
    if (!operation.value || typeof operation.value !== "object" || Array.isArray(operation.value)) throw fail(400, "invalidValue", "without a path the value must be an object of attributes");
    for (const [path, value] of Object.entries(operation.value)) patchOne(changes, op, path, value);
  }
  return changes;
}

// ---- `attributes` / `excludedAttributes` (RFC 7644 section 3.4.2.5): which parts of a user a read returns. `id` and `schemas` always are. ----
const attributeList = (value) => (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []).filter((name) => typeof name === "string")
  .map((name) => name.trim().replace(new RegExp(`^${SCHEMA.user}:`, "i"), "").toLowerCase()).filter(Boolean);
function project(body, { attributes, excludedAttributes }) {
  const include = attributeList(attributes);
  const exclude = include.length ? [] : attributeList(excludedAttributes); // `attributes` wins when both are sent
  if (!include.length && !exclude.length) return body;
  const narrow = (value, names, keep) => { const pick = (item) => Object.fromEntries(Object.entries(item).filter(([name]) => names.includes(name.toLowerCase()) === keep)); return Array.isArray(value) ? value.map(pick) : pick(value); };
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    const name = key.toLowerCase();
    const parts = (list) => list.filter((entry) => entry.startsWith(`${name}.`)).map((entry) => entry.slice(name.length + 1));
    if (name === "id" || name === "schemas") out[key] = value;
    else if (include.length) {
      if (include.includes(name)) out[key] = value;
      else if (parts(include).length && value && typeof value === "object") out[key] = narrow(value, parts(include), true);
    } else if (!exclude.includes(name)) out[key] = parts(exclude).length && value && typeof value === "object" ? narrow(value, parts(exclude), false) : value;
  }
  return out;
}

// ---- filters: the equality lookups identity providers use to find a user before creating or matching one ----
const FILTER = /^\s*([A-Za-z][A-Za-z0-9_.]*)\s+eq\s+("(?:[^"\\]|\\.)*")\s*$/i;
const FILTERABLE = { username: ["lower(user_name) = lower($2)"], externalid: ["external_id = $2"], id: ["id::text = lower($2)"], "emails.value": ["email = lower($2)"] };
function filterClause(filter) {
  const match = filter === undefined ? null : FILTER.exec(filter);
  if (filter !== undefined && !match) throw fail(400, "invalidFilter", 'only `userName`, `externalId`, `id` or `emails.value` with `eq "value"` can be filtered');
  if (!match) return null;
  const column = FILTERABLE[match[1].toLowerCase()];
  let value;
  try { value = JSON.parse(match[2]); } catch { throw fail(400, "invalidFilter", "the filter value is not a valid quoted string"); }
  if (!column) throw fail(400, "invalidFilter", `cannot filter on ${match[1]}`);
  return { sql: column[0], value };
}

// Errors in the SCIM format, which is what identity providers read to decide whether to retry and what to show an admin.
function scimErrors({ log, metrics }) {
  return (error, req, res, _next) => {
    if (res.headersSent) return res.destroy();
    const reply = (status, scimType, detail) => send(res, status, { schemas: [SCHEMA.error], status: String(status), ...(scimType ? { scimType } : {}), detail });
    if (error instanceof z.ZodError) return reply(400, "invalidValue", error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ").slice(0, 400));
    if (error instanceof HttpError) {
      if (error.code === "invalid_identifier") return reply(404, undefined, "resource not found");
      const detail = error.code === "plan_limit_reached" ? `plan_limit_reached: ${error.details.resource} is limited to ${error.details.limit} on the ${error.details.plan} plan` : error.code;
      return reply(error.status, error.details?.scimType, detail);
    }
    if (error.type === "entity.too.large") return reply(413, undefined, "payload_too_large");
    if (error.type === "entity.parse.failed" || error.type === "encoding.unsupported" || error.type === "charset.unsupported") return reply(400, "invalidSyntax", "the body is not valid JSON");
    if (error.type === "request.aborted") return undefined;
    switch (error.code) {
      case "23505": return reply(409, "uniqueness", `${UNIQUE[error.constraint] ?? "a unique attribute"} already exists`);
      case "22P02": case "22007": case "22003": case "22021": case "22P05": return reply(400, "invalidValue", "invalid value");
      case "57014": metrics?.dbTimeouts.inc(); (req.log ?? log).error({ err: error }, "database statement timeout"); return reply(503, undefined, "database_timeout");
      default: break;
    }
    if (isDatabaseUnavailable(error)) { (req.log ?? log).error({ err: error }, "database unavailable"); return reply(503, undefined, "database_unavailable"); }
    (req.log ?? log).error({ err: error }, "unhandled request error");
    return reply(500, undefined, "internal_error");
  };
}

const TOKEN_COLUMNS = "id, name, token_prefix, created_by, created_at, expires_at, last_used_at, revoked_at";
const tokenView = (row) => ({ id: row.id, name: row.name, prefix: row.token_prefix, createdBy: row.created_by, createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at });
const stateOf = (row) => (!row.active ? "deactivated" : row.subject ? "active" : "pending");
const provisionedView = (row) => ({ id: row.id, userName: row.user_name, email: row.email, displayName: row.display_name, externalId: row.external_id, role: row.role, state: stateOf(row), createdAt: row.created_at, updatedAt: row.updated_at, boundAt: row.bound_at, deactivatedAt: row.deactivated_at });

export function registerScimRoutes(app, { db, config, auth, apiAudit, log, metrics, limiters }) {
  const ws = "/v1/workspaces/:workspaceId";
  const administrator = auth.requireRole("administrator");

  // ---- administration: the tokens an identity provider uses, and who it has provisioned ----
  const tokenSchema = z.object({ name: z.string().trim().min(1).max(120), expiresInDays: z.number().int().min(1).max(config.scimTokenMaxDays).optional() }).strict();
  app.get(`${ws}/scim/tokens`, administrator, h(async (req, res) => {
    const result = await db.query(`SELECT ${TOKEN_COLUMNS} FROM scim_tokens WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200`, [req.workspaceId]);
    res.json(result.rows.map(tokenView));
  }));
  app.post(`${ws}/scim/tokens`, administrator, requireHuman, h(async (req, res) => {
    const body = tokenSchema.parse(req.body);
    const token = newToken("wps");
    const days = body.expiresInDays ?? Math.min(365, config.scimTokenMaxDays);
    const created = await db.transaction(async (client) => {
      const plan = await lockWorkspace(client, req.workspaceId);
      enforce(plan, "scim_tokens", plan.limits.scimTokens, (await usageOf(client, req.workspaceId)).scimTokens);
      const result = await client.query(`INSERT INTO scim_tokens (workspace_id, name, token_hash, token_prefix, created_by, expires_at) VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) RETURNING ${TOKEN_COLUMNS}`, [req.workspaceId, body.name, sha256(token), token.slice(0, 12), req.identity.subject, days]);
      await apiAudit(req, client, { action: "scim_token.created", resourceType: "scim_token", resourceId: result.rows[0].id, details: { name: body.name, expiresInDays: days } });
      return result.rows[0];
    });
    res.status(201).json({ ...tokenView(created), token });
  }));
  app.delete(`${ws}/scim/tokens/:id`, administrator, h(async (req, res) => {
    const revoked = await db.transaction(async (client) => {
      const result = await client.query("UPDATE scim_tokens SET revoked_at = now() WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL RETURNING id", [req.params.id, req.workspaceId]);
      if (!result.rowCount) return false;
      await apiAudit(req, client, { action: "scim_token.revoked", resourceType: "scim_token", resourceId: req.params.id });
      return true;
    });
    if (!revoked) throw new HttpError(404, "not_found");
    res.status(204).end();
  }));
  app.get(`${ws}/scim/users`, administrator, h(async (req, res) => {
    const result = await db.query("SELECT * FROM scim_users WHERE workspace_id = $1 ORDER BY created_at DESC, id LIMIT 500", [req.workspaceId]);
    res.json(result.rows.map(provisionedView));
  }));

  // ---- the SCIM protocol itself ----
  // Identity providers send application/scim+json; parsing happens after authentication, like everywhere else.
  const parseBody = express.json({ type: ["application/json", "application/scim+json"], strict: true, limit: config.limits.jsonBytes });
  app.use("/scim/v2", limiters.authFailure, auth.scimAuth, parseBody, auth.scope);
  const base = (req) => `${req.protocol}://${req.get("host")}/scim/v2`;
  const user = "/scim/v2/Users";
  const group = "/scim/v2/Groups";

  // Discovery documents. Each can be listed or fetched by id, and none can be written (405, as RFC 7644 section 4 requires). The id
  // parameter is not called `id`: that name is validated as a UUID for every route, and these ids are a name and a URN.
  const attribute = (name, type, extra = {}) => ({ name, type, multiValued: false, required: false, mutability: "readWrite", returned: "default", uniqueness: "none", ...extra });
  const discovery = {
    ServiceProviderConfig: (req) => ({
      schemas: [SCHEMA.config], patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 }, filter: { supported: true, maxResults: MAX_PAGE },
      changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "A workspace SCIM token (wps_…) created by a workspace administrator", specUri: "https://www.rfc-editor.org/info/rfc6750", primary: true }],
      meta: { resourceType: "ServiceProviderConfig", location: `${base(req)}/ServiceProviderConfig` }
    }),
    ResourceTypes: (req) => [
      { schemas: [SCHEMA.type], id: "User", name: "User", endpoint: "/Users", description: "A person with access to the workspace", schema: SCHEMA.user, meta: { resourceType: "ResourceType", location: `${base(req)}/ResourceTypes/User` } },
      { schemas: [SCHEMA.type], id: "Group", name: "Group", endpoint: "/Groups", description: "A directory group of provisioned users", schema: SCHEMA.group, meta: { resourceType: "ResourceType", location: `${base(req)}/ResourceTypes/Group` } }
    ],
    Schemas: (req) => [{
      schemas: [SCHEMA.schema], id: SCHEMA.user, name: "User", description: "A person with access to the workspace",
      attributes: [
        attribute("userName", "string", { required: true, uniqueness: "server" }), attribute("externalId", "string"), attribute("displayName", "string"), attribute("active", "boolean"),
        attribute("name", "complex", { subAttributes: [attribute("givenName", "string"), attribute("familyName", "string")] }),
        attribute("emails", "complex", { multiValued: true, required: true, subAttributes: [attribute("value", "string", { required: true }), attribute("type", "string"), attribute("primary", "boolean")] }),
        attribute("roles", "complex", { multiValued: true, description: `One of ${ROLES.join(", ")}; viewer when absent`, subAttributes: [attribute("value", "string", { required: true }), attribute("primary", "boolean")] })
      ],
      meta: { resourceType: "Schema", location: `${base(req)}/Schemas/${SCHEMA.user}` }
    }, {
      schemas: [SCHEMA.schema], id: SCHEMA.group, name: "Group", description: "A directory group of provisioned users; membership does not grant workspace access",
      attributes: [
        attribute("displayName", "string", { required: true, uniqueness: "server" }), attribute("externalId", "string"),
        attribute("members", "complex", { multiValued: true, subAttributes: [attribute("value", "string", { required: true }), attribute("display", "string", { mutability: "readOnly" })] })
      ],
      meta: { resourceType: "Schema", location: `${base(req)}/Schemas/${SCHEMA.group}` }
    }]
  };
  app.get("/scim/v2/ServiceProviderConfig", (req, res) => send(res, 200, discovery.ServiceProviderConfig(req)));
  for (const name of ["ResourceTypes", "Schemas"]) {
    app.get(`/scim/v2/${name}`, (req, res) => { const all = discovery[name](req); send(res, 200, { schemas: [SCHEMA.list], totalResults: all.length, startIndex: 1, itemsPerPage: all.length, Resources: all }); });
    app.get(`/scim/v2/${name}/:document`, (req, res, next) => { const found = discovery[name](req).find((document) => document.id === req.params.document); return found ? send(res, 200, found) : next(); });
  }
  app.use(["/scim/v2/ServiceProviderConfig", "/scim/v2/ResourceTypes", "/scim/v2/Schemas"], (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    res.set("Allow", "GET");
    return send(res, 405, { schemas: [SCHEMA.error], status: "405", detail: "method_not_allowed" });
  });

  // Listing and searching are one operation: GET /Users takes the parameters in the query string, POST /Users/.search in a body.
  const listUsers = async (req, res, query) => {
    const filter = filterClause(query.filter);
    const startIndex = Math.max(1, query.startIndex ?? 1);
    const count = Math.min(MAX_PAGE, Math.max(0, query.count ?? 100));
    const where = filter ? `AND ${filter.sql}` : "";
    const args = filter ? [req.workspaceId, filter.value] : [req.workspaceId];
    const total = (await db.query(`SELECT count(*)::int AS n FROM scim_users WHERE workspace_id = $1 ${where}`, args)).rows[0].n;
    const rows = count ? (await db.query(`SELECT * FROM scim_users WHERE workspace_id = $1 ${where} ORDER BY created_at, id OFFSET ${filter ? "$3" : "$2"} LIMIT ${filter ? "$4" : "$3"}`, [...args, startIndex - 1, count])).rows : [];
    send(res, 200, { schemas: [SCHEMA.list], totalResults: total, startIndex, itemsPerPage: rows.length, Resources: rows.map((row) => project(resource(row, base(req)), query)) });
  };
  app.get(user, h(async (req, res) => {
    await listUsers(req, res, z.object({ filter: z.string().max(500).optional(), startIndex: z.coerce.number().int().optional(), count: z.coerce.number().int().optional(), attributes: z.string().max(500).optional(), excludedAttributes: z.string().max(500).optional() }).parse(req.query));
  }));
  // `POST /.search` searches every resource type; this server has one, so it is the same search.
  const search = h(async (req, res) => {
    const names = z.array(z.string().max(100)).max(50).optional();
    await listUsers(req, res, z.object({ schemas: z.array(z.string()).optional(), filter: z.string().max(500).optional(), startIndex: z.number().int().optional(), count: z.number().int().optional(), attributes: names, excludedAttributes: names }).parse(req.body ?? {}));
  });
  for (const path of [`${user}/.search`, "/scim/v2/.search"]) app.post(path, search);

  app.get(`${user}/:id`, h(async (req, res) => {
    const row = (await db.query("SELECT * FROM scim_users WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId])).rows[0];
    if (!row) throw fail(404, undefined, "resource not found");
    send(res, 200, project(resource(row, base(req)), z.object({ attributes: z.string().max(500).optional(), excludedAttributes: z.string().max(500).optional() }).parse(req.query)));
  }));

  app.post(user, h(async (req, res) => {
    const changes = changesFromResource(req.body);
    const created = await db.transaction(async (client) => {
      const plan = await lockWorkspace(client, req.workspaceId);
      // Somebody who already has access under this address (an invited member) is adopted, not duplicated: the record attaches to them.
      const member = (await client.query("SELECT subject, role FROM workspace_members WHERE workspace_id = $1 AND lower(email) = $2 ORDER BY created_at LIMIT 1 FOR UPDATE", [req.workspaceId, changes.email])).rows[0];
      const active = changes.active ?? true;
      const role = changes.role ?? (active ? member?.role : undefined) ?? "viewer";
      let subject = null;
      if (active && member) {
        subject = member.subject;
        if (role !== member.role) await changeRole(client, req.workspaceId, subject, role);
      } else if (active) await enforceSeat(client, plan, req.workspaceId);
      else if (member) await revokeAccess(client, req.workspaceId, { subject: null, email: changes.email }); // provisioned as inactive: no access
      const result = await client.query(
        `INSERT INTO scim_users (workspace_id, user_name, email, external_id, display_name, given_name, family_name, active, role, subject, bound_at, created_by, deactivated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $10::text IS NULL THEN NULL ELSE now() END, $11, CASE WHEN $8 THEN NULL ELSE now() END) RETURNING *`,
        [req.workspaceId, changes.userName, changes.email, changes.externalId, changes.displayName, changes.givenName, changes.familyName, active, role, subject, req.identity.subject]
      );
      await apiAudit(req, client, { action: "scim.user_provisioned", resourceType: "scim_user", resourceId: result.rows[0].id, details: { userName: changes.userName, email: changes.email, role, active, adopted: Boolean(subject) } });
      return result.rows[0];
    });
    res.set("Location", `${base(req)}/Users/${created.id}`);
    send(res, 201, resource(created, base(req)));
  }));

  // PUT and PATCH both end here: the attributes the client stated, applied to the stored user.
  async function update(req, changes) {
    return db.transaction(async (client) => {
      const plan = await lockWorkspace(client, req.workspaceId);
      const row = (await client.query("SELECT * FROM scim_users WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [req.params.id, req.workspaceId])).rows[0];
      if (!row) throw fail(404, undefined, "resource not found");
      const next = {
        user_name: changes.userName ?? row.user_name, email: changes.email ?? row.email,
        external_id: "externalId" in changes ? changes.externalId : row.external_id, display_name: "displayName" in changes ? changes.displayName : row.display_name,
        given_name: "givenName" in changes ? changes.givenName : row.given_name, family_name: "familyName" in changes ? changes.familyName : row.family_name,
        active: changes.active ?? row.active, role: changes.role ?? row.role
      };
      const changed = Object.keys(next).filter((key) => next[key] !== row[key]);
      if (!changed.length) return { row, action: null };
      let subject = row.subject; let removed = 0; let keysRevoked = [];
      if (row.active && !next.active) { const gone = await revokeAccess(client, req.workspaceId, row); removed = gone.subjects.length; keysRevoked = gone.apiKeys; }
      else if (!row.active && next.active) {
        const member = (await client.query("SELECT subject FROM workspace_members WHERE workspace_id = $1 AND (subject = $2 OR lower(email) = $3) ORDER BY created_at LIMIT 1 FOR UPDATE", [req.workspaceId, row.subject, next.email])).rows[0];
        if (!member) await enforceSeat(client, plan, req.workspaceId);
        if (subject) await grantAccess(client, req.workspaceId, { subject, email: next.email, role: next.role });
        else if (member) subject = member.subject; // an invited member with this address: the record attaches to them and they keep their role
      } else if (next.active && subject) {
        if (next.role !== row.role) await changeRole(client, req.workspaceId, subject, next.role);
        if (next.email !== row.email) await client.query("UPDATE workspace_members SET email = $3 WHERE workspace_id = $1 AND subject = $2", [req.workspaceId, subject, next.email]);
      }
      const updated = (await client.query(
        `UPDATE scim_users SET user_name = $3, email = $4, external_id = $5, display_name = $6, given_name = $7, family_name = $8, active = $9, role = $10, subject = $11,
           bound_at = CASE WHEN $11::text IS NULL THEN NULL WHEN bound_at IS NULL THEN now() ELSE bound_at END,
           deactivated_at = CASE WHEN $9 THEN NULL WHEN deactivated_at IS NULL THEN now() ELSE deactivated_at END, updated_at = now()
         WHERE id = $1 AND workspace_id = $2 RETURNING *`,
        [row.id, req.workspaceId, next.user_name, next.email, next.external_id, next.display_name, next.given_name, next.family_name, next.active, next.role, subject]
      )).rows[0];
      const action = row.active && !next.active ? "scim.user_deactivated" : !row.active && next.active ? "scim.user_reactivated" : "scim.user_updated";
      await apiAudit(req, client, { action, resourceType: "scim_user", resourceId: row.id, details: { userName: next.user_name, email: next.email, role: next.role, changed, ...(removed ? { membersRemoved: removed } : {}), ...(keysRevoked.length ? { apiKeysRevoked: keysRevoked } : {}) } });
      return { row: updated, action };
    });
  }
  app.put(`${user}/:id`, h(async (req, res) => send(res, 200, resource((await update(req, changesFromResource(req.body))).row, base(req)))));
  app.patch(`${user}/:id`, h(async (req, res) => send(res, 200, resource((await update(req, changesFromPatch(req.body))).row, base(req)))));

  app.delete(`${user}/:id`, h(async (req, res) => {
    await db.transaction(async (client) => {
      await lockWorkspace(client, req.workspaceId);
      const row = (await client.query("SELECT * FROM scim_users WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [req.params.id, req.workspaceId])).rows[0];
      if (!row) throw fail(404, undefined, "resource not found");
      const gone = await revokeAccess(client, req.workspaceId, row);
      await client.query("DELETE FROM scim_users WHERE id = $1", [row.id]);
      await apiAudit(req, client, { action: "scim.user_deleted", resourceType: "scim_user", resourceId: row.id, details: { userName: row.user_name, email: row.email, membersRemoved: gone.subjects.length, ...(gone.apiKeys.length ? { apiKeysRevoked: gone.apiKeys } : {}) } });
    });
    res.status(204).end();
  }));

  // Groups use the same workspace-scoped token as Users. Every member must already be a SCIM-provisioned User in that workspace.
  const groupFilter = (value) => {
    const match = value === undefined ? null : FILTER.exec(value);
    if (value !== undefined && !match) throw fail(400, "invalidFilter", 'only `displayName`, `externalId` or `id` with `eq "value"` can be filtered');
    if (!match) return null;
    const sql = { displayname: "lower(display_name) = lower($2)", externalid: "external_id = $2", id: "id::text = lower($2)" }[match[1].toLowerCase()];
    if (!sql) throw fail(400, "invalidFilter", `cannot filter on ${match[1]}`);
    let parsed;
    try { parsed = JSON.parse(match[2]); } catch { throw fail(400, "invalidFilter", "the filter value is not a valid quoted string"); }
    return { sql, value: parsed };
  };
  const groupQuery = z.object({ filter: z.string().max(500).optional(), startIndex: z.coerce.number().int().optional(), count: z.coerce.number().int().optional(), attributes: z.string().max(500).optional(), excludedAttributes: z.string().max(500).optional() });
  const listGroups = async (req, res, query) => {
    const filter = groupFilter(query.filter);
    const startIndex = Math.max(1, query.startIndex ?? 1);
    const count = Math.min(MAX_PAGE, Math.max(0, query.count ?? 100));
    const where = filter ? `AND ${filter.sql}` : "";
    const args = filter ? [req.workspaceId, filter.value] : [req.workspaceId];
    const total = (await db.query(`SELECT count(*)::int AS n FROM scim_groups WHERE workspace_id = $1 ${where}`, args)).rows[0].n;
    const rows = count ? (await db.query(`SELECT * FROM scim_groups WHERE workspace_id = $1 ${where} ORDER BY created_at, id OFFSET ${filter ? "$3" : "$2"} LIMIT ${filter ? "$4" : "$3"}`, [...args, startIndex - 1, count])).rows : [];
    const resources = await Promise.all(rows.map(async (row) => project(groupResource(row, await groupMembers(db, req.workspaceId, row.id), base(req)), query)));
    send(res, 200, { schemas: [SCHEMA.list], totalResults: total, startIndex, itemsPerPage: resources.length, Resources: resources });
  };
  app.get(group, h(async (req, res) => { await listGroups(req, res, groupQuery.parse(req.query)); }));
  const groupSearch = h(async (req, res) => {
    const names = z.array(z.string().max(100)).max(50).optional();
    await listGroups(req, res, z.object({ schemas: z.array(z.string()).optional(), filter: z.string().max(500).optional(), startIndex: z.number().int().optional(), count: z.number().int().optional(), attributes: names, excludedAttributes: names }).parse(req.body ?? {}));
  });
  app.post(`${group}/.search`, groupSearch);
  app.get(`${group}/:id`, h(async (req, res) => {
    const found = await groupWithMembers(db, req.workspaceId, req.params.id);
    if (!found) throw fail(404, undefined, "resource not found");
    send(res, 200, project(groupResource(found.row, found.members, base(req)), groupQuery.parse(req.query)));
  }));
  app.post(group, h(async (req, res) => {
    const changes = groupChangesFromResource(req.body);
    const created = await db.transaction(async (client) => {
      await lockWorkspace(client, req.workspaceId);
      const row = (await client.query("INSERT INTO scim_groups (workspace_id, display_name, external_id, created_by) VALUES ($1, $2, $3, $4) RETURNING *", [req.workspaceId, changes.displayName, changes.externalId, req.identity.subject])).rows[0];
      await replaceGroupMembers(client, req.workspaceId, row.id, changes.members);
      await apiAudit(req, client, { action: "scim.group_created", resourceType: "scim_group", resourceId: row.id, details: { displayName: row.display_name, memberCount: changes.members.length } });
      return { row, members: await groupMembers(client, req.workspaceId, row.id) };
    });
    res.set("Location", `${base(req)}/Groups/${created.row.id}`);
    send(res, 201, groupResource(created.row, created.members, base(req)));
  }));
  async function updateGroup(req, changes) {
    return db.transaction(async (client) => {
      await lockWorkspace(client, req.workspaceId);
      const row = (await client.query("SELECT * FROM scim_groups WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [req.params.id, req.workspaceId])).rows[0];
      if (!row) throw fail(404, undefined, "resource not found");
      const next = { display_name: changes.displayName ?? row.display_name, external_id: "externalId" in changes ? changes.externalId : row.external_id };
      const changed = Object.keys(next).filter((key) => next[key] !== row[key]);
      const currentMembers = await groupMembers(client, req.workspaceId, row.id);
      const currentIds = currentMembers.map((member) => member.id);
      const memberIds = "members" in changes ? changes.members : [...new Set([...currentIds, ...(changes.addMembers ?? [])])].filter((id) => !(changes.removeMembers ?? []).includes(id));
      const membershipChanged = "members" in changes || "addMembers" in changes || "removeMembers" in changes;
      let updated = row;
      if (changed.length) updated = (await client.query("UPDATE scim_groups SET display_name = $3, external_id = $4, updated_at = now() WHERE id = $1 AND workspace_id = $2 RETURNING *", [row.id, req.workspaceId, next.display_name, next.external_id])).rows[0];
      if (membershipChanged) await replaceGroupMembers(client, req.workspaceId, row.id, memberIds);
      if (membershipChanged && !changed.length) await client.query("UPDATE scim_groups SET updated_at = now() WHERE id = $1 AND workspace_id = $2", [row.id, req.workspaceId]);
      if (membershipChanged && !changed.length) updated = (await client.query("SELECT * FROM scim_groups WHERE id = $1 AND workspace_id = $2", [row.id, req.workspaceId])).rows[0];
      if (changed.length || membershipChanged) await apiAudit(req, client, { action: "scim.group_updated", resourceType: "scim_group", resourceId: row.id, details: { displayName: next.display_name, changed: [...changed, ...(membershipChanged ? ["members"] : [])], ...(membershipChanged ? { memberCount: memberIds.length } : {}) } });
      return { row: updated, members: await groupMembers(client, req.workspaceId, row.id) };
    });
  }
  app.put(`${group}/:id`, h(async (req, res) => { const updated = await updateGroup(req, groupChangesFromResource(req.body)); send(res, 200, groupResource(updated.row, updated.members, base(req))); }));
  app.patch(`${group}/:id`, h(async (req, res) => { const updated = await updateGroup(req, groupChangesFromPatch(req.body)); send(res, 200, groupResource(updated.row, updated.members, base(req))); }));
  app.delete(`${group}/:id`, h(async (req, res) => {
    await db.transaction(async (client) => {
      await lockWorkspace(client, req.workspaceId);
      const row = (await client.query("DELETE FROM scim_groups WHERE id = $1 AND workspace_id = $2 RETURNING *", [req.params.id, req.workspaceId])).rows[0];
      if (!row) throw fail(404, undefined, "resource not found");
      await apiAudit(req, client, { action: "scim.group_deleted", resourceType: "scim_group", resourceId: row.id, details: { displayName: row.display_name } });
    });
    res.status(204).end();
  }));

  app.use("/scim/v2", (_req, res) => send(res, 404, { schemas: [SCHEMA.error], status: "404", detail: "not_found" }));
  app.use("/scim/v2", scimErrors({ log, metrics }));
}
