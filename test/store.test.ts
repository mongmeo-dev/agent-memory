import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoryStore } from "../src/store.js";

const PROJECT_ID = "project-a";

function memoryInput(branch: string, summary: string) {
  return {
    kind: "decision" as const,
    summary,
    agent: "test",
    projectId: PROJECT_ID,
    branch,
    headCommit: `${branch}-commit`,
  };
}

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  it("이벤트 저장 전에 민감정보를 제거하고 ID를 멱등 처리한다", () => {
    const first = store.ingestEvent({
      id: "event-1",
      type: "tool.completed",
      content: "API_KEY=very-secret-value",
      agent: "test",
      projectId: PROJECT_ID,
      branch: "main",
      headCommit: "abc",
    });
    const duplicate = store.ingestEvent({
      id: "event-1",
      type: "tool.completed",
      content: "다른 내용",
      agent: "test",
      projectId: PROJECT_ID,
      branch: "main",
      headCommit: "abc",
    });

    expect(first.content).toBe("API_KEY=[REDACTED]");
    expect(first.redactionCount).toBe(1);
    expect(duplicate).toEqual(first);
  });

  it("기억과 근거 이벤트를 함께 저장하고 조회한다", () => {
    const memory = store.recordMemory(memoryInput("main", "결제 재시도는 지수 백오프를 사용한다"));
    const loaded = store.getMemory(memory.id);

    expect(loaded).toEqual(memory);
    expect(loaded?.evidenceEventIds).toHaveLength(1);
  });

  it("현재 브랜치를 우선하지만 다른 브랜치도 검색한다", () => {
    store.recordMemory(memoryInput("feature/payments", "결제 API 오류 재시도 정책"));
    store.recordMemory(memoryInput("main", "결제 API 응답 캐시 정책"));

    const results = store.searchMemories({
      query: "결제 API 정책",
      projectId: PROJECT_ID,
      currentBranch: "main",
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.branch).toBe("main");
    expect(results[0]?.branchRelation).toBe("current");
    expect(results[1]?.branch).toBe("feature/payments");
    expect(results[1]?.branchRelation).toBe("project");
  });

  it("명시적으로 요청한 다른 브랜치를 최우선으로 검색한다", () => {
    store.recordMemory(memoryInput("main", "결제 API 응답 캐시 정책"));
    store.recordMemory(memoryInput("feature/payments", "결제 API 오류 재시도 정책"));

    const results = store.searchMemories({
      query: "결제 API 정책",
      projectId: PROJECT_ID,
      currentBranch: "main",
      requestedBranch: "feature/payments",
    });

    expect(results[0]?.branch).toBe("feature/payments");
    expect(results[0]?.branchRelation).toBe("requested");
  });

  it("다른 프로젝트의 기억을 반환하지 않는다", () => {
    store.recordMemory(memoryInput("main", "공통 검색어가 있는 결정"));
    store.recordMemory({
      ...memoryInput("main", "공통 검색어가 있는 외부 결정"),
      projectId: "project-b",
    });

    const results = store.searchMemories({
      query: "공통 검색어",
      projectId: PROJECT_ID,
      currentBranch: "main",
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.projectId).toBe(PROJECT_ID);
  });
});
