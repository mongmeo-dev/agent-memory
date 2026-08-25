import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { redact } from "./redaction.js";
import type {
  IngestEventInput,
  Memory,
  MemorySearchResult,
  RecordMemoryInput,
  SearchMemoryInput,
  StoredEvent,
} from "./types.js";

const MAX_EVENT_CHARACTERS = 262_144;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

interface EventRow {
  id: string;
  type: string;
  content: string;
  agent: string;
  project_id: string;
  branch: string | null;
  head_commit: string | null;
  created_at: string;
  ingested_at: string;
  redaction_count: number;
}

interface MemoryRow {
  id: string;
  kind: Memory["kind"];
  summary: string;
  status: Memory["status"];
  project_id: string;
  branch: string | null;
  head_commit: string | null;
  agent: string;
  created_at: string;
  updated_at: string;
  lexical_rank?: number;
}

export function defaultDatabasePath(): string {
  return (
    process.env.AGENTS_MEMORY_DB ?? `${process.env.HOME ?? process.cwd()}/.agents-memory/memory.db`
  );
}

function toFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (tokens.length === 0) {
    throw new Error("검색어에 문자나 숫자가 필요합니다.");
  }
  return [...new Set(tokens)].map((token) => `"${token}"`).join(" OR ");
}

function rowToEvent(row: EventRow): StoredEvent {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    agent: row.agent,
    projectId: row.project_id,
    branch: row.branch,
    headCommit: row.head_commit,
    createdAt: row.created_at,
    ingestedAt: row.ingested_at,
    redactionCount: row.redaction_count,
  };
}

export class MemoryStore {
  readonly #database: DatabaseSync;

  constructor(path = defaultDatabasePath()) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }

    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.#migrate();
  }

  #migrate(): void {
    const version = this.#database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };

    if (version.user_version > 1) {
      throw new Error(`지원하지 않는 데이터베이스 버전: ${version.user_version}`);
    }

    if (version.user_version === 0) {
      this.#database.exec(`
        BEGIN;
        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          agent TEXT NOT NULL,
          project_id TEXT NOT NULL,
          branch TEXT,
          head_commit TEXT,
          created_at TEXT NOT NULL,
          ingested_at TEXT NOT NULL,
          redaction_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX events_scope_idx
          ON events(project_id, branch, created_at DESC);

        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN (
            'goal', 'decision', 'change', 'problem', 'solution',
            'constraint', 'todo', 'fact'
          )),
          summary TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN (
            'active', 'superseded', 'resolved', 'deleted'
          )),
          project_id TEXT NOT NULL,
          branch TEXT,
          head_commit TEXT,
          agent TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX memories_scope_idx
          ON memories(project_id, branch, status, updated_at DESC);

        CREATE TABLE memory_evidence (
          memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
          PRIMARY KEY(memory_id, event_id)
        );

        CREATE VIRTUAL TABLE memory_fts USING fts5(
          memory_id UNINDEXED,
          summary,
          tokenize = 'unicode61'
        );

        PRAGMA user_version = 1;
        COMMIT;
      `);
    }
  }

  ingestEvent(input: IngestEventInput): StoredEvent {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const ingestedAt = new Date().toISOString();
    const limitedContent = input.content.slice(0, MAX_EVENT_CHARACTERS);
    const filtered = redact(limitedContent);

    this.#database
      .prepare(`
        INSERT OR IGNORE INTO events (
          id, type, content, agent, project_id, branch, head_commit,
          created_at, ingested_at, redaction_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.type,
        filtered.text,
        input.agent,
        input.projectId,
        input.branch,
        input.headCommit,
        createdAt,
        ingestedAt,
        filtered.count,
      );

    const row = this.#database.prepare("SELECT * FROM events WHERE id = ?").get(id) as
      | EventRow
      | undefined;
    if (row === undefined) {
      throw new Error(`이벤트 저장 실패: ${id}`);
    }
    return rowToEvent(row);
  }

  recordMemory(input: RecordMemoryInput): Memory {
    const now = new Date().toISOString();
    const event = this.ingestEvent({
      type: "memory.recorded",
      content: input.summary,
      agent: input.agent,
      projectId: input.projectId,
      branch: input.branch,
      headCommit: input.headCommit,
      createdAt: now,
    });
    const memoryId = randomUUID();

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(`
          INSERT INTO memories (
            id, kind, summary, status, project_id, branch, head_commit,
            agent, created_at, updated_at
          ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
        `)
        .run(
          memoryId,
          input.kind,
          event.content,
          input.projectId,
          input.branch,
          input.headCommit,
          input.agent,
          now,
          now,
        );
      this.#database
        .prepare("INSERT INTO memory_evidence (memory_id, event_id) VALUES (?, ?)")
        .run(memoryId, event.id);
      this.#database
        .prepare("INSERT INTO memory_fts (memory_id, summary) VALUES (?, ?)")
        .run(memoryId, event.content);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }

    const memory = this.getMemory(memoryId);
    if (memory === null) {
      throw new Error(`기억 저장 실패: ${memoryId}`);
    }
    return memory;
  }

  getMemory(id: string): Memory | null {
    const row = this.#database.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
      | MemoryRow
      | undefined;
    if (row === undefined || row.status === "deleted") {
      return null;
    }
    return this.#rowToMemory(row);
  }

  searchMemories(input: SearchMemoryInput): MemorySearchResult[] {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
    const rows = this.#database
      .prepare(`
        SELECT m.*, bm25(memory_fts) AS lexical_rank
        FROM memory_fts
        JOIN memories m ON m.id = memory_fts.memory_id
        WHERE memory_fts MATCH ?
          AND m.project_id = ?
          AND m.status != 'deleted'
        ORDER BY
          CASE
            WHEN ? IS NOT NULL AND m.branch = ? THEN 0
            WHEN ? IS NOT NULL AND m.branch = ? THEN 1
            ELSE 2
          END,
          lexical_rank,
          m.updated_at DESC
        LIMIT ?
      `)
      .all(
        toFtsQuery(input.query),
        input.projectId,
        input.requestedBranch ?? null,
        input.requestedBranch ?? null,
        input.currentBranch,
        input.currentBranch,
        limit,
      ) as unknown as MemoryRow[];

    return rows.map((row) => {
      const branchRelation =
        input.requestedBranch !== undefined && row.branch === input.requestedBranch
          ? "requested"
          : row.branch === input.currentBranch
            ? "current"
            : "project";
      return {
        ...this.#rowToMemory(row),
        branchRelation,
        rank: row.lexical_rank ?? 0,
      };
    });
  }

  #rowToMemory(row: MemoryRow): Memory {
    const evidence = this.#database
      .prepare("SELECT event_id FROM memory_evidence WHERE memory_id = ? ORDER BY event_id")
      .all(row.id) as unknown as { event_id: string }[];

    return {
      id: row.id,
      kind: row.kind,
      summary: row.summary,
      status: row.status,
      projectId: row.project_id,
      branch: row.branch,
      headCommit: row.head_commit,
      agent: row.agent,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      evidenceEventIds: evidence.map((item) => item.event_id),
    };
  }

  close(): void {
    this.#database.close();
  }
}
