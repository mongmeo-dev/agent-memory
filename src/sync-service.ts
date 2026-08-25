import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import type { EncryptedOperation, SyncRepository, WrappedTenantKey } from "./sync-service-db.js";
import type { OutboxOperation } from "./types.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_CHANGES = 500;

export interface SyncServiceOptions {
  repository: SyncRepository;
  tokenHmacPepper: string;
  masterKey: string | Buffer;
}

export interface SyncService {
  handler(request: IncomingMessage, response: ServerResponse): Promise<void>;
  server: Server;
}

function tokenHmac(token: string, pepper: string): Buffer {
  return createHmac("sha256", pepper).update(token).digest();
}

function masterKey(value: string | Buffer): Buffer {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 32) throw new Error("SYNC_MASTER_KEY must be 32 bytes");
    return Buffer.from(value);
  }
  const key = /^[0-9a-f]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("SYNC_MASTER_KEY must be a base64 or hex 32-byte key");
  return key;
}

function operationAad(
  tenantId: string,
  projectId: string,
  deviceId: string,
  operation: {
    sequence: number;
    entityType: string;
    entityId: string;
    action: string;
    createdAt: string;
  },
): Buffer {
  return Buffer.from(
    JSON.stringify([
      tenantId,
      projectId,
      deviceId,
      operation.sequence,
      operation.entityType,
      operation.entityId,
      operation.action,
      operation.createdAt,
    ]),
  );
}

function encrypt(
  operation: OutboxOperation,
  key: Buffer,
  context: { tenantId: string; projectId: string; deviceId: string },
): EncryptedOperation {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(operationAad(context.tenantId, context.projectId, context.deviceId, operation));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(operation.payload), "utf8"),
    cipher.final(),
  ]);
  return {
    sequence: operation.sequence,
    entityType: operation.entityType,
    entityId: operation.entityId,
    action: operation.action,
    createdAt: operation.createdAt,
    ciphertext,
    nonce,
    authTag: cipher.getAuthTag(),
  };
}

function decrypt(
  change: EncryptedOperation,
  key: Buffer,
  context: { tenantId: string; projectId: string; deviceId: string },
): OutboxOperation {
  const decipher = createDecipheriv("aes-256-gcm", key, change.nonce);
  decipher.setAAD(operationAad(context.tenantId, context.projectId, context.deviceId, change));
  decipher.setAuthTag(change.authTag);
  const payload = JSON.parse(
    Buffer.concat([decipher.update(change.ciphertext), decipher.final()]).toString("utf8"),
  ) as unknown;
  return {
    sequence: change.sequence,
    entityType: change.entityType as OutboxOperation["entityType"],
    entityId: change.entityId,
    action: change.action as OutboxOperation["action"],
    payload,
    createdAt: change.createdAt,
  };
}

function wrapTenantKey(tenantId: string, tenantKey: Buffer, wrappingKey: Buffer): WrappedTenantKey {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey, nonce);
  cipher.setAAD(Buffer.from(tenantId));
  return {
    version: 1,
    wrappedKey: Buffer.concat([cipher.update(tenantKey), cipher.final()]),
    nonce,
    authTag: cipher.getAuthTag(),
  };
}

function unwrapTenantKey(tenantId: string, wrapped: WrappedTenantKey, wrappingKey: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey, wrapped.nonce);
  decipher.setAAD(Buffer.from(tenantId));
  decipher.setAuthTag(wrapped.authTag);
  return Buffer.concat([decipher.update(wrapped.wrappedKey), decipher.final()]);
}

async function tenantEncryptionKey(
  repository: SyncRepository,
  tenantId: string,
  wrappingKey: Buffer,
): Promise<Buffer> {
  let wrapped = await repository.getTenantKey(tenantId);
  if (wrapped === null) {
    await repository.putTenantKey(tenantId, wrapTenantKey(tenantId, randomBytes(32), wrappingKey));
    wrapped = await repository.getTenantKey(tenantId);
  }
  if (wrapped === null) throw new Error("tenant encryption key creation failed");
  return unwrapTenantKey(tenantId, wrapped, wrappingKey);
}

function isOperation(value: unknown): value is OutboxOperation {
  if (typeof value !== "object" || value === null) return false;
  const operation = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(operation.sequence) &&
    (operation.sequence as number) >= 0 &&
    (operation.entityType === "event" ||
      operation.entityType === "memory" ||
      operation.entityType === "settings" ||
      operation.entityType === "tombstone") &&
    typeof operation.entityId === "string" &&
    operation.entityId.length > 0 &&
    (operation.action === "upsert" || operation.action === "delete") &&
    "payload" in operation &&
    typeof operation.createdAt === "string"
  );
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const header = request.headers["content-length"];
  if (header !== undefined && (!/^\d+$/.test(header) || Number(header) > MAX_BODY_BYTES))
    throw new RangeError("Body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RangeError("Body too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new SyntaxError("Invalid JSON");
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function pathProject(pathname: string): string | null {
  const match = /^\/v1\/projects\/([^/]+)\/changes$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return null;
  }
}

