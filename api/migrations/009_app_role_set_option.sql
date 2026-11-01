-- Migration 008 skips its GRANT when the connecting role is already a member of wirepulse_app. On PostgreSQL 16 and later a role that
-- creates a role with CREATEROLE (not as a superuser, which is how managed services run migrations) becomes a member with ADMIN OPTION
-- only: it cannot SET ROLE to it, and the API refuses to start. Grant the missing SET option. A superuser always can; before 16 membership
-- alone is enough, so 008 already covers it.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    IF NOT pg_has_role(current_user, 'wirepulse_app', 'SET') THEN
      EXECUTE format('GRANT wirepulse_app TO %I WITH SET TRUE', current_user);
    END IF;
  END IF;
END
$$;
