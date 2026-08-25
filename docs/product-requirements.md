[한국어](product-requirements.ko.md)

# Product Requirements

## 1. Goal

Remember project work performed in Claude Code, Codex, and GJC without requiring the user to issue a separate save command, then automatically restore the context needed for the current request in later sessions or other agents.

## 2. Target Users

- Individual developers working in parallel across multiple sessions and branches
- Developers who alternate between Claude Code, Codex, and GJC
- Users who want both local control of their data and synchronization across multiple devices

## 3. Scope

### Included

- Automatic collection and injection adapters for Claude Code, Codex, and GJC
- Collection of conversations, goals, plans, tool calls, command results, code changes, errors, decisions, and unfinished work
- Sensitive-information filtering before storage
- Memories scoped by project, worktree, branch, and commit
- Search across the current branch and other branches
- Local SQLite storage and optional managed remote synchronization
- Viewing, editing, deleting, exporting, and pausing collection through the CLI and local web UI
- Explicit retrieval and recording through MCP tools and resources

### Excluded from the Initial Scope

- Importing an agent provider's cloud conversation history through a separate API
- Providing the code repository itself as a general-purpose RAG index
- Organization-level permissions and audit policies
- Converting memories into automatically executed commands without supporting evidence

## 4. Core User Scenarios and Acceptance Criteria

### S1. Resume Work on the Same Branch

When a new session starts, recent goals, confirmed decisions, changes, causes of failures, and unfinished work must be available without a separate command.

- Every injected item has a memory ID and supporting events.
- Discarded or superseded decisions are not presented as current decisions.
- Injection failures do not prevent the agent session from starting, and the failures can be inspected in the UI.

### S2. Understand Work on Another Branch

Relevant memories must be found even when work from a branch other than the current branch is requested.

- Search is not forcibly restricted to the current branch.
- Results show the source branch, commit, and relationship to the current HEAD.
- For identical content, results from the current branch are preferred, followed by branches with a nearby common ancestor and then other branches, without omitting highly semantically relevant results.

### S3. Continuity Across Agents

Memories created in Claude Code must be retrievable by Codex and GJC.

- All three adapters use the same normalized event contract.
- Provider-specific fields are preserved in the original payload but are not exposed to the retrieval model.
- The same repository and branch are interpreted as the same scope regardless of agent type.

### S4. Protect Sensitive Information

Conversations and execution results must be persisted only after passing through filtering.

- Known token, private key, password, and connection string patterns are masked.
- Contents of `.env` files, certificates, and files matching user exclusion globs are not stored.
- Unfiltered source text is not retained in logs or error messages.
- Users can perform a dry-run inspection before storage and delete data after storage.

### S5. Optional Remote Synchronization

Remote synchronization is disabled by default and transmits data only for projects on which the user has enabled it.

- No network requests occur before synchronization is enabled.
- Synchronization is incremental, using a cursor for each device.
- On conflict, all events are preserved and derived memories are recalculated from the latest evidence.
- Local work continues when a connection fails, and retry status is displayed in the UI.

## 5. Functional Requirements

### Collection

- Adapters emit `session.started`, `prompt.submitted`, `tool.completed`, `tool.failed`, `turn.completed`, `session.ended`, and `git.context.changed` events to the extent available from each provider's public lifecycle surfaces.
- GJC's public plugin surface emits session start/end and tool results; prompt context is injected through a system appendix and an MCP resource.
- Event IDs guarantee idempotent processing.
- Large outputs use size limits and content hashes and are not stored without bounds.
- Source and ingest timestamps are preserved even when events arrive out of order.

### Memory Extraction

The initial set of memory types is limited to `goal`, `decision`, `change`, `problem`, `solution`, `constraint`, `todo`, and `fact`.

- A memory has a summary, structured fields, supporting events, a valid scope, and a status.
- Status is one of `active`, `superseded`, `resolved`, or `deleted`.
- If LLM extraction fails, the original event remains available for reprocessing.
- Whether to use a remote LLM, and which provider to use, is the user's choice.
- Simple lookups and repetitive output remain only in the event archive; only code changes, explicit decisions, failures and solutions, test results, and unfinished work are promoted to durable memory.
- A memory has an `explicit`, `inferred`, or `repository` provenance and a confidence score from 0 to 1.

### Memory Validation and Handoff

- Files, symbols, commits, diffs, commands, and tests are linked to memories as structured evidence.
- Evidence is revalidated against the current HEAD and assigned a validity of `verified`, `changed`, `contradicted`, `branch-only`, `orphaned`, or `unverified`.
- Deterministic checks run at session start and when Git context changes; semantic conflict checks are an optional subsequent layer.
- Memories with `contradicted` or `orphaned` validity are excluded from automatic context injection.
- A handoff is generated as a bounded document containing goals, validated changes and decisions, validation commands, unfinished work, and the current branch and HEAD information.

### Search and Injection

- SQLite FTS5, scope filters, and Git relationship scores provide the default search.
- Optional embedding search results are combined using reciprocal rank fusion.
- Search results are reranked by relevance, recency, branch affinity, and evidence confidence.
- Automatic injection is limited by both a token budget and an item count.
- Memory bodies and untrusted original text are not treated as system instructions.

### Management

- The CLI and web UI use the same local API.
- They support search, detailed evidence inspection, editing, deletion, export, pausing collection, and synchronization status inspection.
- Deletion propagates to local derived data and remote tombstones.

## 6. Non-Functional Requirements

- Target p95 latency for local search is at most 200 ms with 100,000 memories on typical development hardware.
- The synchronous path of a collection hook has a p95 latency of at most 50 ms; extraction runs asynchronously.
- A local service failure must not block the agent's primary work.
- The database provides schema versioning and atomic migrations.
- macOS and Linux are supported first; Windows validation follows later.
- All external transmission uses TLS, and credentials are stored in the OS keychain.

## 7. Product Phases

1. **Local core**: event contract, SQLite, filtering, Git scope, FTS search, MCP server, and CLI
2. **Automatic integration**: Claude Code, Codex, and GJC adapters with automatic context injection
3. **Management experience**: local web UI, editing, deletion, pause controls, and filter inspection
4. **Advanced search**: optional local or remote embeddings and hybrid reranking
5. **Synchronization service**: accounts, encryption, managed PostgreSQL, and multi-device synchronization

Each phase must produce a working product using only the preceding phases; neither a remote service nor embeddings may become a prerequisite for local memory.
