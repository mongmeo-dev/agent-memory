import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { type AdapterClient, ingestAdapterPayload } from "./adapters.js";
import { type CredentialStore, SystemCredentialStore } from "./credentials.js";
import {
  hybridSearchMemories,
  indexProjectMemories,
  OpenAICompatibleEmbeddingProvider,
} from "./embeddings.js";
import { resolveGitContext } from "./git-context.js";
import { redact } from "./redaction.js";
import { readSpoolLossCount } from "./spool.js";
import type { MemoryStore } from "./store.js";
import { SyncClient, syncEndpointId, validateSyncBaseUrl } from "./sync.js";
import type { CollectionSettings, MemoryKind, MemoryStatus } from "./types.js";
import { managementUi } from "./web-ui.js";

const MAX_BODY_BYTES = 1_048_576;
const memoryKinds = new Set<MemoryKind>([
  "goal",
  "decision",
  "change",
  "problem",
  "solution",
  "constraint",
  "todo",
  "fact",
]);
const memoryStatuses = new Set<Exclude<MemoryStatus, "deleted">>([
  "active",
  "superseded",
  "resolved",
]);

export interface ManagementServerOptions {
  host?: string;
  port?: number;
  token?: string;
  credentialStore?: CredentialStore;
}

export interface ManagementServer {
  readonly token: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  address(): { host: string; port: number } | null;
}

function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const name = host.startsWith("[")
    ? host.replace(/^\[|\](?::\d+)?$/g, "")
    : host.split(":").length === 2
      ? host.replace(/:\d+$/, "")
      : host;
  const normalized = name.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function isAllowedOrigin(origin: string | undefined, requestHost: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      isLoopbackHost(url.host) &&
      requestHost !== undefined &&
      url.host.toLowerCase() === requestHost.toLowerCase()
    );
  } catch {
    return false;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return {};
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON object required.");
  }
  return parsed as Record<string, unknown>;
}

