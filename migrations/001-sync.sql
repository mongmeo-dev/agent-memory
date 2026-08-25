CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS access_tokens (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hmac BYTEA NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tenant_keys (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_version INTEGER NOT NULL,
  wrapped_key BYTEA NOT NULL,
  wrap_nonce BYTEA NOT NULL,
  wrap_auth_tag BYTEA NOT NULL,
  wrapping_key_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key_version)
);

CREATE TABLE IF NOT EXISTS remote_projects (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS devices (
  tenant_id UUID NOT NULL,
  project_id UUID NOT NULL,
  device_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, device_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES remote_projects(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_changes (
  cursor BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  project_id UUID NOT NULL,
  origin_device_id TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  ciphertext BYTEA NOT NULL,
  nonce BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, origin_device_id, sequence),
  FOREIGN KEY (tenant_id, project_id, origin_device_id) REFERENCES devices(tenant_id, project_id, device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS sync_changes_project_cursor_idx ON sync_changes (tenant_id, project_id, cursor);

CREATE TABLE IF NOT EXISTS device_acks (
  tenant_id UUID NOT NULL,
  project_id UUID NOT NULL,
  device_id TEXT NOT NULL,
  cursor BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, device_id),
  FOREIGN KEY (tenant_id, project_id, device_id) REFERENCES devices(tenant_id, project_id, device_id) ON DELETE CASCADE
);
