-- Control plane schema: central management hub for multi-tenant routing.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Global tenant registry
CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_name    VARCHAR(255) NOT NULL,
    db_identifier   VARCHAR(255) NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Central identity store (password optional for magic-link auth)
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(320) NOT NULL,
    password_hash   TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tenant membership with RBAC roles
CREATE TABLE tenant_users (
    tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role            VARCHAR(20) NOT NULL
                        CHECK (role IN ('owner', 'admin', 'member')),
    PRIMARY KEY (tenant_id, user_id)
);

-- Secure login handshake OTPs
CREATE TABLE auth_otps (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    otp_code_hash   TEXT NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         BOOLEAN NOT NULL DEFAULT FALSE
);

-- Ultra-fast lookup indexes
CREATE UNIQUE INDEX idx_tenants_db_identifier ON tenants (db_identifier);
CREATE UNIQUE INDEX idx_users_email ON users (email);

-- Application feature flags / system settings (control plane)
CREATE TABLE IF NOT EXISTS system_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system_settings (key, value)
VALUES ('auth_provider', 'supabase')
ON CONFLICT (key) DO NOTHING;

