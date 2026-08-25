import { createHash, randomUUID } from "node:crypto";

import { buildActiveContext, type ContextOptions } from "./context.js";
import { resolveGitContext } from "./git-context.js";
import { projectLifecycleEvent } from "./projector.js";
import { isExcludedPath } from "./redaction.js";
import { defaultSpoolPath, replaySpool, spoolEvent } from "./spool.js";
import { MemoryStore } from "./store.js";
import type { GitContext, LifecycleEventType } from "./types.js";

export type AdapterClient = "claude" | "codex" | "gjc";

export interface NormalizedEventV1 {
  id: string;
  type: LifecycleEventType;
  content: string;
  agent: AdapterClient;
  createdAt: string;
  cwd: string | undefined;
  sessionId: string | null;
  providerEvent: string;
}

export interface AdapterDependencies {
  store?: MemoryStore;
  resolveGitContext?: (cwd?: string) => GitContext;
  projectLifecycleEvent?: (
    store: MemoryStore,
    event: ReturnType<MemoryStore["ingestEvent"]>,
  ) => unknown;
  contextOptions?: ContextOptions;
}

const CLAUDE_TYPES: Record<string, LifecycleEventType> = {
  SessionStart: "session.started",
  UserPromptSubmit: "prompt.submitted",
  PostToolUse: "tool.completed",
  PostToolUseFailure: "tool.failed",
  Stop: "turn.completed",
  StopFailure: "turn.completed",
  SessionEnd: "session.ended",
  CwdChanged: "git.context.changed",
};

const CODEX_TYPES: Record<string, LifecycleEventType> = {
  SessionStart: "session.started",
  UserPromptSubmit: "prompt.submitted",
  PostToolUse: "tool.completed",
  Stop: "turn.completed",
  SessionEnd: "session.ended",
};

const GJC_TYPES: Record<string, LifecycleEventType> = {
  session_start: "session.started",
  tool_result: "tool.completed",
  session_shutdown: "session.ended",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validTimestamp(value: unknown): string {
  if (typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value)))
    return value;
  return new Date().toISOString();
}

function stableEventId(
  client: AdapterClient,
  eventName: string,
  details: Record<string, unknown>,
): string {
  const occurrenceId =
    text(details.event_id) ??
    text(details.hook_id) ??
    text(details.tool_use_id) ??
    text(details.tool_call_id) ??
    text(details.toolCallId) ??
    text(details.turn_id) ??
    text(details.prompt_id);
  const sessionId = text(details.session_id) ?? text(details.sessionId);
  const sessionScoped =
    occurrenceId ??
    (sessionId === undefined
      ? undefined
      : `${sessionId}\n${createHash("sha256").update(publicPayload(details)).digest("hex")}`);
  if (sessionScoped === undefined) return randomUUID();
  return `adapter:${createHash("sha256")
    .update(`${client}\n${eventName}\n${sessionScoped}`)
    .digest("hex")}`;
}

function publicPayload(payload: Record<string, unknown>): string {
  const allowed = [
    "session_id",
    "sessionId",
    "prompt",
    "message",
    "tool_name",
    "toolName",
    "tool_input",
    "toolInput",
    "tool_response",
    "toolResponse",
    "toolCallId",
    "input",
    "content",
    "details",
    "isError",
    "result",
    "error",
    "reason",
    "source",
    "status",
  ];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (payload[key] !== undefined) result[key] = payload[key];
  }
  return JSON.stringify(result);
}

function excludedFileContent(content: string, globs: readonly string[]): string {
  try {
    const payload = JSON.parse(content) as unknown;
    const paths: string[] = [];
    const visit = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        if (
          (key === "path" || key === "file_path" || key === "filePath") &&
          typeof item === "string"
        ) {
          paths.push(item);
        } else {
          visit(item);
        }
      }
    };
    visit(payload);
    const excluded = paths.find((path) => isExcludedPath(path, globs));
    return excluded === undefined
      ? content
      : JSON.stringify({ excluded: true, path: excluded, reason: "excluded_glob" });
  } catch {
    return content;
  }
}

