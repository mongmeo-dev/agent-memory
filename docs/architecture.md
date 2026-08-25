[한국어](architecture.ko.md)

# System Architecture

## 1. Design Decisions

| Item | Decision | Rationale |
| --- | --- | --- |
| Implementation language | TypeScript/Node.js | Align the language used by the official MCP SDK v2, adapters, and web UI |
| Local storage | SQLite + FTS5 | No installation burden; supports transactions and full-text search |
| Remote storage | Managed PostgreSQL | Supports multi-user and multi-device synchronization and has a mature operational tooling ecosystem |
| Data model | Append-only events + derived memories | Preserves original evidence and enables reprocessing and conflict resolution |
| Search | FTS first, optional vector search | Fully functional without external models and can be extended incrementally |
| Integration | Shared daemon + client adapters | Captures lifecycle data that MCP alone cannot observe |
| Management UI | Localhost web UI served by the daemon | Shares the CLI and API without a separate backend |

## 2. Components

```text
Claude Code hooks ─┐
Codex adapter ─────┼─> Local ingest API ─> Redaction ─> Event store
GJC adapter ───────┘                              │
                                                   v
MCP client <──── MCP server <──── Retrieval <─ Memory projector
       ^                               │             │
       └──── automatic context injector┘             v
CLI / Web UI <──────────── Local management API ─ SQLite/FTS
                                                      │
                                                      v (opt-in)
                                               Sync worker
                                                      │
                                                      v
                                         Managed PostgreSQL service
```

The local daemon is the primary writer for automatic lifecycle collection and the management API. Hooks use the daemon first; if it fails, a redacted spool and direct SQLite WAL writes allow agent work to continue. The stdio MCP server and management CLI use the same schema and policies, while SQLite transactions and WAL maintain consistency during concurrent access.

## 3. Boundaries and Packages

- `core`: Event, memory, scope, and policy types; independent of transports and databases
- `storage-sqlite`: Migrations, event repository, memory repository, and FTS index
- `git-context`: Repository identity, worktrees, refs, HEAD, and commit-graph relationship calculations
- `redaction`: Secret detection, file exclusion policies, and size limits
- `projector`: Promotes only events that pass the quality gate into structured memories and extracts repository evidence
- `memory-ci`: Revalidates file hashes, symbols, commits, and test evidence at Git HEAD and updates validity
- `handoff`: Assembles validated changes, validation results, and unfinished work into an inter-agent handoff format
- `retrieval`: Lexical/vector candidate search, scope expansion, reranking, and token budgeting
- `mcp-server`: Tools/resources and stdio/HTTP transports
- `daemon`: Ingest and management APIs, queue, and lifecycle
- `adapters`: Input conversion and context injection for Claude Code, Codex, and GJC
- `cli`: Installation, status, search, deletion, export, and sync commands
- `web`: Localhost management UI
- `sync-client` / `sync-service`: Optional remote synchronization

Client-specific differences do not spread beyond `adapters`; all inputs are converted to the shared event contract.

## 4. Data Model

### Project Identity

Paths can differ across worktrees and devices, so they are not used alone as identity.

- `project_id`: A SHA-256 fingerprint of the normalized set of Git remotes with credentials removed and the root commit
- `checkout`: The canonical repository path at the time of observation
- Repositories without a remote use the canonical path and root commit
- Branch names and HEAD commits are recorded in events and memories separately from the fingerprint

### Scope

```text
project
 ├─ repository
 │   ├─ worktree
 │   └─ branch/ref
 │       └─ commit
 └─ user-defined workspace
```

Events store the `project_id`, branch, `head_commit`, session ID, and provider event observed at that time. Because branch names can move or be deleted, commit IDs are the source of truth and branches are observational metadata.

### Primary Tables

- `events`, `memories`, `memory_evidence`
- `settings`, `outbox`, `tombstones`
- `memory_embeddings`
- FTS virtual table `memory_fts`

`events` is append-only for ordinary modifications; changes are represented as correction events. A privacy deletion hard-deletes raw evidence referenced only by the affected memory and leaves a tombstone. `memories` is a projection for retrieval; when a summary changes, FTS and vector data are updated or invalidated in the same transaction.

`memory_repository_evidence` stores structured evidence for files, symbols, commits, diffs, commands, and tests. `memories.validity` is separate from lifecycle `status`. For example, even an active memory can become `changed` when an evidence file changes or `branch-only` when it exists only on an unmerged branch.

## 5. Cross-Branch Search

Search scope expands in this order:

1. Memories linked directly to the current HEAD
2. Memories from the current branch
3. Project memories linked to ancestor commits of the current HEAD
4. Memories from other branches or worktrees with a nearby merge base
5. All project memories
6. If the user requests a branch, add that branch as a separately prioritized candidate source

An example candidate score is:

