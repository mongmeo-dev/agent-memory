import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildVerifiedHandoff } from "../src/handoff.js";
import { projectLifecycleEvent } from "../src/projector.js";
import { MemoryStore } from "../src/store.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "agents-memory-verified-"));
  directories.push(directory);
  return directory;
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("verified memory", () => {
  it("코드 근거가 변경되거나 삭제되면 validity를 갱신한다", () => {
    const root = workspace();
    const file = join(root, "policy.ts");
    writeFileSync(file, "export const RETRIES = 3;\n");
    const store = new MemoryStore(":memory:");
    try {
      const memory = store.recordMemory({
        kind: "fact",
        summary: "재시도 횟수는 3회다.",
        agent: "test",
        projectId: "project-a",
        branch: "main",
        headCommit: null,
        sourceType: "repository",
        evidence: [
          {
            type: "symbol",
            repositoryPath: "policy.ts",
            symbol: "RETRIES",
            contentHash: digest("export const RETRIES = 3;\n"),
          },
        ],
      });
      expect(memory.validity).toBe("verified");

      writeFileSync(file, "export const RETRIES = 5;\n");
      store.revalidateProject("project-a", root, "main", null);
      expect(store.getMemory(memory.id)?.validity).toBe("changed");

      unlinkSync(file);
      store.revalidateProject("project-a", root, "main", null);
      expect(store.getMemory(memory.id)?.validity).toBe("orphaned");
    } finally {
      store.close();
    }
  });

  it("현재 HEAD에 병합되지 않은 다른 브랜치 기억을 branch-only로 판정한다", () => {
    const root = workspace();
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(join(root, "base.txt"), "base\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "base"], { cwd: root });
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: root });
    writeFileSync(join(root, "feature.txt"), "feature\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-m", "feature"], { cwd: root });
    const featureCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["checkout", "main"], { cwd: root });
    const mainCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();

    const store = new MemoryStore(":memory:");
    try {
      const memory = store.recordMemory({
        kind: "change",
        summary: "feature 브랜치 변경",
        agent: "test",
        projectId: "project-a",
        branch: "feature",
        headCommit: featureCommit,
        evidence: [{ type: "commit", commitSha: featureCommit }],
      });
      store.revalidateProject("project-a", root, "main", mainCommit);
      expect(store.getMemory(memory.id)?.validity).toBe("branch-only");
    } finally {
      store.close();
    }
  });

  it("읽기 도구 노이즈는 버리고 변경 도구에는 저장소 근거를 연결한다", () => {
    const root = workspace();
    writeFileSync(join(root, "feature.ts"), "export const enabled = true;\n");
    const store = new MemoryStore(":memory:");
    try {
      const readEvent = store.ingestEvent({
        type: "tool.completed",
        content: JSON.stringify({ tool_name: "read", tool_response: "file contents" }),
        agent: "claude",
        projectId: "project-a",
        branch: "main",
        headCommit: "abc",
      });
      expect(projectLifecycleEvent(store, readEvent, root)).toBeNull();

      const writeEvent = store.ingestEvent({
        type: "tool.completed",
        content: JSON.stringify({
          tool_name: "write",
          file_path: "feature.ts",
          tool_response: "implemented feature",
        }),
        agent: "claude",
        projectId: "project-a",
        branch: "main",
        headCommit: "abc",
      });
      const memory = projectLifecycleEvent(store, writeEvent, root);
      expect(memory).toMatchObject({ validity: "verified", sourceType: "repository" });
      expect(memory?.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "file", repositoryPath: "feature.ts" }),
        ]),
      );
    } finally {
      store.close();
    }
  });

  it("검증된 변경, 테스트와 미완료 작업을 handoff로 만든다", () => {
    const root = workspace();
    const store = new MemoryStore(":memory:");
    try {
      store.recordMemory({
        kind: "change",
        summary: "결제 재시도를 구현했다.",
        agent: "test",
        projectId: "project-a",
        branch: "main",
        headCommit: null,
        evidence: [{ type: "test", command: "npm test -- payments", exitCode: 0 }],
      });
      store.recordMemory({
        kind: "todo",
        summary: "타임아웃 경로 테스트가 필요하다.",
        agent: "test",
        projectId: "project-a",
        branch: "main",
        headCommit: null,
      });
      const contradicted = store.recordMemory({
        kind: "problem",
        summary: "실패한 검증은 주입하지 않는다.",
        agent: "test",
        projectId: "project-a",
        branch: "main",
        headCommit: null,
        evidence: [{ type: "test", command: "npm test -- broken", exitCode: 1 }],
      });
      expect(contradicted.validity).toBe("contradicted");
      const handoff = buildVerifiedHandoff(store, {
        projectId: "project-a",
        repositoryRoot: root,
        branch: "main",
        headCommit: null,
      });
      expect(handoff).toContain("Verified changes and decisions");
      expect(handoff).toContain("npm test -- payments");
      expect(handoff).toContain("타임아웃 경로 테스트가 필요하다");
      expect(handoff).not.toContain("실패한 검증은 주입하지 않는다");
    } finally {
      store.close();
    }
  });
});
