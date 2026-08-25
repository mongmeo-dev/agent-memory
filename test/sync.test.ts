import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../src/store.js";
import { SyncClient } from "../src/sync.js";
import type { Memory, OutboxOperation } from "../src/types.js";

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("서버 주소가 필요합니다.");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe("SyncClient", () => {
  const stores: MemoryStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  it("로컬 outbox를 전송하고 수락된 항목만 완료 처리한다", async () => {
    const store = new MemoryStore(":memory:");
    stores.push(store);
    store.recordMemory({
      kind: "decision",
      summary: "동기화할 결정",
      agent: "test",
      projectId: "local-project",
      branch: "main",
      headCommit: "abc",
    });
    const received: OutboxOperation[] = [];
    const server = await listen(async (request, response) => {
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          changes: OutboxOperation[];
        };
        received.push(...body.changes);
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ acceptedSequences: body.changes.map((item) => item.sequence) }),
        );
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ changes: [], nextCursor: null, hasMore: false }));
    });

    try {
      const client = new SyncClient(store, {
        baseUrl: server.baseUrl,
        token: "test-token",
        remoteProjectId: "remote-project",
        localProjectId: "local-project",
        allowInsecureLoopback: true,
      });
      const result = await client.syncOnce();

      expect(result.pushed).toBe(2);
      expect(received.map((item) => item.entityType)).toEqual(["event", "memory"]);
      expect(store.getPendingOutbox()).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("다른 장치의 원격 기억과 cursor를 적용한다", async () => {
    const store = new MemoryStore(":memory:");
    stores.push(store);
    const remoteMemory: Memory = {
      id: "remote-memory",
      kind: "fact",
      summary: "다른 장치에서 온 기억",
      status: "active",
      projectId: "local-project",
      branch: "feature/remote",
      headCommit: "def",
      agent: "remote",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      evidenceEventIds: [],
    };
    const operation: OutboxOperation = {
      sequence: 7,
      entityType: "memory",
      entityId: remoteMemory.id,
      action: "upsert",
      payload: remoteMemory,
      createdAt: remoteMemory.createdAt,
    };
    const server = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          changes: [{ cursor: "42", originDeviceId: "other-device", operation }],
          nextCursor: "42",
          hasMore: false,
        }),
      );
    });

    try {
      const client = new SyncClient(store, {
        baseUrl: server.baseUrl,
        token: "test-token",
        remoteProjectId: "remote-project",
        localProjectId: "local-project",
        allowInsecureLoopback: true,
      });
      const result = await client.syncOnce();

      expect(result).toMatchObject({ pushed: 0, pulled: 1, cursor: "42" });
      expect(store.getMemory(remoteMemory.id)?.summary).toBe(remoteMemory.summary);
    } finally {
      await server.close();
    }
  });

  it("평문 원격 HTTP endpoint를 거부한다", () => {
    const store = new MemoryStore(":memory:");
    stores.push(store);
    expect(
      () =>
        new SyncClient(store, {
          baseUrl: "http://example.com",
          token: "token",
          remoteProjectId: "remote",
          localProjectId: "local",
        }),
    ).toThrow("HTTPS");
  });

  it("동일 origin의 remote project마다 독립 cursor를 사용한다", async () => {
    const store = new MemoryStore(":memory:");
    stores.push(store);
    const server = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ changes: [], nextCursor: "9", hasMore: false }));
    });
    try {
      for (const remoteProjectId of ["remote-a", "remote-b"]) {
        await new SyncClient(store, {
          baseUrl: server.baseUrl,
          token: "test-token",
          remoteProjectId,
          localProjectId: "local-project",
          allowInsecureLoopback: true,
        }).syncOnce();
        const endpointId = createHash("sha256")
          .update(`${server.baseUrl}\n${remoteProjectId}`)
          .digest("hex");
        expect(store.getSyncCursor(endpointId, "local-project")).toBe("9");
      }
    } finally {
      await server.close();
    }
  });
});
