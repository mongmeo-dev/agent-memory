[English](architecture.md)

# 시스템 아키텍처

## 1. 설계 결정

| 항목 | 결정 | 이유 |
| --- | --- | --- |
| 구현 언어 | TypeScript/Node.js | MCP 공식 SDK v2, 어댑터와 웹 UI의 언어 통일 |
| 로컬 저장소 | SQLite + FTS5 | 설치 부담이 없고 트랜잭션·전문 검색 지원 |
| 원격 저장소 | 관리형 PostgreSQL | 다중 사용자·장치 동기화와 운영 도구 생태계 |
| 데이터 모델 | append-only 이벤트 + 파생 기억 | 원본 근거, 재처리, 충돌 해결 가능 |
| 검색 | FTS 우선, 선택적 벡터 검색 | 외부 모델 없이도 완결되고 점진적 확장 가능 |
| 통합 | 공통 daemon + 클라이언트 어댑터 | MCP만으로 관찰할 수 없는 lifecycle 수집 |
| 관리 UI | daemon이 제공하는 localhost 웹 UI | 별도 백엔드 없이 CLI와 API 공유 |

## 2. 구성요소

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

로컬 daemon이 자동 lifecycle 수집과 관리 API의 주 writer입니다. hook은 daemon을
먼저 사용하며 장애 시 redacted spool과 SQLite WAL 직접 기록으로 에이전트 작업을
계속합니다. stdio MCP와 관리 CLI도 같은 schema·정책을 사용하고 SQLite의
transaction/WAL로 동시 접근 일관성을 유지합니다.

## 3. 경계와 패키지

- `core`: 이벤트, 기억, scope와 정책 타입. transport나 DB에 의존하지 않음
- `storage-sqlite`: migration, event repository, memory repository, FTS index
- `git-context`: 저장소 identity, worktree, ref, HEAD와 commit graph 관계 계산
- `redaction`: 비밀값 탐지, 파일 제외 정책, 크기 제한
- `projector`: quality gate를 통과한 이벤트만 구조화된 기억으로 승격하고 저장소
  근거를 추출
- `memory-ci`: Git HEAD에서 파일 hash, symbol, commit과 테스트 근거를 재검증하고
  validity 갱신
- `handoff`: 검증된 변경, 검증 결과와 미완료 작업을 에이전트 간 전달 형식으로 조립
- `retrieval`: lexical/vector 후보 검색, scope 확장, 재정렬, token budget
- `mcp-server`: tools/resources와 stdio/HTTP transport
- `daemon`: ingest·management API, queue, lifecycle
- `adapters`: Claude Code, Codex, GJC별 입력 변환과 context 주입
- `cli`: 설치, 상태, 검색, 삭제, export, sync 명령
- `web`: localhost 관리 UI
- `sync-client` / `sync-service`: 선택적 원격 동기화

클라이언트별 차이는 `adapters` 밖으로 퍼지지 않으며 모든 입력은 공통 이벤트
계약으로 변환합니다.

## 4. 데이터 모델

### Project identity

경로는 worktree와 장치마다 달라질 수 있으므로 identity로 단독 사용하지 않습니다.

- `project_id`: 인증정보를 제거하고 정규화한 Git remote 집합과 root commit의
  SHA-256 fingerprint
- `checkout`: 관측 시점의 canonical 저장소 경로
- remote가 없는 저장소는 canonical 경로와 root commit을 사용
- branch 이름과 HEAD commit은 fingerprint와 분리해 이벤트·기억에 기록

### Scope

```text
project
 ├─ repository
 │   ├─ worktree
 │   └─ branch/ref
 │       └─ commit
 └─ user-defined workspace
```

이벤트는 관측 시점의 `project_id`, branch, `head_commit`, session ID와 provider
event를 저장합니다. 브랜치 이름은 이동하거나 삭제될 수 있으므로 commit ID가
사실의 기준이고 branch는 관측 metadata입니다.

### 주요 테이블

- `events`, `memories`, `memory_evidence`
- `settings`, `outbox`, `tombstones`
- `memory_embeddings`
- FTS virtual table `memory_fts`

`events`는 일반 수정에서 append-only이고 수정은 correction event로 표현합니다.
privacy 삭제는 해당 기억만 참조하는 evidence 원문을 hard-delete하고 tombstone을
남깁니다. `memories`는 검색을 위한 projection이며 FTS/vector는 summary 변경 시
같은 transaction에서 갱신·무효화합니다.

`memory_repository_evidence`는 파일·symbol·commit·diff·명령·테스트 근거를
구조화해 저장합니다. `memories.validity`는 lifecycle `status`와 분리합니다.
예를 들어 active 기억도 근거 파일이 변경되면 `changed`, 미병합 브랜치에만 있으면
`branch-only`가 될 수 있습니다.

## 5. 브랜치 횡단 검색

검색 scope를 다음 순서로 확장합니다.

1. 현재 HEAD에 직접 연결된 기억
2. 현재 브랜치의 기억
3. 현재 HEAD의 조상 commit에 연결된 프로젝트 기억
4. merge-base가 가까운 다른 branch/worktree 기억
5. 프로젝트 전체 기억
6. 사용자가 요청한 브랜치가 있으면 해당 브랜치를 별도 우선 후보로 추가

후보 점수 예시는 다음과 같습니다.

```text
score = lexical_or_hybrid_relevance
      + branch_affinity
      + commit_proximity
      + evidence_quality
      + recency_decay
      - superseded_penalty
```

브랜치 점수는 필터가 아닙니다. 따라서 현재 브랜치에서 `feature/payments` 작업을
요청해도 해당 브랜치 결과가 의미 관련도에 따라 상위로 올라올 수 있습니다. 결과에는
점수 설명, 출처 ref와 commit을 포함합니다.

