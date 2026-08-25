#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { setConfiguredDatabasePath } from "./config.js";
import { SystemCredentialStore } from "./credentials.js";
import { readDaemonToken } from "./daemon-auth.js";
import {
  hybridSearchMemories,
  indexProjectMemories,
  OpenAICompatibleEmbeddingProvider,
} from "./embeddings.js";
import { resolveGitContexts } from "./git-context.js";
import { buildVerifiedHandoff } from "./handoff.js";
import { CLIENT_NAMES, type ClientName, type SetupScope, setupClients } from "./setup.js";
import { installDaemonService } from "./setup-daemon.js";
import { MemoryStore } from "./store.js";
import { SyncClient, syncEndpointId, validateSyncBaseUrl } from "./sync.js";
import { MEMORY_KINDS, type MemoryKind } from "./types.js";
import { createManagementServer } from "./web.js";

const BOOLEAN_FLAGS = new Set(["allow-insecure-loopback", "dry-run"]);

interface ParsedArguments {
  positional: string[];
  flags: Map<string, string>;
}

function parseArguments(args: string[]): ParsedArguments {
  const positional: string[] = [];
  const flags = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === undefined) continue;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }

    const name = value.slice(2);
    const flagValue = args[index + 1];
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, "true");
      continue;
    }
    if (flagValue === undefined || flagValue.startsWith("--")) {
      throw new Error(`--${name} 옵션 값이 필요합니다.`);
    }
    flags.set(name, flagValue);
    index += 1;
  }

  return { positional, flags };
}

function usage(): string {
  return `사용법:
  agents-memory context [--cwd PATH]
  agents-memory setup [all|claude|codex|gjc] [--scope user|project]
                      [--database PATH] [--dry-run]
  agents-memory serve [--port N] [--token TOKEN]
  agents-memory record KIND SUMMARY... [--agent NAME] [--cwd PATH]
  agents-memory ingest TYPE CONTENT... [--agent NAME] [--cwd PATH]
  agents-memory search QUERY... [--branch NAME] [--limit N] [--cwd PATH]
  agents-memory revalidate [--cwd PATH]
  agents-memory handoff [--cwd PATH]
  agents-memory get MEMORY_ID
  agents-memory list [--kind KIND] [--status STATUS] [--branch NAME]
  agents-memory update MEMORY_ID [--summary TEXT] [--kind KIND] [--status STATUS]
  agents-memory delete MEMORY_ID
  agents-memory settings [show|pause|resume]
  agents-memory stats
  agents-memory export
  agents-memory embeddings [index|search QUERY...] --endpoint URL --model MODEL
  agents-memory sync [status|configure|run|disable]
                     [--url URL] [--remote-project ID] [--token TOKEN]

KIND: ${MEMORY_KINDS.join(", ")}`;
}

