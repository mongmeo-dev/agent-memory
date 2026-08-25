import { createHash } from "node:crypto";

import { resolveCommitRelation } from "./git-context.js";
import type { MemoryStore } from "./store.js";
import type { Memory, MemorySearchResult, SearchMemoryInput, StoredEmbedding } from "./types.js";

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface OpenAICompatibleEmbeddingOptions {
  endpoint: string;
  model: string;
  apiKey?: string;
  name?: string;
}

export interface IndexResult {
  indexed: number;
  unchanged: number;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function parseEmbeddingResponse(value: unknown, expectedCount: number): number[][] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("data" in value) ||
    !Array.isArray(value.data)
  ) {
    throw new Error("임베딩 서버 응답에 data 배열이 없습니다.");
  }
  const ordered = value.data
    .map((item: unknown) => {
      if (
        typeof item !== "object" ||
        item === null ||
        !("index" in item) ||
        typeof item.index !== "number" ||
        !("embedding" in item) ||
        !Array.isArray(item.embedding) ||
        item.embedding.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
      ) {
        throw new Error("임베딩 서버가 올바르지 않은 벡터를 반환했습니다.");
      }
      return { index: item.index, vector: item.embedding as number[] };
    })
    .sort((left, right) => left.index - right.index)
    .map((item) => item.vector);
  if (ordered.length !== expectedCount || ordered.some((vector) => vector.length === 0)) {
    throw new Error("임베딩 서버의 벡터 수 또는 차원이 올바르지 않습니다.");
  }
  return ordered;
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly #endpoint: string;
  readonly #apiKey: string | undefined;

  constructor(options: OpenAICompatibleEmbeddingOptions) {
    this.name = options.name ?? "openai-compatible";
    this.model = options.model;
    this.#endpoint = options.endpoint;
    this.#apiKey = options.apiKey;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await fetch(this.#endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.#apiKey === undefined ? {} : { authorization: `Bearer ${this.#apiKey}` }),
      },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`임베딩 서버 오류 (${response.status}): ${body.slice(0, 500)}`);
    }
    return parseEmbeddingResponse(await response.json(), texts.length);
  }
}

function listAllMemories(store: MemoryStore, projectId: string): Memory[] {
  const memories: Memory[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = store.listMemories({ projectId, limit: 200, offset });
    memories.push(...page);
    if (page.length < 200) return memories;
  }
}

function getAllEmbeddings(store: MemoryStore, memoryIds: string[]): StoredEmbedding[] {
  const embeddings: StoredEmbedding[] = [];
  for (let index = 0; index < memoryIds.length; index += 500) {
    embeddings.push(...store.getEmbeddings(memoryIds.slice(index, index + 500)));
  }
  return embeddings;
}

export async function indexProjectMemories(
  store: MemoryStore,
  projectId: string,
  provider: EmbeddingProvider,
  batchSize = 32,
): Promise<IndexResult> {
  const memories = listAllMemories(store, projectId);
  const existing = new Map(
    getAllEmbeddings(
      store,
      memories.map((memory) => memory.id),
    ).map((item) => [item.memoryId, item]),
  );
  const stale = memories.filter((memory) => {
    const embedding = existing.get(memory.id);
    return (
      embedding === undefined ||
      embedding.provider !== provider.name ||
      embedding.model !== provider.model ||
      embedding.contentHash !== hashContent(memory.summary)
    );
  });

  for (let index = 0; index < stale.length; index += batchSize) {
    const batch = stale.slice(index, index + batchSize);
    const vectors = await provider.embed(batch.map((memory) => memory.summary));
    if (vectors.length !== batch.length) {
      throw new Error("임베딩 공급자가 요청한 개수와 다른 벡터 수를 반환했습니다.");
    }
    for (const [offset, memory] of batch.entries()) {
      const vector = vectors[offset];
      if (vector === undefined) throw new Error("임베딩 벡터가 누락되었습니다.");
      store.upsertEmbedding({
        memoryId: memory.id,
        provider: provider.name,
        model: provider.model,
        vector,
        contentHash: hashContent(memory.summary),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return { indexed: stale.length, unchanged: memories.length - stale.length };
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return -1;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return -1;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function branchRelation(
  memory: Memory,
  input: SearchMemoryInput,
): MemorySearchResult["branchRelation"] {
  if (input.requestedBranch !== undefined && memory.branch === input.requestedBranch) {
    return "requested";
  }
  return memory.branch === input.currentBranch ? "current" : "project";
}

export async function hybridSearchMemories(
  store: MemoryStore,
  input: SearchMemoryInput,
  provider: EmbeddingProvider,
): Promise<MemorySearchResult[]> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  const lexical = store.searchMemories({ ...input, limit: 50 });
  const memories = listAllMemories(store, input.projectId);
  const embeddings = new Map<string, StoredEmbedding>(
    getAllEmbeddings(
      store,
      memories.map((memory) => memory.id),
    )
      .filter((item) => item.provider === provider.name && item.model === provider.model)
      .map((item) => [item.memoryId, item]),
  );
  const [queryVector] = await provider.embed([input.query]);
  if (queryVector === undefined) throw new Error("질의 임베딩이 누락되었습니다.");

  const vectorRanked = memories
    .flatMap((memory) => {
      const embedding = embeddings.get(memory.id);
      return embedding === undefined
        ? []
        : [{ memory, similarity: cosineSimilarity(queryVector, embedding.vector) }];
    })
    .filter((item) => item.similarity > -1)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, 50);

  const scores = new Map<string, { memory: Memory; score: number }>();
  lexical.forEach((memory, index) => {
    scores.set(memory.id, { memory, score: 1 / (60 + index + 1) });
  });
  vectorRanked.forEach(({ memory }, index) => {
    const current = scores.get(memory.id);
    scores.set(memory.id, {
      memory,
      score: (current?.score ?? 0) + 1 / (60 + index + 1),
    });
  });

  return [...scores.values()]
    .map(({ memory, score }) => {
      const relation = branchRelation(memory, input);
      const branchBoost = relation === "requested" ? 0.004 : relation === "current" ? 0.002 : 0;
      return {
        ...memory,
        branchRelation: relation,
        commitRelation: resolveCommitRelation(
          input.repositoryRoot,
          input.currentHeadCommit,
          memory.headCommit,
        ),
        rank: score + branchBoost,
      };
    })
    .sort((left, right) => right.rank - left.rank)
    .slice(0, limit);
}
