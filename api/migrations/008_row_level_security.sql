-- Row-level security: a second barrier behind the application's own workspace checks.
--
-- The API runs its request handlers as the role wirepulse_app (SET LOCAL ROLE inside each transaction) with app.workspace_id set to the
-- workspace the caller was authorised for. These policies let that role see and change only that workspace's rows, so a handler that
-- forgets a "WHERE workspace_id = ..." still cannot read or write another workspace's data.
--
-- What it does not do: the role the API connects as owns the tables and is not filtered (token lookups, workers and the operator tools
-- run as it), and anyone who can run arbitrary SQL as the application can SET ROLE back. The barrier is against mistakes in handlers,
-- not against a compromised API process.

DO $$
BEGIN
  -- Roles belong to the whole PostgreSQL server, not to this database: another database on the same server may have created it already
  -- (or be creating it right now, hence the handler).
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wirepulse_app') THEN
    BEGIN
      CREATE ROLE wirepulse_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
    END;
  END IF;
  -- The connecting role has to be able to become it (a superuser always can).
  IF NOT pg_has_role(current_user, 'wirepulse_app', 'MEMBER') THEN
    EXECUTE format('GRANT wirepulse_app TO %I', current_user);
  END IF;
END
$$;

CREATE FUNCTION wirepulse_current_workspace() RETURNS uuid LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT nullif(current_setting('app.workspace_id', true), '')::uuid
$$;

GRANT USAGE ON SCHEMA public TO wirepulse_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  workspaces, workspace_members, shared_profiles, test_suites, test_reports, audit_events, audit_anchors, gateways, test_jobs, api_keys,
  workspace_invitations, resource_versions, workspace_usage, webhooks, outbox, scim_tokens, scim_users
  TO wirepulse_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wirepulse_app;

-- No FORCE: the owner (the API's own connection, the migrations) is exempt on purpose.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON workspaces USING (id = wirepulse_current_workspace()) WITH CHECK (id = wirepulse_current_workspace());

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON workspace_members USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
ALTER TABLE shared_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON shared_profiles USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
ALTER TABLE test_suites ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON test_suites USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
ALTER TABLE test_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON test_reports USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON audit_events USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
ALTER TABLE audit_anchors ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON audit_anchors USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
ALTER TABLE gateways ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON gateways USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
ALTER TABLE test_jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON test_jobs USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON api_keys USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
ALTER TABLE workspace_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON workspace_invitations USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
ALTER TABLE resource_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON resource_versions USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
ALTER TABLE workspace_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON workspace_usage USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
ALTER TABLE webhooks ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON webhooks USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON outbox USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
ALTER TABLE scim_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON scim_tokens USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
ALTER TABLE scim_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON scim_users USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
