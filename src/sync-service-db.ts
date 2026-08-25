import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

export interface EncryptedOperation {
  sequence: number;
  entityType: string;
  entityId: string;
  action: string;
  createdAt: string;
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
}

export interface StoredEncryptedChange extends EncryptedOperation {
  cursor: string;
  originDeviceId: string;
}

export interface WrappedTenantKey {
  version: number;
  wrappedKey: Buffer;
  nonce: Buffer;
  authTag: Buffer;
}

export interface SyncRepository {
  createTenant(tenantId: string): Promise<void>;
  createProject(tenantId: string, projectId: string): Promise<void>;
  createAccessToken(tenantId: string, tokenHmac: Buffer): Promise<void>;
  revokeAccessToken(tokenHmac: Buffer): Promise<boolean>;
  tenantForToken(tokenHmac: Buffer): Promise<string | null>;
  getTenantKey(tenantId: string): Promise<WrappedTenantKey | null>;
  putTenantKey(tenantId: string, key: WrappedTenantKey): Promise<void>;
  appendChanges(
    tenantId: string,
    projectId: string,
    deviceId: string,
    changes: EncryptedOperation[],
  ): Promise<number[]>;
  listChanges(
    tenantId: string,
    projectId: string,
    after: string | null,
    limit: number,
  ): Promise<StoredEncryptedChange[]>;
  ready(): Promise<boolean>;
}

interface MemoryProject {
  tenantId: string;
}

export class InMemorySyncRepository implements SyncRepository {
  readonly tenants = new Set<string>();
  readonly projects = new Map<string, MemoryProject>();
  readonly tokenHmacs = new Map<string, string>();
  readonly tenantKeys = new Map<string, WrappedTenantKey>();
  readonly changes: StoredEncryptedChange[] = [];
  readonly #deviceSequences = new Set<string>();
  #cursor = 0;

  async createTenant(tenantId: string): Promise<void> {
    this.tenants.add(tenantId);
  }

  async createProject(tenantId: string, projectId: string): Promise<void> {
    if (!this.tenants.has(tenantId)) throw new Error("Unknown tenant");
    this.projects.set(projectId, { tenantId });
  }

  async createAccessToken(tenantId: string, tokenHmac: Buffer): Promise<void> {
    if (!this.tenants.has(tenantId)) throw new Error("Unknown tenant");
    this.tokenHmacs.set(tokenHmac.toString("hex"), tenantId);
  }

  async revokeAccessToken(tokenHmac: Buffer): Promise<boolean> {
    return this.tokenHmacs.delete(tokenHmac.toString("hex"));
  }

  async tenantForToken(tokenHmac: Buffer): Promise<string | null> {
    return this.tokenHmacs.get(tokenHmac.toString("hex")) ?? null;
  }

  async getTenantKey(tenantId: string): Promise<WrappedTenantKey | null> {
    return this.tenantKeys.get(tenantId) ?? null;
  }

  async putTenantKey(tenantId: string, key: WrappedTenantKey): Promise<void> {
    if (!this.tenants.has(tenantId)) throw new Error("Unknown tenant");
    if (!this.tenantKeys.has(tenantId)) this.tenantKeys.set(tenantId, key);
  }

