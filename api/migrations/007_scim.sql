-- SCIM 2.0 user provisioning: the identity provider creates, updates and deactivates people, and a leaver loses workspace access
-- when it says so instead of when somebody remembers. Two tables: the bearer tokens an identity provider uses, and the users it manages.

-- Like API keys: scoped to one workspace, always expiring, stored only as a hash.
CREATE TABLE scim_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX scim_tokens_active_name ON scim_tokens (workspace_id, lower(name)) WHERE revoked_at IS NULL;

-- A person as the identity provider describes them. `email` is the address a sign-in is matched to (lower case); `subject` is the OIDC
-- subject once that has happened (or the member that already had the address when the user was provisioned), and is what access is
-- granted to and withdrawn from. The role is only ever changed by an identity provider that sends one.
CREATE TABLE scim_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_name text NOT NULL CHECK (length(user_name) BETWEEN 1 AND 254),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  external_id text CHECK (length(external_id) <= 256),
  display_name text CHECK (length(display_name) <= 256),
  given_name text CHECK (length(given_name) <= 128),
  family_name text CHECK (length(family_name) <= 128),
  active boolean NOT NULL DEFAULT true,
  role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'engineer', 'maintainer', 'administrator')),
  subject text,
  bound_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deactivated_at timestamptz,
  CHECK ((subject IS NULL) = (bound_at IS NULL))
);
CREATE UNIQUE INDEX scim_users_user_name ON scim_users (workspace_id, lower(user_name));
CREATE UNIQUE INDEX scim_users_email ON scim_users (workspace_id, email);
CREATE UNIQUE INDEX scim_users_external_id ON scim_users (workspace_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX scim_users_waiting ON scim_users (email) WHERE active AND subject IS NULL;
CREATE INDEX scim_users_created ON scim_users (workspace_id, created_at, id);

-- Lets a stream held open by a replica end when the person's access is withdrawn through any other replica (see stream.mjs).
-- Nothing to create: pg_notify needs no objects. The channel is wirepulse_access, payload {"w": workspace id, "s": subject}.
