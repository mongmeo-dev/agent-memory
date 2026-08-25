#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import { resolveGitContext } from "./git-context.js";
import { MemoryStore } from "./store.js";
import { MEMORY_KINDS } from "./types.js";

function jsonContent(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export function createMemoryServer(store: MemoryStore): McpServer {
  const server = new McpServer({ name: "agents-memory", version: "0.1.0" });

  server.registerTool(
    "memory.ingest",
    {
      description: "민감정보를 제거한 프로젝트 작업 이벤트를 로컬 저장소에 기록합니다.",
      inputSchema: z.object({
        type: z.string().min(1),
        content: z.string().min(1),
        agent: z.string().min(1),
        cwd: z.string().optional(),
        eventId: z.string().optional(),
        createdAt: z.iso.datetime().optional(),
      }),
    },
    ({ type, content, agent, cwd, eventId, createdAt }) => {
      const context = resolveGitContext(cwd);
      return jsonContent(
        store.ingestEvent({
          ...(eventId === undefined ? {} : { id: eventId }),
          type,
          content,
          agent,
          projectId: context.projectId,
          branch: context.branch,
          headCommit: context.headCommit,
          ...(createdAt === undefined ? {} : { createdAt }),
        }),
      );
    },
  );

  server.registerTool(
    "memory.record",
    {
      description:
        "프로젝트의 목표, 결정, 변경, 문제, 해결책 또는 할 일을 장기 기억으로 기록합니다.",
      inputSchema: z.object({
        kind: z.enum(MEMORY_KINDS),
        summary: z.string().min(1),
        agent: z.string().min(1),
        cwd: z.string().optional(),
      }),
    },
    ({ kind, summary, agent, cwd }) => {
      const context = resolveGitContext(cwd);
      return jsonContent(
        store.recordMemory({
          kind,
          summary,
          agent,
          projectId: context.projectId,
          branch: context.branch,
          headCommit: context.headCommit,
        }),
      );
    },
  );

  server.registerTool(
    "memory.search",
    {
      description: "현재 프로젝트와 다른 브랜치를 포함해 관련 장기 기억을 검색합니다.",
      inputSchema: z.object({
        query: z.string().min(1),
        cwd: z.string().optional(),
        branch: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
    ({ query, cwd, branch, limit }) => {
      const context = resolveGitContext(cwd);
      return jsonContent(
        store.searchMemories({
          query,
          projectId: context.projectId,
          currentBranch: context.branch,
          ...(branch === undefined ? {} : { requestedBranch: branch }),
          ...(limit === undefined ? {} : { limit }),
        }),
      );
    },
  );

  server.registerTool(
    "memory.get",
    {
      description: "ID로 장기 기억과 근거 이벤트 ID를 조회합니다.",
      inputSchema: z.object({ id: z.string().uuid() }),
    },
    ({ id }) => jsonContent(store.getMemory(id)),
  );

  return server;
}

async function main(): Promise<void> {
  const store = new MemoryStore();
  const server = createMemoryServer(store);
  const close = (): void => {
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await server.connect(new StdioServerTransport());
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
