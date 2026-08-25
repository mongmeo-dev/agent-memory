import { createHmac } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { revokeTenantToken } from "../src/sync-admin.js";
import { createSyncService, type SyncService } from "../src/sync-service.js";
import { InMemorySyncRepository } from "../src/sync-service-db.js";
import type { OutboxOperation } from "../src/types.js";

const pepper = "test-pepper";
const key = Buffer.alloc(32, 7);
const operation = (
  sequence: number,
  payload: unknown = { projectId: "local", value: sequence },
): OutboxOperation => ({
  sequence,
  entityType: "memory",
  entityId: `memory-${sequence}`,
  action: "upsert",
  payload,
  createdAt: "2026-01-01T00:00:00.000Z",
});

async function serviceWithToken(): Promise<{
  repository: InMemorySyncRepository;
  service: SyncService;
  url: string;
  token: string;
}> {
  const repository = new InMemorySyncRepository();
  await repository.createTenant("tenant-a");
  await repository.createProject("tenant-a", "project-a");
  const token = "test-token";
  await repository.createAccessToken(
    "tenant-a",
    createHmac("sha256", pepper).update(token).digest(),
  );
  const service = createSyncService({ repository, tokenHmacPepper: pepper, masterKey: key });
  service.server.listen(0, "127.0.0.1");
  await once(service.server, "listening");
  const address = service.server.address() as AddressInfo;
  return { repository, service, url: `http://127.0.0.1:${address.port}`, token };
}

