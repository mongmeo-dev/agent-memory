import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { configuredDatabasePath } from "./config.js";
import { resolveCommitRelation } from "./git-context.js";
import { redact } from "./redaction.js";
import type {
  CollectionSettings,
  ExportBundle,
  IngestEventInput,
  ListEventInput,
  ListMemoryInput,
  Memory,
  MemorySearchResult,
  OutboxOperation,
  RecordMemoryInput,
  SearchMemoryInput,
  StoredEmbedding,
  StoredEvent,
  StoreStats,
  SyncSettings,
  UpdateMemoryInput,
} from "./types.js";

const MAX_EVENT_BYTES = 262_144;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const CURRENT_SCHEMA_VERSION = 5;
const DEFAULT_COLLECTION_SETTINGS: CollectionSettings = {
  paused: false,
  excludedGlobs: [".env*", "**/*.pem", "**/*.key", ".ssh/**", ".gnupg/**"],
  redactionPatterns: [],
};

interface EventRow {
  id: string;
  type: string;
  content: string;
  agent: string;
  project_id: string;
  branch: string | null;
  head_commit: string | null;
  session_id: string | null;
  provider_event: string | null;
  content_hash: string;
  original_bytes: number;
  stored_bytes: number;
  truncated: number;
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
    process.env.AGENTS_MEMORY_DB ??
    configuredDatabasePath() ??
    `${process.env.HOME ?? process.cwd()}/.agents-memory/memory.db`
  );
}

function toFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (tokens.length === 0) {
    throw new Error("검색어에 문자나 숫자가 필요합니다.");
  }
  return [...new Set(tokens)].map((token) => `"${token}"`).join(" OR ");
}

