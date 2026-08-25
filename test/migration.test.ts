import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { MemoryStore } from "../src/store.js";

describe("SQLite migrations", () => {
  it("v1 데이터베이스를 v3로 올리면서 기존 기억과 FTS를 보존한다", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-memory-migration-"));
    const path = join(root, "memory.db");
    const database = new DatabaseSync(path);
    const now = "2026-08-25T00:00:00.000Z";
    database.exec(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL,
        agent TEXT NOT NULL, project_id TEXT NOT NULL, branch TEXT,
        head_commit TEXT, created_at TEXT NOT NULL, ingested_at TEXT NOT NULL,
        redaction_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, summary TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', project_id TEXT NOT NULL,
        branch TEXT, head_commit TEXT, agent TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE memory_evidence (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
        PRIMARY KEY(memory_id, event_id)
      );
      CREATE VIRTUAL TABLE memory_fts USING fts5(memory_id UNINDEXED, summary, tokenize = 'unicode61');
      INSERT INTO events VALUES ('event-1', 'memory.recorded', '기존 결정', 'test', 'project-a', 'main', 'abc', '${now}', '${now}', 0);
      INSERT INTO memories VALUES ('memory-1', 'decision', '기존 결정', 'active', 'project-a', 'main', 'abc', 'test', '${now}', '${now}');
      INSERT INTO memory_evidence VALUES ('memory-1', 'event-1');
      INSERT INTO memory_fts VALUES ('memory-1', '기존 결정');
      PRAGMA user_version = 1;
    `);
    database.close();

    const store = new MemoryStore(path);
    try {
      expect(store.getMemory("memory-1")?.summary).toBe("기존 결정");
      expect(
        store.searchMemories({
          query: "기존",
          projectId: "project-a",
          currentBranch: "main",
        }),
      ).toHaveLength(1);
      expect(store.getSyncSettings("project-a").enabled).toBe(false);
      store.upsertEmbedding({
        memoryId: "memory-1",
        provider: "test",
        model: "test",
        vector: [1],
        contentHash: "hash",
        updatedAt: now,
      });
      expect(store.getEmbeddings(["memory-1"])).toHaveLength(1);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
