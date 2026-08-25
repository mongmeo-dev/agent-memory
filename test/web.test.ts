import { request } from "node:http";
import { Script } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";

import type { CredentialStore } from "../src/credentials.js";
import { MemoryStore } from "../src/store.js";
import { createManagementServer, type ManagementServer } from "../src/web.js";
import { managementUi } from "../src/web-ui.js";

interface Fixture {
  store: MemoryStore;
  server: ManagementServer;
  baseUrl: string;
}

const fixtures: Fixture[] = [];

async function fixture(): Promise<Fixture> {
  const store = new MemoryStore(":memory:");
  const credentials = new Map<string, string>();
  const credentialStore: CredentialStore = {
    get: (id) => credentials.get(id) ?? null,
    set: (id, token) => credentials.set(id, token),
    delete: (id) => {
      credentials.delete(id);
    },
  };
  const server = createManagementServer(store, {
    port: 0,
    token: "test-management-token",
    credentialStore,
  });
  await server.start();
  const address = server.address();
  if (address === null) throw new Error("Server did not start.");
  const result = { store, server, baseUrl: `http://127.0.0.1:${address.port}` };
  fixtures.push(result);
  return result;
}

async function api(fixture: Fixture, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${fixture.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${fixture.server.token}`, ...init.headers },
  });
}

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map(async ({ server, store }) => {
      await server.stop();
      store.close();
    }),
  );
});

describe("management web server", () => {
  it("refuses non-loopback bind addresses", () => {
    const store = new MemoryStore(":memory:");
    try {
      expect(() => createManagementServer(store, { host: "0.0.0.0" })).toThrow("loopback");
    } finally {
      store.close();
    }
  });

  it("rejects unauthorized API requests but permits health", async () => {
    const app = await fixture();
    expect((await fetch(`${app.baseUrl}/api/health`)).status).toBe(200);
    expect((await fetch(`${app.baseUrl}/api/stats`)).status).toBe(401);
  });

  it("creates, reads, updates, and deletes memories", async () => {
    const app = await fixture();
    const created = (await (
      await api(app, "/api/memories", {
        method: "POST",
        body: JSON.stringify({ kind: "fact", summary: "Initial summary" }),
      })
    ).json()) as { id: string; summary: string };
    expect(created.summary).toBe("Initial summary");
    expect(
      ((await (await api(app, `/api/memories/${created.id}`)).json()) as { id: string }).id,
    ).toBe(created.id);
    expect(
      ((await (await api(app, "/api/memories?q=Initial")).json()) as { id: string }[])[0]?.id,
    ).toBe(created.id);
    expect(
      (
        (await (
          await api(app, `/api/memories/${created.id}`, {
            method: "PATCH",
            body: JSON.stringify({ summary: "Corrected summary", status: "resolved" }),
          })
        ).json()) as { summary: string; status: string }
      ).status,
    ).toBe("resolved");
    expect((await api(app, `/api/memories/${created.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(app, `/api/memories/${created.id}`)).status).toBe(404);
  });

  it("accepts normalized lifecycle adapter events through the daemon API", async () => {
    const app = await fixture();
    const response = await api(app, "/api/adapter", {
      method: "POST",
      body: JSON.stringify({
        client: "claude",
        payload: {
          hook_event_name: "PostToolUseFailure",
          tool_name: "Bash",
          error: "command failed",
          cwd: process.cwd(),
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(app.store.listEvents({ type: "tool.failed" })).toHaveLength(1);
    expect(app.store.listMemories({ kind: "problem" })).toHaveLength(1);
  });

  it("does not expose another project through ID detail routes", async () => {
    const app = await fixture();
    const external = app.store.recordMemory({
      kind: "fact",
      summary: "external project",
      agent: "test",
      projectId: "different-project",
      branch: "main",
      headCommit: "abc",
    });
    expect((await api(app, `/api/memories/${external.id}`)).status).toBe(404);
    expect((await api(app, `/api/events/${external.evidenceEventIds[0]}`)).status).toBe(404);
  });

  it("updates pause settings and exports the collection", async () => {
    const app = await fixture();
    const settings = (await (
      await api(app, "/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          paused: true,
          excludedGlobs: ["*.secret"],
          redactionPatterns: ["token=[^\\s]+"],
        }),
      })
    ).json()) as { paused: boolean };
    expect(settings.paused).toBe(true);
    const exported = (await (await api(app, "/api/export")).json()) as {
      settings: { paused: boolean };
    };
    expect(exported.settings.paused).toBe(true);
  });

  it("configures and disables project synchronization without returning its token", async () => {
    const app = await fixture();
    const configured = await api(app, "/api/sync", {
      method: "PUT",
      body: JSON.stringify({
        baseUrl: "https://sync.example.com",
        remoteProjectId: "remote-project",
        token: "a-very-long-sync-token-value",
      }),
    });
    expect(configured.status).toBe(200);
    expect(await configured.text()).not.toContain("a-very-long-sync-token-value");

    const status = (await (await api(app, "/api/sync")).json()) as {
      enabled: boolean;
      credentialAvailable: boolean;
    };
    expect(status).toMatchObject({ enabled: true, credentialAvailable: true });
    expect((await api(app, "/api/sync", { method: "DELETE" })).status).toBe(200);
    expect(((await (await api(app, "/api/sync")).json()) as { enabled: boolean }).enabled).toBe(
      false,
    );
  });

  it("rejects non-loopback Host headers", async () => {
    const app = await fixture();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${app.baseUrl}/api/stats`,
        { headers: { Host: "example.com", Authorization: `Bearer ${app.server.token}` } },
        (response) => resolve(response.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(
      (
        await fetch(`${app.baseUrl}/api/stats`, {
          headers: {
            Authorization: `Bearer ${app.server.token}`,
            Origin: "http://127.0.0.1:65530",
          },
        })
      ).status,
    ).toBe(403);
  });

  it("serves the management UI", async () => {
    const app = await fixture();
    const response = await fetch(`${app.baseUrl}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Agents Memory");
  });

  it("ships a parseable, accessible control-room UI shell", () => {
    const script = managementUi.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    if (script === undefined) throw new Error("management module script가 필요합니다.");
    expect(() => new Script(script)).not.toThrow();
    expect(managementUi).toContain('href="#main-content"');
    expect(managementUi).toContain("Memory control room");
    expect(managementUi).toContain('<dialog class="dialog" id="settings-dialog">');
    expect(managementUi).not.toContain("prompt(");
    expect(managementUi).not.toContain("alert(");
  });
});
