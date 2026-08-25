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
  createdAt?: string;
}

export interface StoredEvent {
  id: string;
  type: string;
  content: string;
  agent: string;
  projectId: string;
  branch: string | null;
  headCommit: string | null;
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
  requestedBranch?: string | null;
  limit?: number;
}

export interface MemorySearchResult extends Memory {
  branchRelation: "current" | "requested" | "project";
  rank: number;
}
