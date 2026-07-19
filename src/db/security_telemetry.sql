-- Security + telemetry blueprint for shared / multi-tenant metadata.
-- Apply tenant-scoped pieces inside each tenant DB; tenant_metrics_log lives on the control plane (neondb).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Example shared application table (tenant-scoped rows in one physical table)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_table (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL,
    name        VARCHAR(255) NOT NULL,
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_application_table_tenant_id
    ON application_table (tenant_id);

-- ---------------------------------------------------------------------------
-- Row-Level Security lockdown
-- Request handlers must set session context before querying, e.g.:
--   SELECT set_config('app.current_tenant_id', '<tenant-uuid>', true);
-- ---------------------------------------------------------------------------
ALTER TABLE application_table ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_table FORCE ROW LEVEL SECURITY;

-- Isolation: only rows matching the request's tenant session variable are visible.
CREATE POLICY tenant_isolation_policy ON application_table
    FOR ALL
    USING (
        tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    );

-- ---------------------------------------------------------------------------
-- Control-plane metrics sink (neondb)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_metrics_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    db_identifier       VARCHAR(255) NOT NULL,
    database_name       TEXT NOT NULL,
    size_bytes          BIGINT NOT NULL,
    active_connections  INTEGER NOT NULL DEFAULT 0,
    collected_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_metrics_log_tenant_collected
    ON tenant_metrics_log (tenant_id, collected_at DESC);

-- ---------------------------------------------------------------------------
-- Raw telemetry query (run against a tenant database connection)
-- Returns: database name, size in bytes, active connection count
-- ---------------------------------------------------------------------------
-- SELECT
--     d.datname AS database_name,
--     pg_database_size(d.datname) AS size_bytes,
--     COALESCE(a.active_connections, 0) AS active_connections
-- FROM pg_database AS d
-- LEFT JOIN (
--     SELECT
--         datname,
--         COUNT(*)::integer AS active_connections
--     FROM pg_stat_activity
--     WHERE datname IS NOT NULL
--       AND state IS NOT NULL
--     GROUP BY datname
-- ) AS a ON a.datname = d.datname
-- WHERE d.datname = current_database();

CREATE OR REPLACE VIEW v_database_telemetry AS
SELECT
    d.datname AS database_name,
    pg_database_size(d.datname) AS size_bytes,
    COALESCE(a.active_connections, 0) AS active_connections
FROM pg_database AS d
LEFT JOIN (
    SELECT
        datname,
        COUNT(*)::integer AS active_connections
    FROM pg_stat_activity
    WHERE datname IS NOT NULL
      AND state IS NOT NULL
    GROUP BY datname
) AS a ON a.datname = d.datname
WHERE d.datname = current_database();