  async appendChanges(
    tenantId: string,
    projectId: string,
    deviceId: string,
    changes: EncryptedOperation[],
  ): Promise<number[]> {
    if (this.projects.get(projectId)?.tenantId !== tenantId) throw new Error("Unknown project");
    const accepted: number[] = [];
    for (const change of changes) {
      if (change.action === "delete") {
        for (let index = this.changes.length - 1; index >= 0; index -= 1) {
          const existing = this.changes[index];
          if (
            existing !== undefined &&
            existing.entityType === change.entityType &&
            existing.entityId === change.entityId &&
            this.#belongsTo(existing, tenantId, projectId)
          ) {
            this.changes.splice(index, 1);
          }
        }
      }
      const key = `${tenantId}\u0000${projectId}\u0000${deviceId}\u0000${change.sequence}`;
      if (!this.#deviceSequences.has(key)) {
        this.#deviceSequences.add(key);
        const stored = { ...change, cursor: String(++this.#cursor), originDeviceId: deviceId };
        this.#changeScope.set(stored, `${tenantId}\u0000${projectId}`);
        this.changes.push(stored);
      }
      accepted.push(change.sequence);
    }
    return accepted;
  }

  async listChanges(
    tenantId: string,
    projectId: string,
    after: string | null,
    limit: number,
  ): Promise<StoredEncryptedChange[]> {
    if (this.projects.get(projectId)?.tenantId !== tenantId) throw new Error("Unknown project");
    const cursor = after === null ? 0n : BigInt(after);
    return this.changes
      .filter(
        (change) => BigInt(change.cursor) > cursor && this.#belongsTo(change, tenantId, projectId),
      )
      .slice(0, limit)
      .map((change) => ({
        ...change,
        ciphertext: Buffer.from(change.ciphertext),
        nonce: Buffer.from(change.nonce),
        authTag: Buffer.from(change.authTag),
      }));
  }

  #belongsTo(change: StoredEncryptedChange, tenantId: string, projectId: string): boolean {
    return (
      change.originDeviceId !== "" &&
      this.#changeScope.get(change) === `${tenantId}\u0000${projectId}`
    );
  }

  readonly #changeScope = new WeakMap<StoredEncryptedChange, string>();

  async ready(): Promise<boolean> {
    return true;
  }
}

export class PostgresSyncRepository implements SyncRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async createTenant(tenantId: string): Promise<void> {
    await this.#pool.query("INSERT INTO tenants (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [
      tenantId,
    ]);
  }

  async createProject(tenantId: string, projectId: string): Promise<void> {
    await this.#pool.query(
      "INSERT INTO remote_projects (id, tenant_id) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
      [projectId, tenantId],
    );
  }

  async createAccessToken(tenantId: string, tokenHmac: Buffer): Promise<void> {
    await this.#pool.query(
      "INSERT INTO access_tokens (id, tenant_id, token_hmac) VALUES ($1, $2, $3)",
      [randomUUID(), tenantId, tokenHmac],
    );
  }

  async revokeAccessToken(tokenHmac: Buffer): Promise<boolean> {
    const result = await this.#pool.query(
      "UPDATE access_tokens SET revoked_at = now() WHERE token_hmac = $1 AND revoked_at IS NULL",
      [tokenHmac],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async tenantForToken(tokenHmac: Buffer): Promise<string | null> {
    const result = await this.#pool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM access_tokens WHERE token_hmac = $1 AND revoked_at IS NULL",
      [tokenHmac],
    );
    return result.rows[0]?.tenant_id ?? null;
  }

  async getTenantKey(tenantId: string): Promise<WrappedTenantKey | null> {
    const result = await this.#pool.query<{
      key_version: number;
      wrapped_key: Buffer;
      wrap_nonce: Buffer;
      wrap_auth_tag: Buffer;
    }>(
      `SELECT key_version, wrapped_key, wrap_nonce, wrap_auth_tag
       FROM tenant_keys WHERE tenant_id = $1 ORDER BY key_version DESC LIMIT 1`,
      [tenantId],
    );
    const row = result.rows[0];
    return row === undefined
      ? null
      : {
          version: row.key_version,
          wrappedKey: row.wrapped_key,
          nonce: row.wrap_nonce,
          authTag: row.wrap_auth_tag,
        };
  }

  async putTenantKey(tenantId: string, key: WrappedTenantKey): Promise<void> {
    await this.#pool.query(
      `INSERT INTO tenant_keys (
         tenant_id, key_version, wrapped_key, wrap_nonce, wrap_auth_tag, wrapping_key_id
       ) VALUES ($1, $2, $3, $4, $5, 'SYNC_MASTER_KEY')
       ON CONFLICT (tenant_id, key_version) DO NOTHING`,
      [tenantId, key.version, key.wrappedKey, key.nonce, key.authTag],
    );
  }

  async appendChanges(
    tenantId: string,
    projectId: string,
    deviceId: string,
    changes: EncryptedOperation[],
  ): Promise<number[]> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query(
        "SELECT 1 FROM remote_projects WHERE id = $1 AND tenant_id = $2",
        [projectId, tenantId],
      );
      if (project.rowCount !== 1) throw new Error("Unknown project");
      await client.query(
        "INSERT INTO devices (tenant_id, project_id, device_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [tenantId, projectId, deviceId],
      );
      for (const change of changes) {
        if (change.action === "delete") {
          await client.query(
            `DELETE FROM sync_changes
             WHERE tenant_id = $1 AND project_id = $2 AND entity_type = $3 AND entity_id = $4`,
            [tenantId, projectId, change.entityType, change.entityId],
          );
        }
        await client.query(
          `INSERT INTO sync_changes (tenant_id, project_id, origin_device_id, sequence, entity_type, entity_id, action, created_at, ciphertext, nonce, auth_tag)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (tenant_id, project_id, origin_device_id, sequence) DO NOTHING`,
          [
            tenantId,
            projectId,
            deviceId,
            change.sequence,
            change.entityType,
            change.entityId,
            change.action,
            change.createdAt,
            change.ciphertext,
            change.nonce,
            change.authTag,
          ],
        );
      }
      await client.query("COMMIT");
      return changes.map((change) => change.sequence);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listChanges(
    tenantId: string,
    projectId: string,
    after: string | null,
    limit: number,
  ): Promise<StoredEncryptedChange[]> {
    const result = await this.#pool.query<{
      cursor: string;
      origin_device_id: string;
      sequence: string;
      entity_type: string;
      entity_id: string;
      action: string;
      created_at: Date;
      ciphertext: Buffer;
      nonce: Buffer;
      auth_tag: Buffer;
    }>(
      `SELECT cursor, origin_device_id, sequence, entity_type, entity_id, action, created_at, ciphertext, nonce, auth_tag
       FROM sync_changes WHERE tenant_id = $1 AND project_id = $2 AND cursor > $3 ORDER BY cursor ASC LIMIT $4`,
      [tenantId, projectId, after ?? "0", limit],
    );
    return result.rows.map((row) => ({
      cursor: row.cursor,
      originDeviceId: row.origin_device_id,
      sequence: Number(row.sequence),
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
      createdAt: row.created_at.toISOString(),
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.auth_tag,
    }));
  }

  async ready(): Promise<boolean> {
    try {
      await this.#pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
}
