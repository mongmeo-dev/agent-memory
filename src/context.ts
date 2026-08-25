import type { MemoryStore } from "./store.js";
import type { GitContext, Memory } from "./types.js";

export interface ContextOptions {
  maxItems?: number;
  maxCharacters?: number;
}

const DEFAULT_MAX_ITEMS = 20;
const DEFAULT_MAX_CHARACTERS = 8_000;
const OPEN_DELIMITER = '<agents-memory-context trust="untrusted">';
const CLOSE_DELIMITER = "</agents-memory-context>";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatMemory(memory: Memory): string {
  return [
    `<memory id="${escapeXml(memory.id)}" kind="${escapeXml(memory.kind)}" validity="${escapeXml(memory.validity)}" confidence="${memory.confidence.toFixed(2)}">`,
    `branch: ${escapeXml(memory.branch ?? "(none)")}`,
    `commit: ${escapeXml(memory.headCommit ?? "(none)")}`,
    `evidence: ${escapeXml(memory.evidenceEventIds.join(", ") || "(none)")}`,
    `repository_evidence: ${escapeXml(
      memory.evidence
        .map((item) => item.repositoryPath ?? item.command ?? item.commitSha ?? item.type)
        .join(", ") || "(none)",
    )}`,
    escapeXml(memory.summary),
    "</memory>",
  ].join("\n");
}

/** Builds a bounded, explicitly untrusted context from active workspace memories only. */
export function buildWorkspaceActiveContext(
  store: MemoryStore,
  contexts: GitContext[],
  options: ContextOptions = {},
): string {
  const maxItems = Math.max(0, Math.floor(options.maxItems ?? DEFAULT_MAX_ITEMS));
  const maxCharacters = Math.max(0, Math.floor(options.maxCharacters ?? DEFAULT_MAX_CHARACTERS));
  const overhead = OPEN_DELIMITER.length + CLOSE_DELIMITER.length + 2;
  if (maxItems === 0 || maxCharacters < overhead) return "";

  const branches = new Map(contexts.map((context) => [context.projectId, context.branch]));
  const memories = contexts
    .flatMap((context) =>
      store.listMemories({
        projectId: context.projectId,
        status: "active",
        limit: Math.min(maxItems, 200),
      }),
    )
    .filter((memory) => memory.validity !== "contradicted" && memory.validity !== "orphaned")
    .sort((left, right) => {
      const validityOrder = {
        verified: 0,
        changed: 1,
        unverified: 2,
        "branch-only": 3,
        contradicted: 4,
        orphaned: 5,
      } as const;
      const validityDifference = validityOrder[left.validity] - validityOrder[right.validity];
      const leftCurrent = left.branch === branches.get(left.projectId) ? 0 : 1;
      const rightCurrent = right.branch === branches.get(right.projectId) ? 0 : 1;
      return (
        validityDifference ||
        leftCurrent - rightCurrent ||
        right.updatedAt.localeCompare(left.updatedAt)
      );
    });

  const entries: string[] = [];
  for (const memory of memories) {
    const entry = formatMemory(memory);
    const candidate = [OPEN_DELIMITER, ...entries, entry, CLOSE_DELIMITER].join("\n");
    if (candidate.length > maxCharacters) break;
    entries.push(entry);
  }
  return entries.length === 0 ? "" : [OPEN_DELIMITER, ...entries, CLOSE_DELIMITER].join("\n");
}

export function buildActiveContext(
  store: MemoryStore,
  git: GitContext,
  options: ContextOptions = {},
): string {
  return buildWorkspaceActiveContext(store, [git], options);
}

export const buildMemoryContext = buildActiveContext;
