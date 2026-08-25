import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemoryServer } from "../src/mcp.js";
import { MemoryStore } from "../src/store.js";

function textFrom(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("텍스트 MCP 응답이 필요합니다.");
  return block.text;
}

describe("MCP server", () => {
  let store: MemoryStore;
  let client: Client;
  let server: ReturnType<typeof createMemoryServer>;
  let automaticUse: boolean;

  beforeEach(async () => {
    automaticUse = true;
    store = new MemoryStore(":memory:");
    server = createMemoryServer(store, { automaticUse: () => automaticUse });
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    store.close();
  });

  it("도구 목록을 제공하고 기억을 기록한 뒤 검색한다", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "memory.ingest",
      "memory.record",
      "memory.search",
      "memory.get",
      "memory.feedback",
      "memory.revalidate",
      "memory.handoff",
    ]);

    const recorded = await client.callTool({
      name: "memory.record",
      arguments: {
        kind: "decision",
        summary: "MCP 검색은 프로젝트 범위를 사용한다",
        agent: "test-client",
        cwd: process.cwd(),
      },
    });
    const memory = JSON.parse(textFrom(recorded)) as { id: string; summary: string };
    expect(memory.summary).toBe("MCP 검색은 프로젝트 범위를 사용한다");

    const searched = await client.callTool({
      name: "memory.search",
      arguments: { query: "MCP 검색", cwd: process.cwd() },
    });
    const results = JSON.parse(textFrom(searched)) as { id: string }[];
    expect(results.map((result) => result.id)).toContain(memory.id);

    const handoff = await client.callTool({
      name: "memory.handoff",
      arguments: { cwd: process.cwd() },
    });
    expect(textFrom(handoff)).toContain("MCP 검색은 프로젝트 범위를 사용한다");

    const resource = await client.readResource({ uri: "memory://context/current" });
    const content = resource.contents[0];
    if (content === undefined || !("text" in content))
      throw new Error("텍스트 resource가 필요합니다.");
    expect(content.text).toContain(memory.id);
  });

  it("자동 사용이 꺼진 프로젝트에서는 MCP 기록과 resource 조회를 차단한다", async () => {
    automaticUse = false;

    const recorded = await client.callTool({
      name: "memory.record",
      arguments: {
        kind: "decision",
        summary: "저장되면 안 되는 기억",
        agent: "test-client",
        cwd: process.cwd(),
      },
    });
    expect(JSON.parse(textFrom(recorded))).toMatchObject({ enabled: false });
    expect(store.listMemories()).toHaveLength(0);

    const resource = await client.readResource({ uri: "memory://context/current" });
    const content = resource.contents[0];
    if (content === undefined || !("text" in content)) {
      throw new Error("텍스트 resource가 필요합니다.");
    }
    expect(JSON.parse(content.text)).toMatchObject({ enabled: false });
  });
});
