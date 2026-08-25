import type { MemoryStore } from "./store.js";
import type { LifecycleEventType, Memory, MemoryKind, StoredEvent } from "./types.js";

const PROJECTABLE_TYPES = new Set<LifecycleEventType>([
  "prompt.submitted",
  "tool.completed",
  "tool.failed",
  "turn.completed",
]);

function compactContent(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 2_000);
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

export function projectLifecycleEvent(store: MemoryStore, event: StoredEvent): Memory | null {
  if (!PROJECTABLE_TYPES.has(event.type as LifecycleEventType)) return null;
  const summary = compactContent(event.content);
  if (summary.length < 4) return null;
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

  return store.recordMemory({
    kind,
    summary,
    agent: `projector:${event.agent}`,
    projectId: event.projectId,
    branch: event.branch,
    headCommit: event.headCommit,
    evidenceEventIds: [event.id],
  });
}
