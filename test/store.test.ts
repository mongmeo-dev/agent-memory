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
      content: "API_KEY=very-secret-value",
      agent: "test",
      projectId: PROJECT_ID,
      branch: "main",
      headCommit: "abc",
    });

    expect(first.content).toBe("API_KEY=[REDACTED]");
    expect(first.redactionCount).toBe(1);
    expect(duplicate).toEqual(first);
    expect(() =>
      store.ingestEvent({
        id: "event-1",
        type: "tool.completed",
        content: "다른 내용",
        agent: "test",
        projectId: PROJECT_ID,
        branch: "main",
        headCommit: "abc",
      }),
    ).toThrow("EVENT_ID_CONFLICT");
  });

  it("대용량 이벤트의 UTF-8 경계와 provenance를 기록한다", () => {
    const content = `${"가".repeat(100_000)}tail-secret`;
    const event = store.ingestEvent({
      type: "tool.completed",
      content,
      agent: "test",
      projectId: PROJECT_ID,
      branch: "main",
      headCommit: "abc",
    });

    expect(event.truncated).toBe(true);
    expect(event.originalBytes).toBe(Buffer.byteLength(content));
    expect(event.storedBytes).toBeLessThanOrEqual(262_144);
    expect(event.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(event.content).not.toContain("�");
  });

  it("크기 제한 밖에서 끝나는 private key도 truncation 전에 제거한다", () => {
    const secret = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(300_000)}\n-----END PRIVATE KEY-----`;
    const event = store.ingestEvent({
      type: "tool.completed",
      content: secret,
      agent: "test",
      projectId: PROJECT_ID,
      branch: "main",
      headCommit: "abc",
    });

    expect(event.content).toBe("[REDACTED]");
    expect(event.redactionCount).toBe(1);
    expect(event.originalBytes).toBeGreaterThan(262_144);
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

  it("기억을 수정하고 삭제하며 근거와 검색 인덱스를 일관되게 갱신한다", () => {
    const memory = store.recordMemory(memoryInput("main", "이전 캐시 정책"));
    const updated = store.updateMemory(
      memory.id,
      { summary: "새 캐시 정책 password=secret-value", status: "resolved" },
      "manager",
    );

    expect(updated?.summary).toBe("새 캐시 정책 password=[REDACTED]");
    expect(updated?.status).toBe("resolved");
    expect(updated?.evidenceEventIds).toHaveLength(2);
    expect(
      store.searchMemories({ query: "이전", projectId: PROJECT_ID, currentBranch: "main" }),
    ).toHaveLength(0);
    expect(
      store.searchMemories({ query: "새 캐시", projectId: PROJECT_ID, currentBranch: "main" }),
    ).toHaveLength(1);

    expect(store.deleteMemory(memory.id)).toBe(true);
    expect(store.getMemory(memory.id)).toBeNull();
    expect(store.listMemories({ projectId: PROJECT_ID })).toHaveLength(0);
    expect(JSON.stringify(store.listEvents({ projectId: PROJECT_ID }))).not.toContain("새 캐시");
    expect(JSON.stringify(store.getPendingOutbox())).not.toContain("새 캐시");
    expect(store.deleteMemory(memory.id)).toBe(false);
  });

  it("수집 pause와 사용자 redaction 규칙을 적용한다", () => {
    store.setCollectionSettings({
      paused: true,
      excludedGlobs: [".env*", ".env*"],
      redactionPatterns: ["CUSTOM-[0-9]+"],
    });

    expect(() =>
      store.ingestEvent({
        type: "prompt.submitted",
        content: "CUSTOM-123",
        agent: "adapter",
        projectId: PROJECT_ID,
        branch: "main",
        headCommit: "abc",
        automatic: true,
      }),
    ).toThrow("paused");

    const manual = store.ingestEvent({
      type: "memory.manual",
      content: "CUSTOM-123",
      agent: "test",
      projectId: PROJECT_ID,
      branch: "main",
      headCommit: "abc",
    });
    expect(manual.content).toBe("[REDACTED]");
    expect(store.getCollectionSettings()).toEqual({
      paused: true,
      excludedGlobs: [".env*"],
      redactionPatterns: ["CUSTOM-[0-9]+"],
    });
  });

  it("관리 목록, export, 통계와 동기화 outbox를 제공한다", () => {
    const memory = store.recordMemory(memoryInput("main", "내보낼 결정"));
    const bundle = store.exportBundle();
    const stats = store.getStats();
    const pending = store.getPendingOutbox();

    expect(store.listMemories({ projectId: PROJECT_ID })).toHaveLength(1);
    expect(store.listEvents({ projectId: PROJECT_ID })).toHaveLength(1);
    expect(bundle.memories[0]?.id).toBe(memory.id);
    expect(bundle.events).toHaveLength(1);
    expect(stats).toMatchObject({ events: 1, memories: 1, activeMemories: 1 });
    expect(pending.length).toBeGreaterThanOrEqual(2);

    const last = pending.at(-1);
    expect(last).toBeDefined();
    store.markOutboxSynced(last?.sequence ?? 0);
    expect(store.getPendingOutbox()).toHaveLength(0);
    expect(store.bootstrapOutbox(PROJECT_ID)).toBe(2);
    expect(store.getPendingOutbox()).toHaveLength(2);
  });

  it("프로젝트별 동기화 설정과 상태를 저장한다", () => {
    const configured = store.setSyncSettings(PROJECT_ID, {
      enabled: true,
      baseUrl: "https://sync.example.com",
      remoteProjectId: "remote-project",
      endpointId: "endpoint-id",
      allowInsecureLoopback: false,
      lastSyncedAt: null,
      lastError: null,
    });

    expect(store.getSyncSettings(PROJECT_ID)).toEqual(configured);
    expect(store.getSyncSettings("unknown").enabled).toBe(false);
  });

  it("동기화 outbox를 프로젝트별로 조회해 다른 프로젝트가 앞을 막지 않는다", () => {
    store.recordMemory({ ...memoryInput("main", "외부 프로젝트"), projectId: "project-b" });
    store.recordMemory(memoryInput("main", "현재 프로젝트"));

    const pending = store.getPendingOutbox(2, PROJECT_ID);
    expect(pending).toHaveLength(2);
    expect(
      pending.every(
        (operation) =>
          typeof operation.payload === "object" &&
          operation.payload !== null &&
          "projectId" in operation.payload &&
          operation.payload.projectId === PROJECT_ID,
      ),
    ).toBe(true);
  });

  it("export가 200건을 넘는 전체 데이터를 누락하지 않는다", () => {
    for (let index = 0; index < 205; index += 1) {
      store.recordMemory(memoryInput("main", `export memory ${index}`));
    }
    const bundle = store.exportBundle();
    expect(bundle.memories).toHaveLength(205);
    expect(bundle.events).toHaveLength(205);
  });
});
