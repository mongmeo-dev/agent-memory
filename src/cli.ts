#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import { resolveGitContext } from "./git-context.js";
import { CLIENT_NAMES, type ClientName, type SetupScope, setupClients } from "./setup.js";
import { MemoryStore } from "./store.js";
import { MEMORY_KINDS, type MemoryKind } from "./types.js";

const BOOLEAN_FLAGS = new Set(["dry-run"]);

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
  agents-memory record KIND SUMMARY... [--agent NAME] [--cwd PATH]
  agents-memory ingest TYPE CONTENT... [--agent NAME] [--cwd PATH]
  agents-memory search QUERY... [--branch NAME] [--limit N] [--cwd PATH]
  agents-memory get MEMORY_ID

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

function run(): void {
  const [command, ...rawArguments] = process.argv.slice(2);
  if (command === undefined || command === "help" || command === "--help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const { positional, flags } = parseArguments(rawArguments);
  const context = resolveGitContext(flags.get("cwd"));

  if (command === "context") {
    output(context);
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
    const results = setupClients({
      clients,
      scope: scope as SetupScope,
      nodePath: process.execPath,
      mcpPath: fileURLToPath(new URL("./mcp.js", import.meta.url)),
      ...(flags.has("database") ? { databasePath: flags.get("database") as string } : {}),
      dryRun: flags.has("dry-run"),
    });
    output(results);
    if (results.some((result) => result.status === "failed")) process.exitCode = 1;
    return;
  }

  const store = new MemoryStore();
  try {
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
      output(
        store.searchMemories({
          query: required(positional, "검색어가 필요합니다."),
          projectId: context.projectId,
          currentBranch: context.branch,
          ...(flags.has("branch") ? { requestedBranch: flags.get("branch") as string } : {}),
          ...(limit === undefined ? {} : { limit }),
        }),
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

    throw new Error(`알 수 없는 명령: ${command}\n${usage()}`);
  } finally {
    store.close();
  }
}

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