export function createSyncService(options: SyncServiceOptions): SyncService {
  if (options.tokenHmacPepper.length === 0) throw new Error("TOKEN_HMAC_PEPPER is required");
  const wrappingKey = masterKey(options.masterKey);

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://sync-service.invalid");
    if (request.method === "GET" && url.pathname === "/healthz")
      return send(response, 200, { ok: true });
    if (request.method === "GET" && url.pathname === "/readyz") {
      const ready = await options.repository.ready();
      return send(response, ready ? 200 : 503, { ok: ready });
    }

    const projectId = pathProject(url.pathname);
    if (projectId === null) return send(response, 404, { error: "not_found" });
    const authorization = request.headers.authorization;
    const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
    if (match === null) return send(response, 401, { error: "unauthorized" });
    const digest = tokenHmac(match[1] ?? "", options.tokenHmacPepper);
    const tenantId = await options.repository.tenantForToken(digest);
    if (tenantId === null) return send(response, 401, { error: "unauthorized" });

    try {
      const encryptionKey = await tenantEncryptionKey(options.repository, tenantId, wrappingKey);
      if (request.method === "POST") {
        const body = await readJson(request);
        if (
          typeof body !== "object" ||
          body === null ||
          typeof (body as { deviceId?: unknown }).deviceId !== "string" ||
          (body as { deviceId: string }).deviceId.length === 0 ||
          !Array.isArray((body as { changes?: unknown }).changes)
        ) {
          return send(response, 400, { error: "invalid_request" });
        }
        const { deviceId, changes } = body as { deviceId: string; changes: unknown[] };
        if (changes.length > MAX_CHANGES || !changes.every(isOperation))
          return send(response, 400, { error: "invalid_request" });
        const acceptedSequences = await options.repository.appendChanges(
          tenantId,
          projectId,
          deviceId,
          changes.map((change) =>
            encrypt(change, encryptionKey, { tenantId, projectId, deviceId }),
          ),
        );
        return send(response, 200, { acceptedSequences });
      }
      if (request.method === "GET") {
        const after = url.searchParams.get("after");
        const limitText = url.searchParams.get("limit") ?? "100";
        if ((after !== null && after !== "" && !/^\d+$/.test(after)) || !/^\d+$/.test(limitText))
          return send(response, 400, { error: "invalid_request" });
        const limit = Number(limitText);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CHANGES)
          return send(response, 400, { error: "invalid_request" });
        const rows = await options.repository.listChanges(
          tenantId,
          projectId,
          after === "" ? null : after,
          limit + 1,
        );
        const hasMore = rows.length > limit;
        const changes = rows.slice(0, limit).map((row) => ({
          cursor: row.cursor,
          originDeviceId: row.originDeviceId,
          operation: decrypt(row, encryptionKey, {
            tenantId,
            projectId,
            deviceId: row.originDeviceId,
          }),
        }));
        return send(response, 200, {
          changes,
          nextCursor: changes.at(-1)?.cursor ?? null,
          hasMore,
        });
      }
      return send(response, 405, { error: "method_not_allowed" });
    } catch (error) {
      if (error instanceof RangeError) return send(response, 413, { error: "body_too_large" });
      if (error instanceof SyntaxError) return send(response, 400, { error: "invalid_request" });
      return send(response, 404, { error: "not_found" });
    }
  };

  return { handler, server: createServer((request, response) => void handler(request, response)) };
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const databaseUrl = process.env.DATABASE_URL;
  const pepper = process.env.TOKEN_HMAC_PEPPER;
  const key = process.env.SYNC_MASTER_KEY;
  if (databaseUrl === undefined || pepper === undefined || key === undefined)
    throw new Error("DATABASE_URL, TOKEN_HMAC_PEPPER, and SYNC_MASTER_KEY are required");
  const { Pool } = await import("pg");
  const { PostgresSyncRepository } = await import("./sync-service-db.js");
  const pool = new Pool({ connectionString: databaseUrl });
  const service = createSyncService({
    repository: new PostgresSyncRepository(pool),
    tokenHmacPepper: pepper,
    masterKey: key,
  });
  service.server.listen(Number(process.env.PORT ?? "3000"), process.env.HOST ?? "0.0.0.0");
  const shutdown = (): void => {
    service.server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
