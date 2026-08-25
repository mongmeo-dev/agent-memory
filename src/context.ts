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
    `<memory id="${escapeXml(memory.id)}" kind="${escapeXml(memory.kind)}">`,
    `branch: ${escapeXml(memory.branch ?? "(none)")}`,
    `commit: ${escapeXml(memory.headCommit ?? "(none)")}`,
    `evidence: ${escapeXml(memory.evidenceEventIds.join(", ") || "(none)")}`,
    escapeXml(memory.summary),
    "</memory>",
  ].join("\n");
}

/** Builds a bounded, explicitly untrusted context from active project memories only. */
export function buildActiveContext(
  store: MemoryStore,
  git: GitContext,
  options: ContextOptions = {},
): string {
  const maxItems = Math.max(0, Math.floor(options.maxItems ?? DEFAULT_MAX_ITEMS));
  const maxCharacters = Math.max(0, Math.floor(options.maxCharacters ?? DEFAULT_MAX_CHARACTERS));
  const overhead = OPEN_DELIMITER.length + CLOSE_DELIMITER.length + 2;
  if (maxItems === 0 || maxCharacters < overhead) return "";

  const memories = store
    .listMemories({ projectId: git.projectId, status: "active", limit: Math.min(maxItems, 200) })
    .sort((left, right) => {
      const leftCurrent = left.branch === git.branch ? 0 : 1;
      const rightCurrent = right.branch === git.branch ? 0 : 1;
      return leftCurrent - rightCurrent || right.updatedAt.localeCompare(left.updatedAt);
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

export const buildMemoryContext = buildActiveContext;
