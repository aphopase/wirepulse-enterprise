-- SCIM 2.0 Groups: identity-provider-managed, workspace-scoped directory groups and their provisioned-user memberships.
-- Group membership is descriptive only; it neither grants workspace access nor changes a member's role.

CREATE TABLE scim_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
  external_id text CHECK (length(external_id) <= 256),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX scim_groups_display_name ON scim_groups (workspace_id, lower(display_name));
CREATE UNIQUE INDEX scim_groups_external_id ON scim_groups (workspace_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX scim_groups_created ON scim_groups (workspace_id, created_at, id);

CREATE TABLE scim_group_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  group_id uuid NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES scim_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

-- The triggers reject cross-workspace links even for direct SQL, while foreign keys clean memberships up with their user or group.
CREATE FUNCTION wirepulse_scim_group_member_workspace_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM scim_groups WHERE id = NEW.group_id AND workspace_id = NEW.workspace_id)
     OR NOT EXISTS (SELECT 1 FROM scim_users WHERE id = NEW.user_id AND workspace_id = NEW.workspace_id) THEN
    RAISE EXCEPTION 'SCIM group members must belong to the same workspace' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER scim_group_members_workspace_check BEFORE INSERT OR UPDATE ON scim_group_members
  FOR EACH ROW EXECUTE FUNCTION wirepulse_scim_group_member_workspace_check();
CREATE INDEX scim_group_members_user ON scim_group_members (workspace_id, user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON scim_groups, scim_group_members TO wirepulse_app;
ALTER TABLE scim_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON scim_groups USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
ALTER TABLE scim_group_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspace_isolation ON scim_group_members USING (workspace_id = wirepulse_current_workspace()) WITH CHECK (workspace_id = wirepulse_current_workspace());