## 6. 수집과 자동 주입

### Claude Code

`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `Stop`,
`SessionEnd` hook을 사용합니다. hook은 빠르게 로컬 ingest API에 전달한 뒤 종료하며
요약이나 임베딩을 동기 실행하지 않습니다. `SessionStart`와 프롬프트 전후에 현재
scope의 context를 제한된 budget으로 주입합니다.

### Codex

공식 MCP 및 사용자·프로젝트 설정을 사용하고, 제공되는 완료 알림과 session 기록
통합 지점을 어댑터가 소비합니다. Claude Code와 lifecycle 표면이 같다고 가정하지
않습니다. 구현 전 compatibility spike에서 다음을 확정합니다.

- 사용자 프롬프트와 tool result를 공식 표면만으로 수집 가능한 범위
- session 시작 시 자동 context 주입 방식
- CLI, IDE, 비대화형 실행 간 이벤트 차이

공식 표면으로 얻을 수 없는 데이터 때문에 비공개 파일 형식에 결합하지 않습니다.
필요하면 Codex wrapper를 설치하되 수집 불가능한 항목을 UI에 명시합니다.

### GJC

검증 plugin bundle이 공개 `session_start`, `tool_result`, `session_shutdown`을 공통
이벤트 계약으로 변환합니다. prompt/agent-end는 공개 plugin hook이 없으므로
수집한다고 가정하지 않습니다. 대신 system appendix가 세션 context를
`memory://context/current`에서 조회하도록 지시합니다.

## 7. 민감정보와 신뢰 경계

처리 순서는 `파일 정책 → deterministic secret scanner → 사용자 규칙 → UTF-8 크기
제한 → 영구 저장`입니다. 크기 경계 바깥에서 끝나는 private-key 블록도 전체 입력에서
먼저 제거합니다. 원문은 이 경로를 통과하기 전에 디스크 queue나 일반 로그에 쓰지
않습니다.

기본 차단 대상:

- private key와 인증서 private material
- API token, bearer token, password, connection string
- `.env*`, keychain, SSH/GPG 디렉토리, 인증 파일
- 고엔트로피 문자열과 공급자별 token 형식
- 사용자가 지정한 glob, 정규식, JSON path

탐지 결과에는 secret 자체가 아니라 rule ID, 위치 범위와 hash만 기록합니다. 웹 UI는
마스킹된 preview와 차단 이유를 보여줍니다. 자동 추출 모델에 보내는 데이터에도 같은
필터를 다시 적용합니다.

기억과 원본 이벤트는 신뢰할 수 없는 데이터입니다. 검색된 텍스트 안의 명령을
시스템 지시로 실행하지 않으며 XML/Markdown 같은 구분자로 명확히 격리합니다.

## 8. 원격 동기화

동기화는 프로젝트별 opt-in입니다. 로컬 outbox가 redaction을 마친 이벤트, 기억,
관계와 tombstone을 증분 전송합니다.

- 장치 ID와 단조 증가 local sequence로 누락을 탐지
- event ID로 멱등 upsert
- 삭제는 tombstone으로 모든 장치에 전파
- 이벤트 충돌은 병합하지 않고 모두 보존
- 파생 기억 충돌은 evidence와 projector version으로 재계산
- 인증 token은 OS keychain에 저장
- 서버 측 envelope encryption과 tenant별 key 분리를 적용

종단간 암호화는 서버 검색과 상충하므로 별도 모드로 다룹니다. 초기 관리형 서비스는
TLS + 서버 측 암호화를 제공하고, 향후 E2EE 모드에서는 클라이언트가 검색 인덱스를
소유하도록 설계합니다.

## 9. MCP 표면

초기 MCP 기능은 작게 유지합니다.

- `memory.search`: 질의와 선택 scope로 근거 포함 기억 검색
- `memory.get`: 기억과 원본 evidence 조회
- `memory.record`: 어댑터가 포착하지 못한 명시적 결정 기록
- `memory.feedback`: 유용성, 오류, superseded 상태 반영
- `memory.revalidate`: 현재 HEAD에서 저장소 근거와 validity 재검증
- `memory.handoff`: 검증된 변경·테스트·미완료 작업 handoff 생성
- resource `memory://context/current`: 현재 Git scope의 주입용 context

관리·삭제·동기화 설정은 에이전트가 임의로 수행하지 않도록 MCP가 아닌 로컬 관리
API와 사용자 UI에 둡니다.

## 10. 실패 처리와 관측성

- hook은 daemon 장애 시 짧은 timeout 후 작업을 방해하지 않고 종료
- bounded in-memory/secure spool을 사용하며 용량 초과 시 오래된 저가치 이벤트부터
  버리고 손실 수치를 표시
- deterministic projector는 수집 transaction 직후 실행하고 실패 이벤트는 spool
  replay에서 재시도합니다. embedding은 content hash로 변경분만 멱등 재색인합니다.
- 로그에는 event 본문 대신 ID, 크기, 상태, latency만 기록
- UI에서 수집 상태, 필터 차단 수, queue, 마지막 동기화, 실패 원인을 확인

## 11. 검증 전략

- 이벤트 schema와 세 어댑터의 contract test
- redaction corpus와 우회 패턴 테스트
- 임시 Git 저장소에서 branch, rename, detached HEAD, worktree, remote 변경 테스트
- 같은 기억의 current/superseded 검색 순위 테스트
- daemon 중단 중 에이전트 세션이 계속되는 failure test
- 10만 기억 기준 FTS benchmark
- 두 장치의 offline edit, 재연결, 삭제 전파 sync test
- Claude Code, Codex, GJC 실제 설치를 대상으로 한 end-to-end smoke test