function numberParam(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error("Invalid pagination parameter.");
  return parsed;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${name} must be a non-empty string.`);
  return value;
}

function scope(cwd: string | null) {
  return resolveGitContext(cwd ?? process.cwd());
}

function collectionSettings(value: Record<string, unknown>): CollectionSettings {
  if (
    typeof value.paused !== "boolean" ||
    !Array.isArray(value.excludedGlobs) ||
    !Array.isArray(value.redactionPatterns)
  ) {
    throw new Error("Invalid collection settings.");
  }
  if (
    ![...value.excludedGlobs, ...value.redactionPatterns].every((item) => typeof item === "string")
  ) {
    throw new Error("Settings arrays must contain strings.");
  }
  return {
    paused: value.paused,
    excludedGlobs: value.excludedGlobs as string[],
    redactionPatterns: value.redactionPatterns as string[],
  };
}

export function createManagementServer(
  store: MemoryStore,
  options: ManagementServerOptions = {},
): ManagementServer {
  const host = options.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) throw new Error("관리 서버는 loopback 주소에만 bind할 수 있습니다.");
  const port = options.port ?? 3789;
  const token = options.token ?? randomBytes(32).toString("base64url");
  const credentials = options.credentialStore ?? new SystemCredentialStore();
  let server: Server | undefined;

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (!isLoopbackHost(request.headers.host)) {
      sendError(response, 403, "Loopback Host required.");
      return;
    }
    if (!isAllowedOrigin(request.headers.origin, request.headers.host)) {
      sendError(response, 403, "Loopback Origin required.");
      return;
    }
    if (url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      });
      response.end(managementUi);
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      sendError(response, 404, "Not found.");
      return;
    }
    if (url.pathname !== "/api/health" && request.headers.authorization !== `Bearer ${token}`) {
      sendError(response, 401, "Unauthorized.");
      return;
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/health")
        return sendJson(response, 200, { ok: true });
      if (request.method === "GET" && url.pathname === "/api/context")
        return sendJson(response, 200, scope(url.searchParams.get("cwd")));
      if (request.method === "POST" && url.pathname === "/api/adapter") {
        const body = await readJson(request);
        if (body.client !== "claude" && body.client !== "codex" && body.client !== "gjc") {
          throw new Error("올바른 adapter client가 필요합니다.");
        }
        return sendJson(response, 200, {
          context: ingestAdapterPayload(body.client as AdapterClient, body.payload, { store }),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/memories") {
        const context = scope(url.searchParams.get("cwd"));
        const kind = url.searchParams.get("kind");
        const status = url.searchParams.get("status");
        if (kind !== null && !memoryKinds.has(kind as MemoryKind))
          throw new Error("Invalid memory kind.");
        if (status !== null && !memoryStatuses.has(status as Exclude<MemoryStatus, "deleted">))
          throw new Error("Invalid memory status.");
        const limit = numberParam(url.searchParams.get("limit"));
        const offset = numberParam(url.searchParams.get("offset"));
        const query = url.searchParams.get("q");
        if (query !== null && query.trim() !== "") {
          const endpoint = process.env.AGENTS_MEMORY_EMBEDDING_ENDPOINT;
          const model = process.env.AGENTS_MEMORY_EMBEDDING_MODEL;
          const input = {
            query,
            projectId: context.projectId,
            currentBranch: context.branch,
            repositoryRoot: context.repositoryRoot,
            currentHeadCommit: context.headCommit,
            ...(url.searchParams.has("requestedBranch")
              ? { requestedBranch: url.searchParams.get("requestedBranch") }
              : {}),
            ...(limit === undefined ? {} : { limit }),
          };
          if (endpoint !== undefined && model !== undefined) {
            const provider = new OpenAICompatibleEmbeddingProvider({
              endpoint,
              model,
              ...(process.env.AGENTS_MEMORY_EMBEDDING_API_KEY === undefined
                ? {}
                : { apiKey: process.env.AGENTS_MEMORY_EMBEDDING_API_KEY }),
            });
            await indexProjectMemories(store, context.projectId, provider);
            return sendJson(response, 200, await hybridSearchMemories(store, input, provider));
          }
          return sendJson(response, 200, store.searchMemories(input));
        }
        return sendJson(
          response,
          200,
          store.listMemories({
            projectId: context.projectId,
            ...(url.searchParams.has("branch") ? { branch: url.searchParams.get("branch") } : {}),
            ...(kind === null ? {} : { kind: kind as MemoryKind }),
            ...(status === null ? {} : { status: status as Exclude<MemoryStatus, "deleted"> }),
            ...(limit === undefined ? {} : { limit }),
            ...(offset === undefined ? {} : { offset }),
          }),
        );
      }
      if (request.method === "POST" && url.pathname === "/api/memories") {
        const body = await readJson(request);
        const context = scope(typeof body.cwd === "string" ? body.cwd : null);
        const kind = stringValue(body.kind, "kind") as MemoryKind;
        if (!memoryKinds.has(kind)) throw new Error("Invalid memory kind.");
        return sendJson(
          response,
          201,
          store.recordMemory({
            kind,
            summary: stringValue(body.summary, "summary"),
            agent: typeof body.agent === "string" ? body.agent : "management",
            projectId: context.projectId,
            branch: context.branch,
            headCommit: context.headCommit,
          }),
        );
      }
      const memoryMatch = /^\/api\/memories\/([^/]+)$/.exec(url.pathname);
      if (memoryMatch !== null) {
        const id = decodeURIComponent(memoryMatch[1] ?? "");
        if (request.method === "GET") {
          const memory = store.getMemory(id);
          const context = scope(url.searchParams.get("cwd"));
          return memory === null || memory.projectId !== context.projectId
            ? sendError(response, 404, "Memory not found.")
            : sendJson(response, 200, memory);
        }
        if (request.method === "DELETE") {
          const memory = store.getMemory(id);
          const context = scope(url.searchParams.get("cwd"));
          return memory !== null && memory.projectId === context.projectId && store.deleteMemory(id)
            ? sendJson(response, 200, { deleted: true })
            : sendError(response, 404, "Memory not found.");
        }
        if (request.method === "PATCH") {
          const body = await readJson(request);
          const current = store.getMemory(id);
          const context = scope(typeof body.cwd === "string" ? body.cwd : null);
          if (current === null || current.projectId !== context.projectId) {
            return sendError(response, 404, "Memory not found.");
          }
          const update: {
            summary?: string;
            kind?: MemoryKind;
            status?: Exclude<MemoryStatus, "deleted">;
          } = {};
          if (body.summary !== undefined) update.summary = stringValue(body.summary, "summary");
          if (body.kind !== undefined) {
            if (typeof body.kind !== "string" || !memoryKinds.has(body.kind as MemoryKind))
              throw new Error("Invalid memory kind.");
            update.kind = body.kind as MemoryKind;
          }
          if (body.status !== undefined) {
            if (
              typeof body.status !== "string" ||
              !memoryStatuses.has(body.status as Exclude<MemoryStatus, "deleted">)
            )
              throw new Error("Invalid memory status.");
            update.status = body.status as Exclude<MemoryStatus, "deleted">;
          }
          const memory = store.updateMemory(id, update);
          return memory === null
            ? sendError(response, 404, "Memory not found.")
            : sendJson(response, 200, memory);
        }
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        const context = scope(url.searchParams.get("cwd"));
        const type = url.searchParams.get("type");
        const limit = numberParam(url.searchParams.get("limit"));
        const offset = numberParam(url.searchParams.get("offset"));
        return sendJson(
          response,
          200,
          store.listEvents({
            projectId: context.projectId,
            ...(url.searchParams.has("branch") ? { branch: url.searchParams.get("branch") } : {}),
            ...(type === null ? {} : { type }),
            ...(limit === undefined ? {} : { limit }),
            ...(offset === undefined ? {} : { offset }),
          }),
        );
      }
      const eventMatch = /^\/api\/events\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && eventMatch !== null) {
        const event = store.getEvent(decodeURIComponent(eventMatch[1] ?? ""));
        const context = scope(url.searchParams.get("cwd"));
        return event === null || event.projectId !== context.projectId
          ? sendError(response, 404, "Event not found.")
          : sendJson(response, 200, event);
      }
      if (request.method === "GET" && url.pathname === "/api/settings")
        return sendJson(response, 200, store.getCollectionSettings());
      if (request.method === "PUT" && url.pathname === "/api/settings")
        return sendJson(
          response,
          200,
          store.setCollectionSettings(collectionSettings(await readJson(request))),
        );
      if (request.method === "GET" && url.pathname === "/api/stats")
        return sendJson(response, 200, {
          ...store.getStats(),
          spoolLosses: readSpoolLossCount(),
        });
      if (request.method === "GET" && url.pathname === "/api/export")
        return sendJson(response, 200, store.exportBundle());
      if (request.method === "POST" && url.pathname === "/api/redact/preview") {
        const body = await readJson(request);
        return sendJson(
          response,
          200,
          redact(stringValue(body.text, "text"), store.getCollectionSettings().redactionPatterns),
        );
      }
      if (request.method === "GET" && url.pathname === "/api/sync") {
        const context = scope(url.searchParams.get("cwd"));
        const settings = store.getSyncSettings(context.projectId);
        return sendJson(response, 200, {
          ...settings,
          credentialAvailable:
            settings.endpointId !== null && credentials.get(settings.endpointId) !== null,
        });
      }
      if (request.method === "PUT" && url.pathname === "/api/sync") {
        const body = await readJson(request);
        const context = scope(typeof body.cwd === "string" ? body.cwd : null);
        const baseUrl = stringValue(body.baseUrl, "baseUrl");
        const remoteProjectId = stringValue(body.remoteProjectId, "remoteProjectId");
        const tokenValue = stringValue(body.token, "token");
        const allowInsecureLoopback = body.allowInsecureLoopback === true;
        validateSyncBaseUrl(baseUrl, allowInsecureLoopback);
        const endpointId = syncEndpointId(baseUrl);
        credentials.set(endpointId, tokenValue);
        const current = store.getSyncSettings(context.projectId);
        if (
          !current.enabled ||
          current.endpointId !== endpointId ||
          current.remoteProjectId !== remoteProjectId
        ) {
          store.bootstrapOutbox(context.projectId);
        }
        return sendJson(
          response,
          200,
          store.setSyncSettings(context.projectId, {
            enabled: true,
            baseUrl,
            remoteProjectId,
            endpointId,
            allowInsecureLoopback,
            lastSyncedAt: null,
            lastError: null,
          }),
        );
      }
      if (request.method === "DELETE" && url.pathname === "/api/sync") {
        const context = scope(url.searchParams.get("cwd"));
        const current = store.getSyncSettings(context.projectId);
        if (current.endpointId !== null) credentials.delete(current.endpointId);
        return sendJson(
          response,
          200,
          store.setSyncSettings(context.projectId, {
            ...current,
            enabled: false,
            endpointId: null,
            lastError: null,
          }),
        );
      }
      if (request.method === "POST" && url.pathname === "/api/sync/run") {
        const body = await readJson(request);
        const context = scope(typeof body.cwd === "string" ? body.cwd : null);
        const current = store.getSyncSettings(context.projectId);
        if (
          !current.enabled ||
          current.baseUrl === null ||
          current.remoteProjectId === null ||
          current.endpointId === null
        ) {
          throw new Error("동기화가 설정되지 않았습니다.");
        }
        const remoteToken = credentials.get(current.endpointId);
        if (remoteToken === null) throw new Error("동기화 자격증명을 찾을 수 없습니다.");
        try {
          const result = await new SyncClient(store, {
            baseUrl: current.baseUrl,
            token: remoteToken,
            remoteProjectId: current.remoteProjectId,
            localProjectId: context.projectId,
            allowInsecureLoopback: current.allowInsecureLoopback,
          }).syncOnce();
          store.setSyncSettings(context.projectId, {
            ...current,
            lastSyncedAt: new Date().toISOString(),
            lastError: null,
          });
          return sendJson(response, 200, result);
        } catch (error) {
          store.setSyncSettings(context.projectId, {
            ...current,
            lastError: error instanceof Error ? error.message.slice(0, 500) : "동기화 실패",
          });
          throw error;
        }
      }
      sendError(response, 404, "Not found.");
    } catch (error) {
      sendError(response, 400, error instanceof Error ? error.message : "Invalid request.");
    }
  };

  return {
    token,
    async start(): Promise<void> {
      if (server !== undefined) return;
      server = createServer((request, response) => {
        void handler(request, response);
      });
      await new Promise<void>((resolve, reject) => {
        server?.once("error", reject);
        server?.listen(port, host, () => {
          server?.off("error", reject);
          resolve();
        });
      });
    },
    async stop(): Promise<void> {
      if (server === undefined) return;
      const running = server;
      server = undefined;
      await new Promise<void>((resolve, reject) =>
        running.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
    address(): { host: string; port: number } | null {
      if (server === undefined) return null;
      const address = server.address();
      return address !== null && typeof address !== "string"
        ? { host: address.address, port: address.port }
        : null;
    },
  };
}
