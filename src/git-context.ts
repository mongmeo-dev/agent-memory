import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

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
