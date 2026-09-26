-- ============================================================================
-- nyaya-guard v3 — least-privilege application role
-- ============================================================================
--
-- WHY THIS IS A SEPARATE FILE. `db/schema.sql` creates the objects; this
-- creates the identity that uses them. Two different permissions, two
-- different files, two different people: a migration role and a runtime role.
--
-- Run once, as a role with CREATEROLE (a superuser, or a DBA):
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/role.sql
-- It is idempotent, so re-running is a no-op.
--
-- WHY IT MATTERS. PostgreSQL skips row-level security entirely for
-- SUPERUSERs and for roles granted BYPASSRLS. `FORCE ROW LEVEL SECURITY` in
-- db/schema.sql covers the table OWNER, and nothing covers a superuser. So an
-- app that connects as `POSTGRES_USER` from a stock docker image has, in
-- effect, no tenant isolation at all — and every "we tested RLS" claim would
-- be a claim about a different database than production runs.
--
-- NO PASSWORD IN HERE, ON PURPOSE. The role is created NOLOGIN. Grant it a
-- password (or federated identity) out of band, or connect as a member role
-- and let the app do `SET LOCAL ROLE nyaya_app` per transaction, which is
-- exactly what `src/store_pg.ts` does when constructed with `{role:
-- "nyaya_app"}`. Shipping a default credential in a repository is how
-- production credentials end up rotated never.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nyaya_app') THEN
    CREATE ROLE nyaya_app NOLOGIN
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    RAISE NOTICE
      'created role nyaya_app (NOLOGIN). Grant it LOGIN + a credential out of band, or SET LOCAL ROLE nyaya_app from a member role.';
  END IF;
END
$$;

-- Schema + object grants. No DDL, no ownership, no BYPASSRLS: this role can
-- read and write chunks for whichever tenant the transaction is pinned to,
-- and cannot alter the table, drop it, or see another tenant's rows.
GRANT USAGE ON SCHEMA public TO nyaya_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON chunks TO nyaya_app;
GRANT SELECT ON chunks_needing_reembed TO nyaya_app;
GRANT SELECT ON store_migrations TO nyaya_app;

-- Future tables. Without this, a migration that adds a table silently leaves
-- the app unable to see it, and the failure looks like a query bug.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nyaya_app;

-- If the app connects with its own password instead of SET LOCAL ROLE:
--     ALTER ROLE nyaya_app LOGIN PASSWORD '<from your secret manager>';
