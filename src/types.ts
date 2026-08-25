export const MEMORY_KINDS = [
  "goal",
  "decision",
  "change",
  "problem",
  "solution",
  "constraint",
  "todo",
  "fact",
] as const;

export const EVENT_TYPES = [
  "session.started",
  "prompt.submitted",
  "tool.completed",
  "tool.failed",
  "turn.completed",
  "session.ended",
  "git.context.changed",
] as const;

export type LifecycleEventType = (typeof EVENT_TYPES)[number];
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryStatus = "active" | "superseded" | "resolved" | "deleted";

export interface GitContext {
  projectId: string;
  repositoryRoot: string;
  branch: string | null;
  headCommit: string | null;
}

export interface IngestEventInput {
  id?: string;
  type: string;
  content: string;
  agent: string;
  projectId: string;
  branch: string | null;
  headCommit: string | null;
  sessionId?: string | null;
  providerEvent?: string | null;
  createdAt?: string;
  automatic?: boolean;
}

export interface StoredEvent {
  id: string;
  type: string;
  content: string;
  agent: string;
  projectId: string;
  branch: string | null;
  headCommit: string | null;
  sessionId: string | null;
  providerEvent: string | null;
  contentHash: string;
  originalBytes: number;
  storedBytes: number;
  truncated: boolean;
  createdAt: string;
  ingestedAt: string;
  redactionCount: number;
}

export interface RecordMemoryInput {
  kind: MemoryKind;
  summary: string;
  agent: string;
  projectId: string;
  branch: string | null;
  headCommit: string | null;
  evidenceEventIds?: string[];
}

export interface Memory {
  id: string;
  kind: MemoryKind;
  summary: string;
  status: MemoryStatus;
  projectId: string;
  branch: string | null;
  headCommit: string | null;
  agent: string;
  createdAt: string;
  updatedAt: string;
  evidenceEventIds: string[];
}

export interface SearchMemoryInput {
  query: string;
  projectId: string;
  currentBranch: string | null;
  repositoryRoot?: string;
  currentHeadCommit?: string | null;
  requestedBranch?: string | null;
  limit?: number;
}

export interface MemorySearchResult extends Memory {
  branchRelation: "current" | "requested" | "project";
  commitRelation: "head" | "ancestor" | "diverged" | "unknown";
  rank: number;
}

export interface ListMemoryInput {
  projectId?: string;
  branch?: string | null;
  kind?: MemoryKind;
  status?: Exclude<MemoryStatus, "deleted">;
  limit?: number;
  offset?: number;
}

export interface UpdateMemoryInput {
  summary?: string;
  kind?: MemoryKind;
  status?: Exclude<MemoryStatus, "deleted">;
}

export interface ListEventInput {
  projectId?: string;
  branch?: string | null;
  type?: string;
  limit?: number;
  offset?: number;
}

export interface CollectionSettings {
  paused: boolean;
  excludedGlobs: string[];
  redactionPatterns: string[];
}

export interface StoreStats {
  events: number;
  memories: number;
  activeMemories: number;
  redactions: number;
  pendingSyncOperations: number;
  spoolLosses?: number;
}

export interface ExportBundle {
  schemaVersion: number;
  exportedAt: string;
  events: StoredEvent[];
  memories: Memory[];
  settings: CollectionSettings;
}

export interface OutboxOperation {
  sequence: number;
  entityType: "event" | "memory" | "settings" | "tombstone";
  entityId: string;
  action: "upsert" | "delete";
  payload: unknown;
  createdAt: string;
}

export interface StoredEmbedding {
  memoryId: string;
  provider: string;
  model: string;
  vector: number[];
  contentHash: string;
  updatedAt: string;
}

export interface SyncSettings {
  enabled: boolean;
  baseUrl: string | null;
  remoteProjectId: string | null;
  endpointId: string | null;
  allowInsecureLoopback: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
}
