import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { MemoryStore } from "./store.js";
import type {
  LifecycleEventType,
  Memory,
  MemoryKind,
  RecordMemoryEvidenceInput,
  StoredEvent,
} from "./types.js";

const PROJECTABLE_TYPES = new Set<LifecycleEventType>([
  "prompt.submitted",
  "tool.completed",
  "tool.failed",
  "turn.completed",
]);
const MUTATING_TOOLS = /\b(write|edit|patch|apply|deploy|create|delete|rename|move|upload)\b/iu;
const DURABLE_SIGNAL =
  /\b(todo|next|remaining|decid(?:e|ed|ing)|decision|constraint|must|never|required|fix(?:ed)?|resolve[ds]?|solution|implemented|changed|created|deleted|renamed|test(?:s|ed)?|build|deploy|남은|해야|할 일|결정|채택|제약|반드시|금지|해결|수정 완료|구현|변경|생성|삭제|테스트|빌드|배포)\b/iu;
const TEST_COMMAND =
  /\b(test|vitest|jest|pytest|cargo test|go test|rspec|mvn test|gradle test)\b/iu;

function compactContent(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 2_000);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parsePayload(content: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(content)) ?? {};
  } catch {
    return {};
  }
}

function meaningfulText(payload: Record<string, unknown>, fallback: string): string {
  const keys = [
    "prompt",
    "message",
    "result",
    "error",
    "reason",
    "tool_response",
    "toolResponse",
    "content",
    "details",
  ];
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length >= 4) return compactContent(value);
  }
  return compactContent(fallback);
}

function inferKind(event: StoredEvent, content: string): MemoryKind {
  if (/\b(todo|next|remaining|남은|해야|할 일)\b/iu.test(content)) return "todo";
  if (/\b(decid(?:e|ed|ing)|decision|결정|채택)\b/iu.test(content)) return "decision";
  if (/\b(constraint|must|never|required|제약|반드시|금지)\b/iu.test(content)) {
    return "constraint";
  }
  if (/\b(fix(?:ed)?|resolve[ds]?|solution|해결|수정 완료)\b/iu.test(content)) return "solution";
  if (event.type === "prompt.submitted") return "goal";
  if (event.type === "tool.failed") return "problem";
  if (event.type === "tool.completed") return "change";
  return "fact";
}

function commandFrom(payload: Record<string, unknown>): string | null {
  const direct = payload.command;
  if (typeof direct === "string") return direct;
  for (const key of ["tool_input", "toolInput", "input"]) {
    const nested = asRecord(payload[key]);
    if (typeof nested?.command === "string") return nested.command;
  }
  return null;
}

function exitCodeFrom(payload: Record<string, unknown>): number | null {
  for (const key of ["exit_code", "exitCode", "code"]) {
    if (typeof payload[key] === "number") return payload[key];
  }
  for (const key of ["tool_response", "toolResponse", "result"]) {
    const nested = asRecord(payload[key]);
    if (nested !== null) {
      const exitCode = exitCodeFrom(nested);
      if (exitCode !== null) return exitCode;
    }
  }
  return null;
}

function collectPaths(value: unknown, paths: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, paths);
    return;
  }
  const record = asRecord(value);
  if (record === null) return;
  for (const [key, item] of Object.entries(record)) {
    if (/^(path|file|file_path|filePath|source|target)$/u.test(key) && typeof item === "string") {
      paths.add(item);
    } else {
      collectPaths(item, paths);
    }
  }
}

function repositoryEvidence(
  event: StoredEvent,
  payload: Record<string, unknown>,
  repositoryRoot?: string,
): RecordMemoryEvidenceInput[] {
  const evidence: RecordMemoryEvidenceInput[] = [];
  if (event.headCommit !== null) {
    evidence.push({ type: "commit", commitSha: event.headCommit });
  }
  const command = commandFrom(payload);
  if (command !== null) {
    evidence.push({
      type: TEST_COMMAND.test(command) ? "test" : "command",
      command,
      exitCode: exitCodeFrom(payload) ?? (event.type === "tool.failed" ? 1 : 0),
      commitSha: event.headCommit,
    });
  }
  if (repositoryRoot === undefined) return evidence;

  const paths = new Set<string>();
  collectPaths(payload, paths);
  for (const candidate of paths) {
    const absolutePath = isAbsolute(candidate)
      ? resolve(candidate)
      : resolve(repositoryRoot, candidate);
    const pathFromRoot = relative(repositoryRoot, absolutePath);
    if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot) || !existsSync(absolutePath)) {
      continue;
    }
    let content: Buffer;
    try {
      content = readFileSync(absolutePath);
    } catch {
      continue;
    }
    evidence.push({
      type: "file",
      repositoryPath: pathFromRoot,
      commitSha: event.headCommit,
      contentHash: createHash("sha256").update(content).digest("hex"),
    });
  }
  return evidence;
}

function shouldProject(
  event: StoredEvent,
  payload: Record<string, unknown>,
  summary: string,
): boolean {
  if (event.type === "tool.failed") return true;
  if (event.type === "prompt.submitted") return summary.length >= 8;
  const toolName =
    typeof payload.tool_name === "string"
      ? payload.tool_name
      : typeof payload.toolName === "string"
        ? payload.toolName
        : "";
  if (event.type === "tool.completed") {
    return MUTATING_TOOLS.test(toolName) || DURABLE_SIGNAL.test(summary);
  }
  return DURABLE_SIGNAL.test(summary);
}

export function projectLifecycleEvent(
  store: MemoryStore,
  event: StoredEvent,
  repositoryRoot?: string,
): Memory | null {
  if (!PROJECTABLE_TYPES.has(event.type as LifecycleEventType)) return null;
  const payload = parsePayload(event.content);
  const summary = meaningfulText(payload, event.content);
  if (summary.length < 4 || !shouldProject(event, payload, summary)) return null;
  const kind = inferKind(event, summary);
  const duplicate = store
    .listMemories({
      projectId: event.projectId,
      branch: event.branch,
      kind,
      status: "active",
      limit: 200,
    })
    .find((memory) => memory.summary === summary);
  if (duplicate !== undefined) return duplicate;

  const evidence = repositoryEvidence(event, payload, repositoryRoot);
  const repositoryBacked = evidence.some((item) => item.type !== "commit");
  const contradicted = evidence.some((item) => item.type === "test" && (item.exitCode ?? 0) !== 0);
  return store.recordMemory({
    kind,
    summary,
    agent: `projector:${event.agent}`,
    projectId: event.projectId,
    branch: event.branch,
    headCommit: event.headCommit,
    evidenceEventIds: [event.id],
    evidence,
    sourceType: repositoryBacked ? "repository" : "inferred",
    confidence: repositoryBacked ? 0.85 : event.type === "tool.failed" ? 0.75 : 0.6,
    validity: contradicted ? "contradicted" : repositoryBacked ? "verified" : "unverified",
  });
}
