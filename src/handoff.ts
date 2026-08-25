import type { MemoryStore } from "./store.js";
import type { GitContext, Memory } from "./types.js";

function line(memory: Memory): string {
  const evidence = memory.evidence
    .map((item) => item.repositoryPath ?? item.command ?? item.commitSha ?? item.type)
    .filter((item, index, values) => values.indexOf(item) === index)
    .slice(0, 3)
    .join(", ");
  return `- [${memory.validity}] ${memory.summary}${evidence.length > 0 ? ` (${evidence})` : ""}`;
}

function section(title: string, memories: Memory[]): string[] {
  return [title, ...(memories.length === 0 ? ["- 없음"] : memories.map(line))];
}

/** Builds a deterministic handoff from durable memories and repository evidence. */
export function buildVerifiedHandoff(store: MemoryStore, git: GitContext): string {
  store.revalidateProject(git.projectId, git.repositoryRoot, git.branch, git.headCommit);
  const memories = store
    .listMemories({ projectId: git.projectId, status: "active", limit: 200 })
    .filter((memory) => memory.validity !== "contradicted" && memory.validity !== "orphaned");
  const goals = memories.filter((memory) => memory.kind === "goal");
  const changes = memories.filter(
    (memory) =>
      (memory.kind === "change" || memory.kind === "decision" || memory.kind === "solution") &&
      memory.validity === "verified",
  );
  const validation = memories.filter((memory) =>
    memory.evidence.some((item) => item.type === "test" || item.type === "command"),
  );
  const unresolved = memories.filter(
    (memory) =>
      memory.kind === "todo" ||
      memory.kind === "problem" ||
      memory.validity === "changed" ||
      memory.validity === "unverified",
  );
  const branchOnly = memories.filter((memory) => memory.validity === "branch-only");

  return [
    "# Verified handoff",
    "",
    `Branch: ${git.branch ?? "(detached)"}`,
    `HEAD: ${git.headCommit ?? "(none)"}`,
    "",
    ...section("## Goals", goals),
    "",
    ...section("## Verified changes and decisions", changes),
    "",
    ...section("## Validation evidence", validation),
    "",
    ...section("## Unresolved or changed", unresolved),
    "",
    ...section("## Other branch work", branchOnly),
  ].join("\n");
}