function truncateUtf8(input: string): {
  text: string;
  originalBytes: number;
  storedSourceBytes: number;
  truncated: boolean;
} {
  const originalBytes = Buffer.byteLength(input);
  if (originalBytes <= MAX_EVENT_BYTES) {
    return { text: input, originalBytes, storedSourceBytes: originalBytes, truncated: false };
  }
  const characters: string[] = [];
  let storedSourceBytes = 0;
  for (const character of input) {
    const bytes = Buffer.byteLength(character);
    if (storedSourceBytes + bytes > MAX_EVENT_BYTES) break;
    characters.push(character);
    storedSourceBytes += bytes;
  }
  return {
    text: characters.join(""),
    originalBytes,
    storedSourceBytes,
    truncated: true,
  };
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
    sessionId: row.session_id,
    providerEvent: row.provider_event,
    contentHash: row.content_hash,
    originalBytes: row.original_bytes,
    storedBytes: row.stored_bytes,
    truncated: row.truncated === 1,
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
    if (path !== ":memory:") {
      if (path === `${process.env.HOME ?? process.cwd()}/.agents-memory/memory.db`) {
        chmodSync(dirname(path), 0o700);
      }
      chmodSync(path, 0o600);
    }
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.#migrate();
  }

  #migrate(): void {
    const version = this.#database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };

    if (version.user_version > CURRENT_SCHEMA_VERSION) {
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
          session_id TEXT,
          provider_event TEXT,
          content_hash TEXT NOT NULL,
          original_bytes INTEGER NOT NULL,
          stored_bytes INTEGER NOT NULL,
          truncated INTEGER NOT NULL DEFAULT 0,
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

        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE tombstones (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          deleted_at TEXT NOT NULL,
          UNIQUE(entity_type, entity_id)
        );

        CREATE TABLE outbox (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          action TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          synced_at TEXT
        );
        CREATE INDEX outbox_pending_idx ON outbox(synced_at, sequence);

        CREATE TABLE memory_embeddings (
          memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          vector TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        PRAGMA user_version = 5;
        COMMIT;
      `);
    }

    if (version.user_version === 1) {
      this.#database.exec(`
        BEGIN;
        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE tombstones (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          deleted_at TEXT NOT NULL,
          UNIQUE(entity_type, entity_id)
        );
        CREATE TABLE outbox (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          action TEXT NOT NULL,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL,
          synced_at TEXT
        );
        CREATE INDEX outbox_pending_idx ON outbox(synced_at, sequence);
        CREATE TABLE memory_embeddings (
          memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          vector TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        ALTER TABLE events ADD COLUMN session_id TEXT;
        ALTER TABLE events ADD COLUMN provider_event TEXT;
        ALTER TABLE events ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
        ALTER TABLE events ADD COLUMN original_bytes INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE events ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE events ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version = 5;
        COMMIT;
      `);
    }

    if (version.user_version === 2) {
      this.#database.exec(`
        BEGIN;
        CREATE TABLE memory_embeddings (
          memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          vector TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        ALTER TABLE events ADD COLUMN session_id TEXT;
        ALTER TABLE events ADD COLUMN provider_event TEXT;
        ALTER TABLE events ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
        ALTER TABLE events ADD COLUMN original_bytes INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE events ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE events ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version = 5;
        COMMIT;
      `);
    }

    if (version.user_version === 3) {
      this.#database.exec(`
        BEGIN;
        ALTER TABLE events ADD COLUMN session_id TEXT;
        ALTER TABLE events ADD COLUMN provider_event TEXT;
        ALTER TABLE events ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
        ALTER TABLE events ADD COLUMN original_bytes INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE events ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE events ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version = 5;
        COMMIT;
      `);
    }

    if (version.user_version === 4) {
      this.#database.exec(`
        BEGIN;
        ALTER TABLE events ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
        ALTER TABLE events ADD COLUMN original_bytes INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE events ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE events ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version = 5;
        COMMIT;
      `);
    }
  }

  ingestEvent(input: IngestEventInput): StoredEvent {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const event = this.#insertEvent(input);
      this.#database.exec("COMMIT");
      return event;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #insertEvent(input: IngestEventInput, enqueue = true): StoredEvent {
    const settings = this.getCollectionSettings();
    if (input.automatic === true && settings.paused) {
      throw new Error("자동 수집이 일시중지되어 있습니다.");
    }
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const ingestedAt = new Date().toISOString();
    const filtered = redact(input.content, settings.redactionPatterns);
    const limited = truncateUtf8(filtered.text);
    const contentHash = createHash("sha256").update(filtered.text).digest("hex");
    const storedBytes = Buffer.byteLength(limited.text);

    const result = this.#database
      .prepare(`
        INSERT OR IGNORE INTO events (
          id, type, content, agent, project_id, branch, head_commit,
          session_id, provider_event, content_hash, original_bytes, stored_bytes,
          truncated, created_at, ingested_at, redaction_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        input.type,
        limited.text,
        input.agent,
        input.projectId,
        input.branch,
        input.headCommit,
        input.sessionId ?? null,
        input.providerEvent ?? null,
        contentHash,
        Buffer.byteLength(input.content),
        storedBytes,
        limited.truncated ? 1 : 0,
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
    if (
      result.changes === 0 &&
      (row.type !== input.type ||
        row.content !== limited.text ||
        row.agent !== input.agent ||
        row.project_id !== input.projectId ||
        row.branch !== input.branch ||
        row.head_commit !== input.headCommit ||
        row.session_id !== (input.sessionId ?? null) ||
        row.provider_event !== (input.providerEvent ?? null) ||
        row.content_hash !== contentHash)
    ) {
      throw new Error(`EVENT_ID_CONFLICT: ${id}`);
    }
    if (result.changes > 0 && enqueue) {
      this.#enqueue("event", id, "upsert", rowToEvent(row));
    }
    return rowToEvent(row);
  }

  recordMemory(input: RecordMemoryInput): Memory {
    const now = new Date().toISOString();
    const memoryId = randomUUID();

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const event = this.#insertEvent({
        type: "memory.recorded",
        content: input.summary,
        agent: input.agent,
        projectId: input.projectId,
        branch: input.branch,
        headCommit: input.headCommit,
        createdAt: now,
      });
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
      const evidenceEventIds = [event.id];
      for (const evidenceId of input.evidenceEventIds ?? []) {
        const evidence = this.getEvent(evidenceId);
        if (
          evidence !== null &&
          evidence.projectId === input.projectId &&
          !evidenceEventIds.includes(evidenceId)
        ) {
          this.#database
            .prepare("INSERT INTO memory_evidence (memory_id, event_id) VALUES (?, ?)")
            .run(memoryId, evidenceId);
          evidenceEventIds.push(evidenceId);
        }
      }
      this.#database
        .prepare("INSERT INTO memory_fts (memory_id, summary) VALUES (?, ?)")
        .run(memoryId, event.content);
      this.#enqueue("memory", memoryId, "upsert", {
        id: memoryId,
        kind: input.kind,
        summary: event.content,
        status: "active",
        projectId: input.projectId,
        branch: input.branch,
        headCommit: input.headCommit,
        agent: input.agent,
        createdAt: now,
        updatedAt: now,
        evidenceEventIds,
      });
      this.#database.exec("COMMIT");
      const memory = this.getMemory(memoryId);
      if (memory === null) {
        throw new Error(`기억 저장 실패: ${memoryId}`);
      }
      return memory;
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
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

  getEvent(id: string): StoredEvent | null {
    const row = this.#database.prepare("SELECT * FROM events WHERE id = ?").get(id) as
      | EventRow
      | undefined;
    return row === undefined ? null : rowToEvent(row);
  }

  listMemories(input: ListMemoryInput = {}): Memory[] {
    const clauses = ["status != 'deleted'"];
    const parameters: (string | number | null)[] = [];
    if (input.projectId !== undefined) {
      clauses.push("project_id = ?");
      parameters.push(input.projectId);
    }
    if (input.branch !== undefined) {
      clauses.push("branch IS ?");
      parameters.push(input.branch);
    }
    if (input.kind !== undefined) {
      clauses.push("kind = ?");
      parameters.push(input.kind);
    }
    if (input.status !== undefined) {
      clauses.push("status = ?");
      parameters.push(input.status);
    }
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const offset = Math.max(input.offset ?? 0, 0);
    parameters.push(limit, offset);
    const rows = this.#database
      .prepare(`
        SELECT * FROM memories
        WHERE ${clauses.join(" AND ")}
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(...parameters) as unknown as MemoryRow[];
    return rows.map((row) => this.#rowToMemory(row));
  }

  listEvents(input: ListEventInput = {}): StoredEvent[] {
    const clauses = ["1 = 1"];
    const parameters: (string | number | null)[] = [];
    if (input.projectId !== undefined) {
      clauses.push("project_id = ?");
      parameters.push(input.projectId);
    }
    if (input.branch !== undefined) {
      clauses.push("branch IS ?");
      parameters.push(input.branch);
    }
    if (input.type !== undefined) {
      clauses.push("type = ?");
      parameters.push(input.type);
    }
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const offset = Math.max(input.offset ?? 0, 0);
    parameters.push(limit, offset);
    const rows = this.#database
      .prepare(`
        SELECT * FROM events
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(...parameters) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  updateMemory(id: string, input: UpdateMemoryInput, agent = "management"): Memory | null {
    const current = this.getMemory(id);
    if (current === null) return null;
    if (input.summary === undefined && input.kind === undefined && input.status === undefined) {
      return current;
    }

    const now = new Date().toISOString();
    const kind = input.kind ?? current.kind;
    const status = input.status ?? current.status;

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const event = this.#insertEvent({
        type: "memory.corrected",
        content: input.summary ?? current.summary,
        agent,
        projectId: current.projectId,
        branch: current.branch,
        headCommit: current.headCommit,
      });
      const summary = event.content;
      this.#database
        .prepare(`
          UPDATE memories
          SET summary = ?, kind = ?, status = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(summary, kind, status, now, id);
      this.#database
        .prepare("INSERT OR IGNORE INTO memory_evidence (memory_id, event_id) VALUES (?, ?)")
        .run(id, event.id);
      this.#database.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(id);
      this.#database
        .prepare("INSERT INTO memory_fts (memory_id, summary) VALUES (?, ?)")
        .run(id, summary);
      this.#database.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
      const updated = {
        ...current,
        summary,
        kind,
        status,
        updatedAt: now,
        evidenceEventIds: [...current.evidenceEventIds, event.id],
      };
      this.#enqueue("memory", id, "upsert", updated);
      this.#database.exec("COMMIT");
      return updated;
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  deleteMemory(id: string): boolean {
    const current = this.getMemory(id);
    if (current === null) return false;
    const now = new Date().toISOString();
    const evidenceIds = [...current.evidenceEventIds];
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(
          "UPDATE memories SET summary = '[DELETED]', status = 'deleted', updated_at = ? WHERE id = ?",
        )
        .run(now, id);
      this.#database.prepare("DELETE FROM memory_evidence WHERE memory_id = ?").run(id);
      for (const eventId of evidenceIds) {
        const references = this.#database
          .prepare("SELECT COUNT(*) AS count FROM memory_evidence WHERE event_id = ?")
          .get(eventId) as { count: number };
        if (references.count === 0) {
          this.#database
            .prepare("DELETE FROM outbox WHERE entity_type = 'event' AND entity_id = ?")
            .run(eventId);
          this.#database.prepare("DELETE FROM events WHERE id = ?").run(eventId);
          this.#enqueue("event", eventId, "delete", {
            projectId: current.projectId,
            deletedAt: now,
          });
        }
      }
      this.#database
        .prepare("DELETE FROM outbox WHERE entity_type = 'memory' AND entity_id = ?")
        .run(id);
      this.#database.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(id);
      this.#database.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
      this.#database
        .prepare(`
          INSERT INTO tombstones (entity_type, entity_id, deleted_at)
          VALUES ('memory', ?, ?)
          ON CONFLICT(entity_type, entity_id) DO UPDATE SET deleted_at = excluded.deleted_at
        `)
        .run(id, now);
      this.#enqueue("memory", id, "delete", {
        projectId: current.projectId,
        deletedAt: now,
      });
      this.#database.exec("COMMIT");
      return true;
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
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
          lexical_rank,
          CASE
            WHEN ? IS NOT NULL AND m.branch = ? THEN 0
            WHEN ? IS NOT NULL AND m.branch = ? THEN 1
            ELSE 2
          END,
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
        commitRelation: resolveCommitRelation(
          input.repositoryRoot,
          input.currentHeadCommit,
          row.head_commit,
        ),
        rank: row.lexical_rank ?? 0,
      };
    });
  }

  getCollectionSettings(): CollectionSettings {
    const row = this.#database
      .prepare("SELECT value FROM settings WHERE key = 'collection'")
      .get() as { value: string } | undefined;
    if (row === undefined) return structuredClone(DEFAULT_COLLECTION_SETTINGS);
    const parsed = JSON.parse(row.value) as Partial<CollectionSettings>;
    return {
      paused: parsed.paused === true,
      excludedGlobs: Array.isArray(parsed.excludedGlobs)
        ? parsed.excludedGlobs.filter((item): item is string => typeof item === "string")
        : [...DEFAULT_COLLECTION_SETTINGS.excludedGlobs],
      redactionPatterns: Array.isArray(parsed.redactionPatterns)
        ? parsed.redactionPatterns.filter((item): item is string => typeof item === "string")
        : [],
    };
  }

  setCollectionSettings(settings: CollectionSettings): CollectionSettings {
    if (settings.redactionPatterns.length > 50) {
      throw new Error("사용자 redaction pattern은 최대 50개까지 지원합니다.");
    }
    for (const pattern of settings.redactionPatterns) {
      if (pattern.length > 500) throw new Error("redaction pattern은 500자 이하여야 합니다.");
      new RegExp(pattern, "gu");
    }
    const normalized: CollectionSettings = {
      paused: settings.paused,
      excludedGlobs: [
        ...new Set(settings.excludedGlobs.map((item) => item.trim()).filter(Boolean)),
      ],
      redactionPatterns: [
        ...new Set(settings.redactionPatterns.map((item) => item.trim()).filter(Boolean)),
      ],
    };
    const now = new Date().toISOString();
    this.#database
      .prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES ('collection', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(JSON.stringify(normalized), now);
    this.#enqueue("settings", "collection", "upsert", normalized);
    return normalized;
  }

  getSyncSettings(projectId: string): SyncSettings {
    const row = this.#database
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(`sync:${projectId}`) as { value: string } | undefined;
    if (row === undefined) {
      return {
        enabled: false,
        baseUrl: null,
        remoteProjectId: null,
        endpointId: null,
        allowInsecureLoopback: false,
        lastSyncedAt: null,
        lastError: null,
      };
    }
    return JSON.parse(row.value) as SyncSettings;
  }

  setSyncSettings(projectId: string, settings: SyncSettings): SyncSettings {
    this.#database
      .prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(`sync:${projectId}`, JSON.stringify(settings), new Date().toISOString());
    return settings;
  }

  getStats(): StoreStats {
    const row = this.#database
      .prepare(`
        SELECT
          (SELECT COUNT(*) FROM events) AS events,
          (SELECT COUNT(*) FROM memories WHERE status != 'deleted') AS memories,
          (SELECT COUNT(*) FROM memories WHERE status = 'active') AS active_memories,
          (SELECT COALESCE(SUM(redaction_count), 0) FROM events) AS redactions,
          (SELECT COUNT(*) FROM outbox WHERE synced_at IS NULL) AS pending_sync_operations
      `)
      .get() as {
      events: number;
      memories: number;
      active_memories: number;
      redactions: number;
      pending_sync_operations: number;
    };
    return {
      events: row.events,
      memories: row.memories,
      activeMemories: row.active_memories,
      redactions: row.redactions,
      pendingSyncOperations: row.pending_sync_operations,
    };
  }

  exportBundle(): ExportBundle {
    const events: StoredEvent[] = [];
    const memories: Memory[] = [];
    for (let offset = 0; ; offset += 200) {
      const page = this.listEvents({ limit: 200, offset });
      events.push(...page);
      if (page.length < 200) break;
    }
    for (let offset = 0; ; offset += 200) {
      const page = this.listMemories({ limit: 200, offset });
      memories.push(...page);
      if (page.length < 200) break;
    }
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      events,
      memories,
      settings: this.getCollectionSettings(),
    };
  }

  getPendingOutbox(limit = 100, projectId?: string): OutboxOperation[] {
    const rows = this.#database
      .prepare(`
        SELECT sequence, entity_type, entity_id, action, payload, created_at
        FROM outbox
        WHERE synced_at IS NULL
          AND (? IS NULL OR json_extract(payload, '$.projectId') = ?)
        ORDER BY sequence
        LIMIT ?
      `)
      .all(projectId ?? null, projectId ?? null, Math.min(Math.max(limit, 1), 1000)) as unknown as {
      sequence: number;
      entity_type: OutboxOperation["entityType"];
      entity_id: string;
      action: OutboxOperation["action"];
      payload: string;
      created_at: string;
    }[];
    return rows.map((row) => ({
      sequence: row.sequence,
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
      payload: JSON.parse(row.payload) as unknown,
      createdAt: row.created_at,
    }));
  }

  bootstrapOutbox(projectId: string): number {
    let queued = 0;
    for (let offset = 0; ; offset += 200) {
      const events = this.listEvents({ projectId, limit: 200, offset });
      for (const event of events) {
        this.#enqueue("event", event.id, "upsert", event);
        queued += 1;
      }
      if (events.length < 200) break;
    }
    for (let offset = 0; ; offset += 200) {
      const memories = this.listMemories({ projectId, limit: 200, offset });
      for (const memory of memories) {
        this.#enqueue("memory", memory.id, "upsert", memory);
        queued += 1;
      }
      if (memories.length < 200) break;
    }
    return queued;
  }

  markOutboxSynced(throughSequence: number): void {
    this.#database
      .prepare("UPDATE outbox SET synced_at = ? WHERE sequence <= ? AND synced_at IS NULL")
      .run(new Date().toISOString(), throughSequence);
  }

  markOutboxSequencesSynced(sequences: number[]): void {
    if (sequences.length === 0) return;
    const placeholders = sequences.map(() => "?").join(", ");
    this.#database
      .prepare(`
        UPDATE outbox
        SET synced_at = ?
        WHERE sequence IN (${placeholders}) AND synced_at IS NULL
      `)
      .run(new Date().toISOString(), ...sequences);
  }

  getOrCreateDeviceId(): string {
    const existing = this.#database
      .prepare("SELECT value FROM settings WHERE key = 'device_id'")
      .get() as { value: string } | undefined;
    if (existing !== undefined) return existing.value;
    const deviceId = randomUUID();
    this.#database
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('device_id', ?, ?)")
      .run(deviceId, new Date().toISOString());
    return deviceId;
  }

  getSyncCursor(endpointId: string, projectId: string): string | null {
    const key = `sync_cursor:${endpointId}:${projectId}`;
    const row = this.#database.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSyncCursor(endpointId: string, projectId: string, cursor: string): void {
    const key = `sync_cursor:${endpointId}:${projectId}`;
    this.#database
      .prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(key, cursor, new Date().toISOString());
  }

  applyRemoteOperation(operation: OutboxOperation): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      if (operation.entityType === "event" && operation.action === "upsert") {
        const event = operation.payload as StoredEvent;
        this.#insertEvent(
          {
            id: event.id,
            type: event.type,
            content: event.content,
            agent: event.agent,
            projectId: event.projectId,
            branch: event.branch,
            headCommit: event.headCommit,
            sessionId: event.sessionId,
            providerEvent: event.providerEvent,
            createdAt: event.createdAt,
          },
          false,
        );
      } else if (operation.entityType === "memory" && operation.action === "upsert") {
        const memory = operation.payload as Memory;
        const current = this.getMemory(memory.id);
        const tombstone = this.#database
          .prepare(
            "SELECT deleted_at FROM tombstones WHERE entity_type = 'memory' AND entity_id = ?",
          )
          .get(memory.id) as { deleted_at: string } | undefined;
        if (
          (tombstone === undefined || tombstone.deleted_at < memory.updatedAt) &&
          (current === null || current.updatedAt <= memory.updatedAt)
        ) {
          this.#database
            .prepare(`
              INSERT INTO memories (
                id, kind, summary, status, project_id, branch, head_commit,
                agent, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET
                kind = excluded.kind,
                summary = excluded.summary,
                status = excluded.status,
                project_id = excluded.project_id,
                branch = excluded.branch,
                head_commit = excluded.head_commit,
                agent = excluded.agent,
                updated_at = excluded.updated_at
            `)
            .run(
              memory.id,
              memory.kind,
              memory.summary,
              memory.status,
              memory.projectId,
              memory.branch,
              memory.headCommit,
              memory.agent,
              memory.createdAt,
              memory.updatedAt,
            );
          for (const eventId of memory.evidenceEventIds) {
            if (this.getEvent(eventId) !== null) {
              this.#database
                .prepare(
                  "INSERT OR IGNORE INTO memory_evidence (memory_id, event_id) VALUES (?, ?)",
                )
                .run(memory.id, eventId);
            }
          }
          this.#database.prepare("DELETE FROM memory_fts WHERE memory_id = ?").run(memory.id);
          if (memory.status !== "deleted") {
            this.#database
              .prepare("INSERT INTO memory_fts (memory_id, summary) VALUES (?, ?)")
              .run(memory.id, memory.summary);
          }
        }
      } else if (operation.entityType === "event" && operation.action === "delete") {
        this.#database
          .prepare("DELETE FROM memory_evidence WHERE event_id = ?")
          .run(operation.entityId);
        this.#database.prepare("DELETE FROM events WHERE id = ?").run(operation.entityId);
        this.#database
          .prepare(`
            INSERT INTO tombstones (entity_type, entity_id, deleted_at)
            VALUES ('event', ?, ?)
            ON CONFLICT(entity_type, entity_id) DO UPDATE SET deleted_at = excluded.deleted_at
          `)
          .run(operation.entityId, operation.createdAt);
      } else if (
        (operation.entityType === "memory" && operation.action === "delete") ||
        operation.entityType === "tombstone"
      ) {
        const payload = operation.payload as { deletedAt?: string };
        const deletedAt = payload.deletedAt ?? operation.createdAt;
        this.#database
          .prepare(
            "UPDATE memories SET summary = '[DELETED]', status = 'deleted', updated_at = ? WHERE id = ?",
          )
          .run(deletedAt, operation.entityId);
        this.#database
          .prepare("DELETE FROM memory_evidence WHERE memory_id = ?")
          .run(operation.entityId);
        this.#database
          .prepare("DELETE FROM memory_fts WHERE memory_id = ?")
          .run(operation.entityId);
        this.#database
          .prepare("DELETE FROM memory_embeddings WHERE memory_id = ?")
          .run(operation.entityId);
        this.#database
          .prepare(`
            INSERT INTO tombstones (entity_type, entity_id, deleted_at)
            VALUES ('memory', ?, ?)
            ON CONFLICT(entity_type, entity_id) DO UPDATE SET deleted_at = excluded.deleted_at
          `)
          .run(operation.entityId, deletedAt);
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  upsertEmbedding(embedding: StoredEmbedding): void {
    if (
      embedding.vector.length === 0 ||
      embedding.vector.some((value) => !Number.isFinite(value))
    ) {
      throw new Error("임베딩 벡터는 유한한 숫자를 하나 이상 포함해야 합니다.");
    }
    this.#database
      .prepare(`
        INSERT INTO memory_embeddings (
          memory_id, provider, model, vector, content_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET
          provider = excluded.provider,
          model = excluded.model,
          vector = excluded.vector,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at
      `)
      .run(
        embedding.memoryId,
        embedding.provider,
        embedding.model,
        JSON.stringify(embedding.vector),
        embedding.contentHash,
        embedding.updatedAt,
      );
  }

  getEmbeddings(memoryIds: string[]): StoredEmbedding[] {
    if (memoryIds.length === 0) return [];
    const placeholders = memoryIds.map(() => "?").join(", ");
    const rows = this.#database
      .prepare(`
        SELECT memory_id, provider, model, vector, content_hash, updated_at
        FROM memory_embeddings
        WHERE memory_id IN (${placeholders})
      `)
      .all(...memoryIds) as unknown as {
      memory_id: string;
      provider: string;
      model: string;
      vector: string;
      content_hash: string;
      updated_at: string;
    }[];
    return rows.map((row) => ({
      memoryId: row.memory_id,
      provider: row.provider,
      model: row.model,
      vector: JSON.parse(row.vector) as number[],
      contentHash: row.content_hash,
      updatedAt: row.updated_at,
    }));
  }

  #enqueue(
    entityType: OutboxOperation["entityType"],
    entityId: string,
    action: OutboxOperation["action"],
    payload: unknown,
  ): void {
    this.#database
      .prepare(`
        INSERT INTO outbox (entity_type, entity_id, action, payload, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(entityType, entityId, action, JSON.stringify(payload), new Date().toISOString());
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