```text
score = lexical_or_hybrid_relevance
      + branch_affinity
      + commit_proximity
      + evidence_quality
      + recency_decay
      - superseded_penalty
```

The branch score is not a filter. Therefore, even when the current branch is active, a request about work on `feature/payments` can rank results from that branch highly based on semantic relevance. Results include a score explanation, source ref, and commit.

## 6. Collection and Automatic Injection

### Claude Code

Use the `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `Stop`, and `SessionEnd` hooks. A hook quickly forwards data to the local ingest API and exits; it does not run summarization or embedding synchronously. At `SessionStart` and around prompt submission, context from the current scope is injected within a bounded budget.

### Codex

The adapter uses official MCP and user/project configuration and consumes the available completion notifications and session-record integration points. It does not assume that Codex has the same lifecycle surfaces as Claude Code. Before implementation, a compatibility spike establishes:

- The extent to which user prompts and tool results can be collected using only official surfaces
- How automatic context is injected at session start
- Event differences among CLI, IDE, and non-interactive execution

The implementation does not couple itself to private file formats to obtain data unavailable through official surfaces. A Codex wrapper may be installed if necessary, but the UI clearly identifies items that cannot be collected.

### GJC

The verification plugin bundle converts the public `session_start`, `tool_result`, and `session_shutdown` hooks to the shared event contract. Because there are no public plugin hooks for prompts or agent-end events, the system does not assume it can collect them. Instead, the system appendix directs the session to retrieve context from `memory://context/current`.

## 7. Sensitive Information and Trust Boundaries

The processing order is `file policy → deterministic secret scanner → user rules → UTF-8 size limit → persistent storage`. Private-key blocks that end beyond the size boundary are removed from the full input first. Raw text is not written to a disk queue or ordinary logs before passing through this path.

Blocked by default:

- Private keys and private certificate material
- API tokens, bearer tokens, passwords, and connection strings
- `.env*`, keychain, SSH/GPG directories, and credential files
- High-entropy strings and provider-specific token formats
- User-defined globs, regular expressions, and JSON paths

Detection results record only the rule ID, location range, and hash, not the secret itself. The web UI displays a masked preview and the reason for blocking. The same filter is applied again to data sent to automatic extraction models.

Memories and original events are untrusted data. Commands embedded in retrieved text are not executed as system instructions, and the text is clearly isolated using delimiters such as XML or Markdown.

## 8. Remote Synchronization

Synchronization is opt-in per project. The local outbox incrementally transmits redacted events, memories, relationships, and tombstones.

- Detect omissions using a device ID and monotonically increasing local sequence
- Perform idempotent upserts by event ID
- Propagate deletions to all devices as tombstones
- Preserve all conflicting events rather than merging them
- Recalculate conflicts in derived memories using evidence and projector versions
- Store authentication tokens in the OS keychain
- Apply server-side envelope encryption and per-tenant key separation

End-to-end encryption conflicts with server-side search and is therefore handled as a separate mode. The initial managed service provides TLS and server-side encryption; in a future E2EE mode, clients will own the search index.

## 9. MCP Surface

Keep the initial MCP feature set small.

- `memory.search`: Search memories with evidence using a query and optional scope
- `memory.get`: Retrieve a memory and its original evidence
- `memory.record`: Record an explicit decision that adapters did not capture
- `memory.feedback`: Apply usefulness, error, and superseded feedback
- `memory.revalidate`: Revalidate repository evidence and validity against the current HEAD
- `memory.handoff`: Generate a handoff containing validated changes, tests, and unfinished work
- Resource `memory://context/current`: Context for injection in the current Git scope

Management, deletion, and synchronization settings live in the local management API and user UI rather than MCP so that an agent cannot change them arbitrarily.

## 10. Failure Handling and Observability

- If the daemon is unavailable, a hook exits after a short timeout without disrupting the work
- Use a bounded in-memory or secure spool; when capacity is exceeded, discard the oldest low-value events first and display the loss count
- Run the deterministic projector immediately after the collection transaction and retry failed events during spool replay; reindex embeddings idempotently only when their content hash changes
- Record only event IDs, sizes, statuses, and latency in logs, not event bodies
- Display collection status, filter block counts, queue state, last synchronization, and failure reasons in the UI

## 11. Validation Strategy

- Contract tests for the event schema and all three adapters
- Redaction corpus and bypass-pattern tests
- Branch, rename, detached HEAD, worktree, and remote-change tests in temporary Git repositories
- Retrieval ranking tests for current and superseded versions of the same memory
- Failure tests confirming that an agent session continues while the daemon is down
- FTS benchmark with 100,000 memories
- Synchronization tests covering offline edits on two devices, reconnection, and deletion propagation
- End-to-end smoke tests against real Claude Code, Codex, and GJC installations
