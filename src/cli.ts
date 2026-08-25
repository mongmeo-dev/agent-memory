#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import {
  autoUseStatus,
  configuredAutoUse,
  configuredEmbedding,
  setConfiguredAutoUse,
  setConfiguredDatabasePath,
  setConfiguredEmbedding,
  setConfiguredProjectAutoUse,
} from "./config.js";
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
      throw new Error(`--${name} requires a value.`);
    }
    flags.set(name, flagValue);
    index += 1;
  }

  return { positional, flags };
}

function usage(): string {
  return `Usage:
  agents-memory context [--cwd PATH]
  agents-memory project [status|use|ignore|default] [--cwd PATH]
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
  agents-memory settings auto-use [show|on|off]
  agents-memory stats
  agents-memory export
  agents-memory embeddings [show|configure|disable|index|search QUERY...]
                           [--endpoint URL] [--model MODEL]
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
  if (context === undefined) throw new Error("Unable to resolve the Git context.");

  if (command === "context") {
    output({ ...context, repositories: contexts });
    return;
  }

  if (command === "project") {
    const action = positional[0] ?? "status";
    if (positional.length > 1) throw new Error("Specify only one project action.");
    if (action === "use") setConfiguredProjectAutoUse(context.projectId, true);
    else if (action === "ignore") setConfiguredProjectAutoUse(context.projectId, false);
    else if (action === "default") setConfiguredProjectAutoUse(context.projectId, null);
    else if (action !== "status") {
      throw new Error("Project action must be status, use, ignore, or default.");
    }
    output({
      projectId: context.projectId,
      repositoryRoot: context.repositoryRoot,
      ...autoUseStatus(context.projectId),
    });
    return;
  }

  if (command === "settings" && positional[0] === "auto-use") {
    const action = positional[1] ?? "show";
    if (positional.length > 2) {
      throw new Error("Specify only one settings auto-use action.");
    }
    if (action === "on") setConfiguredAutoUse(true);
    else if (action === "off") setConfiguredAutoUse(false);
    else if (action !== "show") {
      throw new Error("Settings auto-use action must be show, on, or off.");
    }
    output({ autoUse: configuredAutoUse() });
    return;
  }

  if (command === "setup") {
    const target = positional[0] ?? "all";
    if (
      positional.length > 1 ||
      (target !== "all" && !CLIENT_NAMES.includes(target as ClientName))
    ) {
      throw new Error("Setup target must be all, claude, codex, or gjc.");
    }
    const scope = flags.get("scope") ?? "user";
    if (scope !== "user" && scope !== "project") {
      throw new Error("--scope must be user or project.");
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
      throw new Error("--port must be an integer from 0 through 65535.");
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
    if (address === null) throw new Error("Unable to resolve the management server address.");
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
        throw new Error(`KIND must be one of: ${MEMORY_KINDS.join(", ")}`);
      }
      const status = flags.get("status");
      if (status !== undefined && !["active", "superseded", "resolved"].includes(status)) {
        throw new Error("--status must be active, superseded, or resolved.");
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
        throw new Error(`KIND must be one of: ${MEMORY_KINDS.join(", ")}`);
      }
      output(
        store.recordMemory({
          kind: kindValue as MemoryKind,
          summary: required(summaryParts, "A memory summary is required."),
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
      if (type === undefined) throw new Error("An event TYPE is required.");
      output(
        store.ingestEvent({
          type,
          content: required(contentParts, "Event content is required."),
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
        throw new Error("--limit must be an integer greater than or equal to 1.");
      }
      const query = required(positional, "A search query is required.");
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
      const id = required(positional, "MEMORY_ID is required.");
      const memory = store.getMemory(id);
      if (memory === null) throw new Error(`Memory not found: ${id}`);
      output(memory);
      return;
    }

    if (command === "update") {
      const id = required(positional, "MEMORY_ID is required.");
      const kind = flags.get("kind");
      if (kind !== undefined && !MEMORY_KINDS.includes(kind as MemoryKind)) {
        throw new Error(`KIND must be one of: ${MEMORY_KINDS.join(", ")}`);
      }
      const status = flags.get("status");
      if (status !== undefined && !["active", "superseded", "resolved"].includes(status)) {
        throw new Error("--status must be active, superseded, or resolved.");
      }
      const memory = store.updateMemory(id, {
        ...(flags.has("summary") ? { summary: flags.get("summary") as string } : {}),
        ...(kind === undefined ? {} : { kind: kind as MemoryKind }),
        ...(status === undefined ? {} : { status: status as "active" | "superseded" | "resolved" }),
      });
      if (memory === null) throw new Error(`Memory not found: ${id}`);
      output(memory);
      return;
    }

    if (command === "delete") {
      const id = required(positional, "MEMORY_ID is required.");
      if (!store.deleteMemory(id)) throw new Error(`Memory not found: ${id}`);
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
      } else throw new Error("Settings action must be show, pause, or resume.");
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
      const saved = configuredEmbedding();
      if (action === "show") {
        output({
          saved,
          effective:
            (process.env.AGENTS_MEMORY_EMBEDDING_ENDPOINT ?? saved?.endpoint) === undefined ||
            (process.env.AGENTS_MEMORY_EMBEDDING_MODEL ?? saved?.model) === undefined
              ? null
              : {
                  endpoint: process.env.AGENTS_MEMORY_EMBEDDING_ENDPOINT ?? saved?.endpoint,
                  model: process.env.AGENTS_MEMORY_EMBEDDING_MODEL ?? saved?.model,
                  source:
                    process.env.AGENTS_MEMORY_EMBEDDING_ENDPOINT !== undefined ||
                    process.env.AGENTS_MEMORY_EMBEDDING_MODEL !== undefined
                      ? "environment"
                      : "configuration",
                },
        });
        return;
      }
      if (action === "configure") {
        const endpoint = flags.get("endpoint");
        const model = flags.get("model");
        if (endpoint === undefined || model === undefined) {
          throw new Error("embeddings configure requires --endpoint and --model.");
        }
        setConfiguredEmbedding({ endpoint, model });
        output(configuredEmbedding());
        return;
      }
      if (action === "disable") {
        setConfiguredEmbedding(null);
        output({ configured: false });
        return;
      }
      const endpoint =
        flags.get("endpoint") ?? process.env.AGENTS_MEMORY_EMBEDDING_ENDPOINT ?? saved?.endpoint;
      const model = flags.get("model") ?? process.env.AGENTS_MEMORY_EMBEDDING_MODEL ?? saved?.model;
      if (endpoint === undefined || model === undefined) {
        throw new Error(
          "Provide --endpoint and --model, embedding environment variables, or saved configuration.",
        );
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
              query: required(queryParts, "A search query is required."),
              projectId: context.projectId,
              currentBranch: context.branch,
              repositoryRoot: context.repositoryRoot,
              currentHeadCommit: context.headCommit,
              ...(flags.has("branch") ? { requestedBranch: flags.get("branch") as string } : {}),
            },
            provider,
          ),
        );
      } else {
        throw new Error("Embeddings action must be show, configure, disable, index, or search.");
      }
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
            "configure requires --url, --remote-project, and either --token or AGENTS_MEMORY_SYNC_TOKEN.",
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
        throw new Error("Sync action must be status, configure, run, or disable.");
      if (
        !current.enabled ||
        current.baseUrl === null ||
        current.remoteProjectId === null ||
        current.endpointId === null
      ) {
        throw new Error("Enable project synchronization with sync configure first.");
      }
      const token = credentials.get(current.endpointId);
      if (token === null) {
        throw new Error("Synchronization credentials were not found in the OS keychain.");
      }
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
          lastError:
            error instanceof Error ? error.message.slice(0, 500) : "Synchronization failed",
        });
        throw error;
      }
      return;
    }

    throw new Error(`Unknown command: ${command}\n${usage()}`);
  } finally {
    store.close();
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
