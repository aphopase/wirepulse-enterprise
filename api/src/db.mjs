import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";

const { Pool, Client } = pg;

// Row-level security (migration 008). With rowLevelSecurity on, db.query and db.transaction run as this role, which the policies confine to
// the workspace named by app.workspace_id; db.system is the connection's own role, which they do not apply to.
export const APP_ROLE = "wirepulse_app";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scope = new AsyncLocalStorage();

export function createDatabase({ url, listenUrl, poolSize = 10, ssl, statementTimeoutMs = 15_000, idleTxTimeoutMs = 15_000, connectTimeoutMs = 5_000, rowLevelSecurity = false, log }) {
  const clientConfig = { connectionString: url, ssl, application_name: "wirepulse-api", connectionTimeoutMillis: connectTimeoutMs };
  const pool = new Pool({ ...clientConfig, max: poolSize, idleTimeoutMillis: 30_000, statement_timeout: statementTimeoutMs, idle_in_transaction_session_timeout: idleTxTimeoutMs });
  // An idle client dropped by the server must not crash the process; the pool replaces it on the next checkout.
  pool.on("error", (error) => log?.error({ err: error }, "idle database client error"));
  async function transaction(fn, begin = "BEGIN") {
    const client = await pool.connect();
    // The pool only listens to idle clients. A connection that drops while checked out (restart, failover, the idle-in-transaction
    // timeout) emits an error with no one listening, which would crash the process; the failing query or COMMIT reports it instead.
    const onError = (error) => log?.error({ err: error }, "database client error during a transaction");
    client.on("error", onError);
    let broken;
    try { await client.query(begin); const result = await fn(client); await client.query("COMMIT"); return result; }
    catch (error) { try { await client.query("ROLLBACK"); } catch (rollbackError) { broken = rollbackError; } throw error; }
    finally { client.removeListener("error", onError); client.release(broken); }
  }
  // One round trip: open the transaction, drop to the restricted role and name the workspace, all of it undone at COMMIT or ROLLBACK
  // (set_config(..., true) is transaction-local, so a pooled connection never carries a workspace to the next request). The id was
  // checked against the UUID pattern before it is put in the statement. Outside any workspace scope the setting stays empty and the
  // policies match nothing: code that forgot to say which workspace it works for sees no rows instead of everyone's.
  const restricted = () => {
    const workspaceId = scope.getStore()?.workspaceId;
    return `BEGIN; SELECT set_config('app.workspace_id', '${workspaceId ?? ""}', true), set_config('role', '${APP_ROLE}', true)`;
  };
  const systemQuery = (text, values) => pool.query(text, values);
  const query = rowLevelSecurity ? (text, values) => transaction((client) => client.query(text, values), restricted()) : systemQuery;
  // For work that is across workspaces by nature (finding whose token this is, background workers, the operator's tools) or that
  // happens before the workspace is known. Never reached from a request handler by accident: it has to be asked for.
  const base = {
    // Dedicated connection for LISTEN/NOTIFY; it must not come from the pool and must not sit behind a transaction-mode pooler, so it can
    // be given its own address (LISTEN_DATABASE_URL).
    newListenerClient: () => new Client({ ...clientConfig, ...(listenUrl && { connectionString: listenUrl }), keepAlive: true }),
    stats: () => ({ total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }),
    // Reachable and writable. transaction_read_only is "on" on a streaming replica (recovery), after a demotion, and when the server or
    // role is set read-only: in each of those a request that writes fails, so the instance must not receive traffic.
    health: async () => ({ readOnly: (await pool.query("SHOW transaction_read_only")).rows[0].transaction_read_only === "on" }),
    close: () => pool.end()
  };
  const system = { ...base, query: systemQuery, transaction: (fn) => transaction(fn), rowLevelSecurity };
  return {
    ...base, system, rowLevelSecurity,
    query,
    transaction: rowLevelSecurity ? (fn) => transaction(fn, restricted()) : system.transaction,
    // Everything fn does through db.query and db.transaction, however deep, is confined to this workspace.
    inWorkspace: (workspaceId, fn) => {
      if (!rowLevelSecurity) return fn();
      if (!UUID.test(workspaceId)) throw new Error("inWorkspace needs a workspace id");
      return scope.run({ workspaceId }, fn);
    }
  };
}

// What the second barrier depends on, checked at start-up so that a database that lacks it stops the API instead of being trusted:
// the policies exist on every table that holds a workspace's data, the restricted role cannot step around them, and the role the API
// connects as can become that role but is itself not filtered (it must own the tables, or be a superuser).
export async function checkRowLevelSecurity(db) {
  const problems = [];
  const role = (await db.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1", [APP_ROLE])).rows[0];
  if (!role) problems.push(`the role ${APP_ROLE} does not exist (migration 008 creates it; the migrating user needs CREATEROLE, or create it beforehand with CREATE ROLE ${APP_ROLE} NOLOGIN)`);
  else if (role.rolsuper || role.rolbypassrls) problems.push(`the role ${APP_ROLE} is a superuser or has BYPASSRLS, which switches the policies off`);
  const unprotected = (await db.query(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
        AND (c.relname = 'workspaces' OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped))
      ORDER BY c.relname`
  )).rows.map((row) => row.relname);
  if (unprotected.length) problems.push(`row-level security is off on: ${unprotected.join(", ")}`);
  const me = (await db.query(
    `SELECT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS exempt,
            (SELECT pg_get_userbyid(relowner) = current_user FROM pg_class WHERE oid = 'public.workspaces'::regclass) AS owner`
  )).rows[0];
  if (!me.exempt && !me.owner) problems.push("the connection's role neither owns the tables nor bypasses row-level security, so the policies would also filter the API's own lookups; connect as the role that ran the migrations");
  if (role) {
    try { await db.transaction(async (client) => { await client.query(`SET LOCAL ROLE ${APP_ROLE}`); }); }
    catch (error) { problems.push(`the connection's role cannot switch to ${APP_ROLE} (${error.message}); GRANT ${APP_ROLE} TO that role`); }
  }
  return problems;
}

// Always the last statement of a transaction: the audit hash chain serializes writers per workspace until commit.
export async function audit(executor, event) {
  await executor.query(
    `INSERT INTO audit_events (workspace_id, actor_subject, action, resource_type, resource_id, request_id, ip_address, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [event.workspaceId, event.actor, event.action, event.resourceType, event.resourceId ?? null, event.requestId, event.ip ?? null, event.details ?? {}]
  );
}