const running: SyncService[] = [];
afterEach(async () => {
  await Promise.all(
    running
      .splice(0)
      .map(
        (service) =>
          new Promise<void>((resolve, reject) =>
            service.server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
  );
});

async function request(url: string, token: string, init: RequestInit): Promise<Response> {
  return fetch(`${url}/v1/projects/project-a/changes`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });
}

describe("sync service", () => {
  it("rejects missing and incorrect bearer tokens", async () => {
    const fixture = await serviceWithToken();
    running.push(fixture.service);
    expect((await fetch(`${fixture.url}/v1/projects/project-a/changes`)).status).toBe(401);
    expect((await request(fixture.url, "wrong", { method: "GET" })).status).toBe(401);
  });

  it("revokes bearer tokens by HMAC without storing plaintext", async () => {
    const fixture = await serviceWithToken();
    running.push(fixture.service);
    expect(await revokeTenantToken(fixture.repository, pepper, fixture.token)).toBe(true);
    expect(await request(fixture.url, fixture.token, { method: "GET" })).toHaveProperty(
      "status",
      401,
    );
  });

  it("does not permit a tenant to access another tenant project", async () => {
    const fixture = await serviceWithToken();
    running.push(fixture.service);
    await fixture.repository.createTenant("tenant-b");
    await fixture.repository.createProject("tenant-b", "project-b");
    const response = await fetch(`${fixture.url}/v1/projects/project-b/changes`, {
      headers: { authorization: `Bearer ${fixture.token}` },
    });
    expect(response.status).toBe(404);
  });

  it("accepts duplicate pushes idempotently and stores encrypted payloads", async () => {
    const fixture = await serviceWithToken();
    running.push(fixture.service);
    const payload = { projectId: "local", secret: "payload-must-not-be-plaintext" };
    for (let index = 0; index < 2; index += 1) {
      const response = await request(fixture.url, fixture.token, {
        method: "POST",
        body: JSON.stringify({ deviceId: "device-a", changes: [operation(1, payload)] }),
      });
      expect(await response.json()).toEqual({ acceptedSequences: [1] });
    }
    expect(fixture.repository.changes).toHaveLength(1);
    expect(fixture.repository.changes[0]?.ciphertext.toString("utf8")).not.toContain(
      "payload-must-not-be-plaintext",
    );
    const tenantKey = fixture.repository.tenantKeys.get("tenant-a");
    expect(tenantKey?.wrappedKey).toHaveLength(32);
    expect(tenantKey?.wrappedKey.equals(key)).toBe(false);
  });

  it("returns pushed changes and paginates by cursor", async () => {
    const fixture = await serviceWithToken();
    running.push(fixture.service);
    const pushed = await request(fixture.url, fixture.token, {
      method: "POST",
      body: JSON.stringify({
        deviceId: "device-a",
        changes: [operation(1), operation(2), operation(3)],
      }),
    });
    expect(pushed.status).toBe(200);
    const first = await request(fixture.url, fixture.token, { method: "GET" });
    const firstBody = (await first.json()) as {
      changes: Array<{ operation: OutboxOperation }>;
      nextCursor: string;
      hasMore: boolean;
    };
    expect(firstBody.changes.map((change) => change.operation.sequence)).toEqual([1, 2, 3]);
    const page = await fetch(`${fixture.url}/v1/projects/project-a/changes?limit=2`, {
      headers: { authorization: `Bearer ${fixture.token}` },
    });
    const pageBody = (await page.json()) as {
      changes: Array<{ operation: OutboxOperation }>;
      nextCursor: string;
      hasMore: boolean;
    };
    expect(pageBody.changes).toHaveLength(2);
    expect(pageBody.hasMore).toBe(true);
    const secondPage = await fetch(
      `${fixture.url}/v1/projects/project-a/changes?after=${pageBody.nextCursor}&limit=2`,
      { headers: { authorization: `Bearer ${fixture.token}` } },
    );
    expect(
      ((await secondPage.json()) as { changes: Array<{ operation: OutboxOperation }> }).changes.map(
        (change) => change.operation.sequence,
      ),
    ).toEqual([3]);
  });

  it("privacy delete removes the previous encrypted entity payload", async () => {
    const fixture = await serviceWithToken();
    running.push(fixture.service);
    await request(fixture.url, fixture.token, {
      method: "POST",
      body: JSON.stringify({
        deviceId: "device-a",
        changes: [operation(1, { projectId: "local", secret: "erase-remotely" })],
      }),
    });
    await request(fixture.url, fixture.token, {
      method: "POST",
      body: JSON.stringify({
        deviceId: "device-a",
        changes: [
          {
            ...operation(2, { projectId: "local" }),
            entityId: "memory-1",
            action: "delete",
          },
        ],
      }),
    });

    expect(fixture.repository.changes).toHaveLength(1);
    expect(fixture.repository.changes[0]?.action).toBe("delete");
    expect(
      fixture.repository.changes.some((change) =>
        change.ciphertext.toString("utf8").includes("erase-remotely"),
      ),
    ).toBe(false);
  });

  it("AES-GCM AAD가 operation metadata 변조를 거부한다", async () => {
    const fixture = await serviceWithToken();
    running.push(fixture.service);
    await request(fixture.url, fixture.token, {
      method: "POST",
      body: JSON.stringify({
        deviceId: "device-a",
        changes: [operation(1, { projectId: "local" })],
      }),
    });
    const stored = fixture.repository.changes[0];
    if (stored === undefined) throw new Error("encrypted change가 필요합니다.");
    stored.action = "delete";

    expect((await request(fixture.url, fixture.token, { method: "GET" })).status).toBe(404);
  });

  it("enforces body and change-count limits", async () => {
    const fixture = await serviceWithToken();
    running.push(fixture.service);
    const many = Array.from({ length: 501 }, (_, index) => operation(index));
    expect(
      (
        await request(fixture.url, fixture.token, {
          method: "POST",
          body: JSON.stringify({ deviceId: "device-a", changes: many }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(fixture.url, fixture.token, {
          method: "POST",
          body: JSON.stringify({
            deviceId: "device-a",
            changes: [operation(1, "x".repeat(5 * 1024 * 1024))],
          }),
        })
      ).status,
    ).toBe(413);
  });
});
