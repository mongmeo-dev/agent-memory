import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveCommitRelation, resolveGitContext } from "../src/git-context.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("resolveGitContext", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("저장소와 브랜치 및 커밋을 식별한다", () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-memory-git-"));
    directories.push(directory);
    git(directory, "init", "-b", "main");
    git(directory, "config", "user.name", "Test");
    git(directory, "config", "user.email", "test@example.com");
    writeFileSync(join(directory, "README.md"), "test\n");
    git(directory, "add", "README.md");
    git(directory, "commit", "-m", "initial");
    git(directory, "remote", "add", "origin", "https://alice:secret@example.com/acme/repo.git");

    const main = resolveGitContext(directory);
    git(directory, "switch", "-c", "feature/test");
    writeFileSync(join(directory, "feature.txt"), "feature\n");
    git(directory, "add", "feature.txt");
    git(directory, "commit", "-m", "feature");
    const feature = resolveGitContext(directory);

    expect(main.repositoryRoot).toBe(realpathSync(directory));
    expect(main.branch).toBe("main");
    expect(main.headCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(feature.branch).toBe("feature/test");
    expect(feature.projectId).toBe(main.projectId);
    expect(resolveCommitRelation(feature.repositoryRoot, feature.headCommit, main.headCommit)).toBe(
      "ancestor",
    );
    expect(
      resolveCommitRelation(feature.repositoryRoot, feature.headCommit, feature.headCommit),
    ).toBe("head");
  });

  it("Git 저장소가 아니어도 경로 기반 scope를 제공한다", () => {
    const directory = mkdtempSync(join(tmpdir(), "agents-memory-path-"));
    directories.push(directory);

    const context = resolveGitContext(directory);

    expect(context.repositoryRoot).toBe(realpathSync(directory));
    expect(context.branch).toBeNull();
    expect(context.headCommit).toBeNull();
    expect(context.projectId).toMatch(/^[0-9a-f]{64}$/);
  });
});