function required(values: string[], message: string): string {
  const value = values.join(" ").trim();
  if (value.length === 0) throw new Error(message);
  return value;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function run(): Promise<void> {
  const [command, ...rawArguments] = process.argv.slice(2);
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { positional, flags } = parseArguments(rawArguments);
  const contexts = resolveGitContexts(flags.get("cwd"));
  const context = contexts[0];
  if (context === undefined) throw new Error("Git context를 확인할 수 없습니다.");

  if (command === "context") {
    output({ ...context, repositories: contexts });
    return;
  }

  if (command === "setup") {
    const target = positional[0] ?? "all";
    if (
      positional.length > 1 ||
      (target !== "all" && !CLIENT_NAMES.includes(target as ClientName))
    ) {
      throw new Error("setup 대상은 all, claude, codex, gjc 중 하나여야 합니다.");
    }
    const scope = flags.get("scope") ?? "user";
    if (scope !== "user" && scope !== "project") {
      throw new Error("--scope는 user 또는 project여야 합니다.");
    }
    const clients = target === "all" ? [...CLIENT_NAMES] : [target as ClientName];
    if (flags.has("database") && !flags.has("dry-run")) {
      setConfiguredDatabasePath(flags.get("database") as string);
    }
    const daemon = installDaemonService({
      nodePath: process.execPath,
      daemonPath: fileURLToPath(new URL("./daemon.js", import.meta.url)),
      ...(flags.has("database") ? { databasePath: flags.get("database") as string } : {}),
      dryRun: flags.has("dry-run"),
    });
    const results = setupClients({
      clients,
      scope: scope as SetupScope,
      nodePath: process.execPath,
      mcpPath: fileURLToPath(new URL("./mcp.js", import.meta.url)),
      projectRoot: context.repositoryRoot,
      ...(flags.has("database") ? { databasePath: flags.get("database") as string } : {}),
      dryRun: flags.has("dry-run"),
    });
    output({ daemon, clients: results });
    if (daemon.status === "failed" || results.some((result) => result.status === "failed")) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "serve") {
    const rawPort = flags.get("port");
    const port = rawPort === undefined ? 3789 : Number.parseInt(rawPort, 10);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error("--port는 0부터 65535 사이의 정수여야 합니다.");
    }
    const daemonToken = flags.has("token") ? null : readDaemonToken();
    if (daemonToken !== null && port === 3789) {
      try {
        const health = await fetch("http://127.0.0.1:3789/api/health", {
          signal: AbortSignal.timeout(300),
        });
        if (health.ok) {
          output({
            url: `http://127.0.0.1:3789/#token=${encodeURIComponent(daemonToken)}`,
            host: "127.0.0.1",
            port: 3789,
            daemon: true,
          });
          return;
        }
      } catch {
        // Fall through and start an interactive server.
      }
    }
    const store = new MemoryStore();
    const server = createManagementServer(store, {
      port,
      ...(flags.has("token") ? { token: flags.get("token") as string } : {}),
    });
    await server.start();
    const address = server.address();
    if (address === null) throw new Error("관리 서버 주소를 확인할 수 없습니다.");
    output({
      url: `http://127.0.0.1:${address.port}/#token=${encodeURIComponent(server.token)}`,
      host: address.host,
      port: address.port,
    });
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await server.stop();
    store.close();
    return;
  }

  const store = new MemoryStore();
  try {
    if (command === "list") {
      const kind = flags.get("kind");
      if (kind !== undefined && !MEMORY_KINDS.includes(kind as MemoryKind)) {
        throw new Error(`올바른 KIND가 필요합니다: ${MEMORY_KINDS.join(", ")}`);
      }
      const status = flags.get("status");
      if (status !== undefined && !["active", "superseded", "resolved"].includes(status)) {
        throw new Error("--status는 active, superseded, resolved 중 하나여야 합니다.");
      }
      output(
        store.listMemories({
          projectId: context.projectId,
          ...(flags.has("branch") ? { branch: flags.get("branch") as string } : {}),
          ...(kind === undefined ? {} : { kind: kind as MemoryKind }),
          ...(status === undefined
            ? {}
            : { status: status as "active" | "superseded" | "resolved" }),
        }),
      );
      return;
    }

    if (command === "record") {
      const [kindValue, ...summaryParts] = positional;
      if (!MEMORY_KINDS.includes(kindValue as MemoryKind)) {
        throw new Error(`올바른 KIND가 필요합니다: ${MEMORY_KINDS.join(", ")}`);
      }
      output(
        store.recordMemory({
          kind: kindValue as MemoryKind,
          summary: required(summaryParts, "기억할 내용이 필요합니다."),
          agent: flags.get("agent") ?? "cli",
          projectId: context.projectId,
          branch: context.branch,
          headCommit: context.headCommit,
        }),
      );
      return;
    }

    if (command === "ingest") {
      const [type, ...contentParts] = positional;
      if (type === undefined) throw new Error("이벤트 TYPE이 필요합니다.");
      output(
        store.ingestEvent({
          type,
          content: required(contentParts, "이벤트 내용이 필요합니다."),
          agent: flags.get("agent") ?? "cli",
          projectId: context.projectId,
          branch: context.branch,
          headCommit: context.headCommit,
        }),
      );
      return;
    }

    if (command === "search") {
      const rawLimit = flags.get("limit");
      const limit = rawLimit === undefined ? undefined : Number.parseInt(rawLimit, 10);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new Error("--limit은 1 이상의 정수여야 합니다.");
      }
      const query = required(positional, "검색어가 필요합니다.");
      const resultLimit = limit ?? 20;
      output(
        contexts
          .flatMap((repository) =>
            store.searchMemories({
              query,
              projectId: repository.projectId,
              currentBranch: repository.branch,
              repositoryRoot: repository.repositoryRoot,
              currentHeadCommit: repository.headCommit,
              ...(flags.has("branch") ? { requestedBranch: flags.get("branch") as string } : {}),
              limit: resultLimit,
            }),
          )
          .sort((left, right) => right.rank - left.rank)
          .slice(0, resultLimit),
      );
      return;
    }

    if (command === "revalidate") {
      output(
        contexts.map((repository) => ({
          repositoryRoot: repository.repositoryRoot,
          ...store.revalidateProject(
            repository.projectId,
            repository.repositoryRoot,
            repository.branch,
            repository.headCommit,
          ),
        })),
      );
      return;
    }

    if (command === "handoff") {
      process.stdout.write(
        `${contexts.map((repository) => buildVerifiedHandoff(store, repository)).join("\n\n")}\n`,
      );
      return;
    }

    if (command === "get") {
      const id = required(positional, "MEMORY_ID가 필요합니다.");
      const memory = store.getMemory(id);
      if (memory === null) throw new Error(`기억을 찾을 수 없습니다: ${id}`);
      output(memory);
      return;
    }

    if (command === "update") {
      const id = required(positional, "MEMORY_ID가 필요합니다.");
      const kind = flags.get("kind");
      if (kind !== undefined && !MEMORY_KINDS.includes(kind as MemoryKind)) {
        throw new Error(`올바른 KIND가 필요합니다: ${MEMORY_KINDS.join(", ")}`);
      }
      const status = flags.get("status");
      if (status !== undefined && !["active", "superseded", "resolved"].includes(status)) {
        throw new Error("--status는 active, superseded, resolved 중 하나여야 합니다.");
      }
      const memory = store.updateMemory(id, {
        ...(flags.has("summary") ? { summary: flags.get("summary") as string } : {}),
        ...(kind === undefined ? {} : { kind: kind as MemoryKind }),
        ...(status === undefined ? {} : { status: status as "active" | "superseded" | "resolved" }),
      });
      if (memory === null) throw new Error(`기억을 찾을 수 없습니다: ${id}`);
      output(memory);
      return;
    }

    if (command === "delete") {
      const id = required(positional, "MEMORY_ID가 필요합니다.");
      if (!store.deleteMemory(id)) throw new Error(`기억을 찾을 수 없습니다: ${id}`);
      output({ deleted: true, id });
      return;
    }

    if (command === "settings") {
      const action = positional[0] ?? "show";
      const settings = store.getCollectionSettings();
      if (action === "show") output(settings);
      else if (action === "pause")
        output(store.setCollectionSettings({ ...settings, paused: true }));
      else if (action === "resume") {
        output(store.setCollectionSettings({ ...settings, paused: false }));
      } else throw new Error("settings 동작은 show, pause, resume 중 하나여야 합니다.");
      return;
    }

    if (command === "stats") {
      output(store.getStats());
      return;
    }

    if (command === "export") {
      output(store.exportBundle());
      return;
    }

    if (command === "embeddings") {
      const [action = "index", ...queryParts] = positional;
      const endpoint = flags.get("endpoint") ?? process.env.AGENTS_MEMORY_EMBEDDING_ENDPOINT;
      const model = flags.get("model") ?? process.env.AGENTS_MEMORY_EMBEDDING_MODEL;
      if (endpoint === undefined || model === undefined) {
        throw new Error("--endpoint와 --model 또는 대응하는 embedding 환경 변수가 필요합니다.");
      }
      const provider = new OpenAICompatibleEmbeddingProvider({
        endpoint,
        model,
        ...(process.env.AGENTS_MEMORY_EMBEDDING_API_KEY === undefined
          ? {}
          : { apiKey: process.env.AGENTS_MEMORY_EMBEDDING_API_KEY }),
      });
      if (action === "index") {
        output(await indexProjectMemories(store, context.projectId, provider));
      } else if (action === "search") {
        output(
          await hybridSearchMemories(
            store,
            {
              query: required(queryParts, "검색어가 필요합니다."),
              projectId: context.projectId,
              currentBranch: context.branch,
              repositoryRoot: context.repositoryRoot,
              currentHeadCommit: context.headCommit,
              ...(flags.has("branch") ? { requestedBranch: flags.get("branch") as string } : {}),
            },
            provider,
          ),
        );
      } else throw new Error("embeddings 동작은 index 또는 search여야 합니다.");
      return;
    }

    if (command === "sync") {
      const action = positional[0] ?? "status";
      const credentials = new SystemCredentialStore();
      const current = store.getSyncSettings(context.projectId);
      if (action === "status") {
        output({
          ...current,
          credentialAvailable:
            current.endpointId !== null && credentials.get(current.endpointId) !== null,
        });
        return;
      }
      if (action === "configure") {
        const baseUrl = flags.get("url");
        const remoteProjectId = flags.get("remote-project");
        const token = flags.get("token") ?? process.env.AGENTS_MEMORY_SYNC_TOKEN;
        if (baseUrl === undefined || remoteProjectId === undefined || token === undefined) {
          throw new Error(
            "configure에는 --url, --remote-project와 --token 또는 AGENTS_MEMORY_SYNC_TOKEN이 필요합니다.",
          );
        }
        const allowInsecureLoopback = flags.has("allow-insecure-loopback");
        validateSyncBaseUrl(baseUrl, allowInsecureLoopback);
        const endpointId = syncEndpointId(baseUrl);
        credentials.set(endpointId, token);
        if (
          !current.enabled ||
          current.endpointId !== endpointId ||
          current.remoteProjectId !== remoteProjectId
        ) {
          store.bootstrapOutbox(context.projectId);
        }
        output(
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
        return;
      }
      if (action === "disable") {
        if (current.endpointId !== null) credentials.delete(current.endpointId);
        output(
          store.setSyncSettings(context.projectId, {
            ...current,
            enabled: false,
            endpointId: null,
            lastError: null,
          }),
        );
        return;
      }
      if (action !== "run")
        throw new Error("sync 동작은 status, configure, run, disable 중 하나여야 합니다.");
      if (
        !current.enabled ||
        current.baseUrl === null ||
        current.remoteProjectId === null ||
        current.endpointId === null
      ) {
        throw new Error("먼저 sync configure로 프로젝트 동기화를 활성화하세요.");
      }
      const token = credentials.get(current.endpointId);
      if (token === null) throw new Error("OS keychain에서 동기화 자격증명을 찾을 수 없습니다.");
      const client = new SyncClient(store, {
        baseUrl: current.baseUrl,
        token,
        remoteProjectId: current.remoteProjectId,
        localProjectId: context.projectId,
        allowInsecureLoopback: current.allowInsecureLoopback,
      });
      try {
        const result = await client.syncOnce();
        store.setSyncSettings(context.projectId, {
          ...current,
          lastSyncedAt: new Date().toISOString(),
          lastError: null,
        });
        output(result);
      } catch (error) {
        store.setSyncSettings(context.projectId, {
          ...current,
          lastError: error instanceof Error ? error.message.slice(0, 500) : "동기화 실패",
        });
        throw error;
      }
      return;
    }

    throw new Error(`알 수 없는 명령: ${command}\n${usage()}`);
  } finally {
    store.close();
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
