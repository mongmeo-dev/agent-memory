import { describe, expect, it } from "vitest";

import {
  type EmbeddingProvider,
  hybridSearchMemories,
  indexProjectMemories,
} from "../src/embeddings.js";
import { MemoryStore } from "../src/store.js";

class TestEmbeddingProvider implements EmbeddingProvider {
  readonly name = "test";
  readonly model = "semantic-v1";
  calls = 0;

  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    return texts.map((text) => (text.includes("결제") || text.includes("retry") ? [1, 0] : [0, 1]));
  }
}

describe("embedding search", () => {
  it("변경된 기억만 색인하고 의미 벡터 결과를 lexical 결과와 결합한다", async () => {
    const store = new MemoryStore(":memory:");
    const provider = new TestEmbeddingProvider();
    try {
      const payment = store.recordMemory({
        kind: "solution",
        summary: "결제 오류는 지수 백오프로 처리한다",
        agent: "test",
        projectId: "project-a",
        branch: "feature/payments",
        headCommit: "abc",
      });
      store.recordMemory({
        kind: "decision",
        summary: "캐시는 5분 동안 유지한다",
        agent: "test",
        projectId: "project-a",
        branch: "main",
        headCommit: "def",
      });

      expect(await indexProjectMemories(store, "project-a", provider)).toEqual({
        indexed: 2,
        unchanged: 0,
      });
      expect(await indexProjectMemories(store, "project-a", provider)).toEqual({
        indexed: 0,
        unchanged: 2,
      });

      const results = await hybridSearchMemories(
        store,
        {
          query: "retry strategy",
          projectId: "project-a",
          currentBranch: "main",
          requestedBranch: "feature/payments",
        },
        provider,
      );

      expect(results[0]?.id).toBe(payment.id);
      expect(results[0]?.branchRelation).toBe("requested");
    } finally {
      store.close();
    }
  });

  it("기억 수정 시 기존 임베딩을 무효화한다", async () => {
    const store = new MemoryStore(":memory:");
    const provider = new TestEmbeddingProvider();
    try {
      const memory = store.recordMemory({
        kind: "fact",
        summary: "결제 처리",
        agent: "test",
        projectId: "project-a",
        branch: "main",
        headCommit: "abc",
      });
      await indexProjectMemories(store, "project-a", provider);
      expect(store.getEmbeddings([memory.id])).toHaveLength(1);

      store.updateMemory(memory.id, { summary: "캐시 처리" });
      expect(store.getEmbeddings([memory.id])).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});
