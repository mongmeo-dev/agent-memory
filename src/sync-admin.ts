import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { PostgresSyncRepository, type SyncRepository } from "./sync-service-db.js";

export interface CreateTenantProjectResult {
  tenantId: string;
  projectId: string;
  token: string;
}

export async function createTenantProject(
  repository: SyncRepository,
  tokenHmacPepper: string,
  tenantId: string = randomUUID(),
  projectId: string = randomUUID(),
): Promise<CreateTenantProjectResult> {
  if (tokenHmacPepper.length === 0) throw new Error("TOKEN_HMAC_PEPPER is required");
  const token = randomBytes(32).toString("base64url");
  const tokenHmac = createHmac("sha256", tokenHmacPepper).update(token).digest();
  await repository.createTenant(tenantId);
  await repository.createProject(tenantId, projectId);
  await repository.createAccessToken(tenantId, tokenHmac);
  return { tenantId, projectId, token };
}

export async function revokeTenantToken(
  repository: SyncRepository,
  tokenHmacPepper: string,
  token: string,
): Promise<boolean> {
  if (tokenHmacPepper.length === 0 || token.length === 0) {
    throw new Error("pepper와 token이 필요합니다.");
  }
  return repository.revokeAccessToken(createHmac("sha256", tokenHmacPepper).update(token).digest());
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export async function runSyncAdmin(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const pepper = process.env.TOKEN_HMAC_PEPPER;
  if (databaseUrl === undefined || pepper === undefined)
    throw new Error("DATABASE_URL and TOKEN_HMAC_PEPPER are required");
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const repository = new PostgresSyncRepository(pool);
    const action = process.argv[2] ?? "create";
    if (action === "revoke") {
      const token = argument("--token");
      if (token === undefined) throw new Error("revoke에는 --token이 필요합니다.");
      process.stdout.write(
        `${JSON.stringify({ revoked: await revokeTenantToken(repository, pepper, token) })}\n`,
      );
    } else if (action === "create") {
      const result = await createTenantProject(
        repository,
        pepper,
        argument("--tenant-id"),
        argument("--project-id"),
      );
      process.stdout.write(
        `tenantId=${result.tenantId}\nprojectId=${result.projectId}\ntoken=${result.token}\n`,
      );
    } else {
      throw new Error("동작은 create 또는 revoke여야 합니다.");
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSyncAdmin();
}
