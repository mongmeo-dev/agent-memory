import { createHash } from "node:crypto";

import type { MemoryStore } from "./store.js";
import type { OutboxOperation } from "./types.js";

export interface SyncClientOptions {
  baseUrl: string;
  token: string;
  remoteProjectId: string;
  localProjectId: string;
  allowInsecureLoopback?: boolean;
  batchSize?: number;
}

interface RemoteChange {
  cursor: string;
  originDeviceId: string;
  operation: OutboxOperation;
}

interface PushResponse {
  acceptedSequences: number[];
}

interface PullResponse {
  changes: RemoteChange[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SyncResult {
  pushed: number;
  pulled: number;
  cursor: string | null;
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export function validateSyncBaseUrl(value: string, allowInsecureLoopback = false): URL {
  const url = new URL(value);
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("동기화 URL에는 인증정보, query 또는 fragment를 포함할 수 없습니다.");
  }
  if (
    url.protocol !== "https:" &&
    !(allowInsecureLoopback && url.protocol === "http:" && isLoopback(url.hostname))
  ) {
    throw new Error("동기화 endpoint는 HTTPS여야 합니다.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

export function syncEndpointId(baseUrl: string): string {
  const url = new URL(baseUrl);
  return createHash("sha256").update(`${url.protocol}//${url.host}`).digest("hex");
}

function projectIdOf(operation: OutboxOperation): string | null {
  if (typeof operation.payload !== "object" || operation.payload === null) return null;
  if (!("projectId" in operation.payload) || typeof operation.payload.projectId !== "string") {
    return null;
  }
  return operation.payload.projectId;
}

async function responseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const message = (await response.text()).slice(0, 500);
    throw new Error(`동기화 서버 오류 (${response.status}): ${message}`);
  }
  return (await response.json()) as T;
}

export class SyncClient {
  readonly #store: MemoryStore;
  readonly #baseUrl: URL;
  readonly #token: string;
  readonly #remoteProjectId: string;
  readonly #localProjectId: string;
  readonly #batchSize: number;
  readonly #endpointId: string;

  constructor(store: MemoryStore, options: SyncClientOptions) {
    this.#store = store;
    this.#baseUrl = validateSyncBaseUrl(options.baseUrl, options.allowInsecureLoopback === true);
    this.#token = options.token;
    this.#remoteProjectId = options.remoteProjectId;
    this.#localProjectId = options.localProjectId;
    this.#batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), 500);
    this.#endpointId = createHash("sha256")
      .update(`${this.#baseUrl.origin}\n${this.#remoteProjectId}`)
      .digest("hex");
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    return fetch(new URL(path, this.#baseUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.#token}`,
        ...(init.headers ?? {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  }

  async syncOnce(): Promise<SyncResult> {
    const deviceId = this.#store.getOrCreateDeviceId();
    const pending = this.#store
      .getPendingOutbox(1000, this.#localProjectId)
      .filter((operation) => projectIdOf(operation) === this.#localProjectId)
      .slice(0, this.#batchSize);
    let pushed = 0;

    if (pending.length > 0) {
      const response = await this.#request(
        `/v1/projects/${encodeURIComponent(this.#remoteProjectId)}/changes`,
        {
          method: "POST",
          body: JSON.stringify({ deviceId, changes: pending }),
        },
      );
      const result = await responseJson<PushResponse>(response);
      const accepted = pending
        .filter((operation) => result.acceptedSequences.includes(operation.sequence))
        .map((operation) => operation.sequence);
      this.#store.markOutboxSequencesSynced(accepted);
      pushed = accepted.length;
    }

    let cursor = this.#store.getSyncCursor(this.#endpointId, this.#localProjectId);
    let pulled = 0;
    let hasMore = true;
    while (hasMore) {
      const path = `/v1/projects/${encodeURIComponent(this.#remoteProjectId)}/changes?after=${encodeURIComponent(cursor ?? "")}&limit=500`;
      const response = await this.#request(path, { method: "GET" });
      const result = await responseJson<PullResponse>(response);
      for (const change of result.changes) {
        if (change.originDeviceId !== deviceId) {
          this.#store.applyRemoteOperation(change.operation);
          pulled += 1;
        }
      }
      if (result.nextCursor !== null) {
        cursor = result.nextCursor;
        this.#store.setSyncCursor(this.#endpointId, this.#localProjectId, cursor);
      }
      hasMore = result.hasMore;
      if (result.changes.length === 0) break;
    }

    return { pushed, pulled, cursor };
  }
}
