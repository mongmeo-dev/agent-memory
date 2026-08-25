import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { resolveCommitRelation } from "./git-context.js";
import type { Memory, MemoryValidity } from "./types.js";

/** Deterministically validates repository evidence without executing stored commands. */
export function evaluateMemoryValidity(
  memory: Memory,
  repositoryRoot: string,
  currentBranch: string | null,
  currentHeadCommit: string | null,
): MemoryValidity {
  const commitRelation = resolveCommitRelation(
    repositoryRoot,
    currentHeadCommit,
    memory.headCommit,
  );
  if (memory.branch !== null && memory.branch !== currentBranch && commitRelation === "diverged") {
    return "branch-only";
  }
  if (memory.evidence.some((item) => item.type === "test" && (item.exitCode ?? 0) !== 0)) {
    return "contradicted";
  }

  const fileEvidence = memory.evidence.filter(
    (item) =>
      (item.type === "file" || item.type === "symbol" || item.type === "diff") &&
      item.repositoryPath !== null,
  );
  if (fileEvidence.length === 0) {
    return memory.evidence.some(
      (item) => item.type === "commit" || item.type === "test" || item.type === "command",
    )
      ? "verified"
      : "unverified";
  }

  let contentChanged = false;
  for (const evidence of fileEvidence) {
    const repositoryPath = evidence.repositoryPath as string;
    const absolutePath = isAbsolute(repositoryPath)
      ? resolve(repositoryPath)
      : resolve(repositoryRoot, repositoryPath);
    const pathFromRoot = relative(repositoryRoot, absolutePath);
    if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot) || !existsSync(absolutePath)) {
      return "orphaned";
    }
    const content = readFileSync(absolutePath);
    if (evidence.symbol !== null && !content.toString("utf8").includes(evidence.symbol)) {
      return "orphaned";
    }
    if (
      evidence.contentHash !== null &&
      createHash("sha256").update(content).digest("hex") !== evidence.contentHash
    ) {
      contentChanged = true;
    }
  }
  return contentChanged ? "changed" : "verified";
}