function normalize(
  agent: AdapterClient,
  payload: unknown,
  types: Record<string, LifecycleEventType>,
  eventNames: string[],
): NormalizedEventV1 | null {
  if (!isRecord(payload)) return null;
  const nested = isRecord(payload.payload)
    ? payload.payload
    : isRecord(payload.data)
      ? payload.data
      : {};
  const details = { ...payload, ...nested };
  const name = eventNames.map((key) => text(details[key])).find((value) => value !== undefined);
  if (name === undefined) return null;
  let type = types[name];
  if (type === undefined) return null;
  if (agent === "gjc" && name === "tool_result") {
    const status = text(details.status);
    if (
      status === "failure" ||
      status === "failed" ||
      details.error !== undefined ||
      details.isError === true
    ) {
      type = "tool.failed";
    }
  }
  if (agent === "codex" && name === "PostToolUse") {
    const status = text(details.status);
    if (status === "failure" || status === "failed" || details.error !== undefined) {
      type = "tool.failed";
    }
  }
  return {
    id: stableEventId(agent, name, details),
    type,
    content: publicPayload(details),
    agent,
    createdAt: validTimestamp(
      details.timestamp ?? details.created_at ?? details.createdAt ?? details.time,
    ),
    cwd: text(details.cwd) ?? text(details.workspace) ?? text(details.project_dir),
    sessionId: text(details.session_id) ?? text(details.sessionId) ?? null,
    providerEvent: name,
  };
}

export function normalizeClaudeCodeHook(payload: unknown): NormalizedEventV1 | null {
  return normalize("claude", payload, CLAUDE_TYPES, ["hook_event_name", "event", "type"]);
}

export function normalizeCodexHook(payload: unknown): NormalizedEventV1 | null {
  return normalize("codex", payload, CODEX_TYPES, ["hook_event_name", "event", "type"]);
}

export function normalizeGjcCallback(payload: unknown): NormalizedEventV1 | null {
  return normalize("gjc", payload, GJC_TYPES, ["event", "event_name", "type", "name"]);
}

export function normalizeAdapterEvent(
  client: AdapterClient,
  payload: unknown,
): NormalizedEventV1 | null {
  if (client === "claude") return normalizeClaudeCodeHook(payload);
  if (client === "codex") return normalizeCodexHook(payload);
  return normalizeGjcCallback(payload);
}

/** Persists a hook event. All malformed input and collection failures are intentionally non-blocking. */
export function ingestAdapterPayload(
  client: AdapterClient,
  payload: unknown,
  dependencies: AdapterDependencies = {},
): string {
  const normalized = normalizeAdapterEvent(client, payload);
  if (normalized === null) return "";
  const resolveContext = dependencies.resolveGitContext ?? resolveGitContext;
  let git: GitContext | undefined;
  let store: MemoryStore | undefined;
  let safeContent = normalized.content;
  let customPatterns: string[] = [];
  const ownsStore = dependencies.store === undefined;
  try {
    git = resolveContext(normalized.cwd);
    store = dependencies.store ?? new MemoryStore();
    const settings = store.getCollectionSettings();
    customPatterns = settings.redactionPatterns;
    if (settings.paused) return "";
    if (ownsStore) replaySpool(store);
    safeContent = excludedFileContent(normalized.content, settings.excludedGlobs);
    const event = store.ingestEvent({
      id: normalized.id,
      type: normalized.type,
      content: safeContent,
      agent: normalized.agent,
      projectId: git.projectId,
      branch: git.branch,
      headCommit: git.headCommit,
      sessionId: normalized.sessionId,
      providerEvent: normalized.providerEvent,
      createdAt: normalized.createdAt,
      automatic: true,
    });
    const project = dependencies.projectLifecycleEvent ?? projectLifecycleEvent;
    project(store, event);
    const context =
      normalized.type === "session.started" || normalized.type === "prompt.submitted"
        ? buildActiveContext(store, git, dependencies.contextOptions)
        : "";
    return context;
  } catch {
    if (ownsStore && git !== undefined) {
      try {
        spoolEvent(
          {
            id: normalized.id,
            type: normalized.type,
            content: safeContent,
            agent: normalized.agent,
            projectId: git.projectId,
            branch: git.branch,
            headCommit: git.headCommit,
            sessionId: normalized.sessionId,
            providerEvent: normalized.providerEvent,
            createdAt: normalized.createdAt,
            automatic: true,
          },
          defaultSpoolPath(),
          customPatterns,
        );
      } catch {
        // Collection must never block the host client.
      }
    }
    return "";
  } finally {
    if (ownsStore) store?.close();
  }
}

export const handleAdapterPayload = ingestAdapterPayload;
