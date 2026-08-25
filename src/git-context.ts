import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { type Dirent, existsSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import type { GitContext } from "./types.js";

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function normalizeRemote(remote: string): string {
  const trimmed = remote.trim().replace(/\.git$/, "");

  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/^[^@]+@([^:]+):/, "$1/");
  }
}

function hashIdentity(parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

const NESTED_REPOSITORY_SCAN_DEPTH = 4;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".cache",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
]);

function nestedRepositoryRoots(root: string): string[] {
  const repositories: string[] = [];
  const visited = new Set<string>([realpathSync(root)]);

  function visit(directory: string, depth: number): void {
    if (depth >= NESTED_REPOSITORY_SCAN_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const child = join(directory, entry.name);
      let canonical: string;
      try {
        canonical = realpathSync(child);
      } catch {
        continue;
      }
      if (visited.has(canonical)) continue;
      visited.add(canonical);
      if (existsSync(join(canonical, ".git"))) {
        repositories.push(canonical);
      }
      visit(canonical, depth + 1);
    }
  }

  visit(root, 0);
  return repositories.sort();
}

export function resolveGitContext(cwd = process.cwd()): GitContext {
  const requestedPath = realpathSync(resolve(cwd));
  const repositoryRoot = git(requestedPath, ["rev-parse", "--show-toplevel"]);

  if (repositoryRoot === null) {
    return {
      projectId: hashIdentity(["path", requestedPath]),
      repositoryRoot: requestedPath,
      branch: null,
      headCommit: null,
    };
  }

  const remotes = (git(repositoryRoot, ["remote", "-v"]) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[1])
    .filter((value): value is string => value !== undefined)
    .map(normalizeRemote);
  const roots = (git(repositoryRoot, ["rev-list", "--max-parents=0", "HEAD"]) ?? "")
    .split("\n")
    .filter(Boolean);
  const identityParts = [...new Set(remotes)].sort();

  if (identityParts.length === 0) {
    identityParts.push(repositoryRoot);
  }

  identityParts.push(...roots.sort());

  return {
    projectId: hashIdentity(identityParts),
    repositoryRoot,
    branch: git(repositoryRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    headCommit: git(repositoryRoot, ["rev-parse", "HEAD"]),
  };
}

/**
 * Resolves the current repository and initialized nested repositories.
 * Nested repositories are separate memory scopes, but callers can use this
 * workspace view to retrieve and revalidate all scopes from a parent checkout.
 */
export function resolveGitContexts(cwd = process.cwd()): GitContext[] {
  const primary = resolveGitContext(cwd);
  if (primary.headCommit === null) return [primary];
  return [
    primary,
    ...nestedRepositoryRoots(primary.repositoryRoot).map((root) => resolveGitContext(root)),
  ];
}

export function resolveCommitRelation(
  repositoryRoot: string | undefined,
  currentHead: string | null | undefined,
  candidate: string | null,
): "head" | "ancestor" | "diverged" | "unknown" {
  if (currentHead === undefined || currentHead === null || candidate === null) return "unknown";
  if (candidate === currentHead) return "head";
  if (repositoryRoot === undefined) return "unknown";
  const ancestor = git(repositoryRoot, ["merge-base", "--is-ancestor", candidate, currentHead]);
  if (ancestor !== null) return "ancestor";
  const mergeBase = git(repositoryRoot, ["merge-base", candidate, currentHead]);
  return mergeBase === null ? "unknown" : "diverged";
}
