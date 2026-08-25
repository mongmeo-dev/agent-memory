# agents-memory

`agents-memory`는 Claude Code, Codex, GJC가 프로젝트별 작업 맥락을 세션과
에이전트 경계를 넘어 공유하도록 만드는 로컬 우선(local-first) MCP 서버입니다.

완성된 제품에서는 사용자가 기억 저장을 직접 지시하지 않아도 클라이언트별
어댑터가 세션, 프롬프트, 도구 실행과 작업 결과를 수집하고 검색 가능한 장기
기억으로 정리합니다. 현재 구현 범위와 제한은 [현재 구현](#현재-구현)에 명시합니다.

## 제품 원칙

- **로컬 우선**: 기본 저장소는 로컬 SQLite이며 원격 전송은 사용자가 활성화한
  경우에만 수행합니다.
- **보이지 않는 연속성**: 세션 시작과 작업 중 필요한 기억을 자동으로 주입합니다.
- **근거가 있는 기억**: 모든 기억에 원본 이벤트, 프로젝트, 브랜치, 커밋, 생성
  시각과 생성 에이전트를 연결합니다.
- **브랜치 인식**: 현재 브랜치의 기억을 우선하면서 프로젝트 내 다른 브랜치의
  관련 작업도 검색합니다.
- **통제 가능성**: 사용자는 CLI와 웹 UI에서 기억을 조회, 수정, 삭제하고 수집과
  동기화를 중지할 수 있습니다.
- **기본 비공개**: 저장 전에 비밀값과 사용자 정의 제외 대상을 제거합니다.

## 작동 원리

1. Claude Code hook, Codex 통합, GJC native adapter가 작업 이벤트를 로컬 수집기에
   전달합니다.
2. 수집기는 이벤트를 정규화하고 민감정보 필터를 적용한 후 append-only 이벤트
   저장소에 기록합니다.
3. 비동기 처리기가 이벤트에서 목표, 결정, 변경, 오류, 해결책과 미완료 작업을
   구조화된 기억으로 추출합니다.
4. 검색기는 전문 검색, 메타데이터 필터와 선택적 벡터 검색을 결합합니다.
5. 현재 Git 브랜치와 커밋 관계를 반영해 결과를 재정렬하고 에이전트에 필요한
   근거와 함께 제공합니다.
6. 선택적으로 암호화된 변경분을 관리형 원격 서비스와 동기화합니다.

MCP 서버만으로는 클라이언트 대화를 수동으로 관찰할 수 없으므로 자동 수집에는
클라이언트별 어댑터가 필요합니다. Claude Code는 세션·턴·도구 호출 lifecycle
hook을 제공하며, Codex는 MCP 설정과 완료 알림 통합 지점을 제공합니다. GJC는
동일한 이벤트 계약을 native adapter로 구현합니다.

## 기술 방향

- TypeScript, Node.js
- MCP TypeScript SDK v2 (`@modelcontextprotocol/server`)
- SQLite + FTS5
- 선택적 임베딩 인덱스
- 관리형 PostgreSQL 호환 원격 서비스
- 로컬 웹 UI와 CLI

TypeScript를 선택한 이유는 공식 MCP SDK v2가 서버·클라이언트, stdio,
Streamable HTTP, 인증 도구를 함께 제공하고 Node.js에서 클라이언트 어댑터와 웹
UI를 하나의 언어로 구현할 수 있기 때문입니다. 임베딩은 초기 동작의 필수조건으로
두지 않고 정확 검색이 먼저 완결되도록 설계합니다.

## 현재 구현

첫 번째 로컬 vertical slice가 구현되어 있습니다.

- Git remote와 root commit을 기반으로 프로젝트를 식별하고 브랜치·HEAD를 기록
- SQLite append-only 이벤트 저장소와 FTS5 기억 검색
- 저장 전 token, 비밀번호, private key, 연결 URL 인증정보 제거
- 현재 브랜치를 우선하면서 프로젝트의 다른 브랜치도 반환
- `memory.ingest`, `memory.record`, `memory.search`, `memory.get` MCP 도구
- 동일 기능을 검증하고 운영할 수 있는 CLI
클라이언트별 자동 수집 어댑터, 자동 기억 추출, 웹 UI와 원격 동기화는 아직 구현되지 않았습니다.

## 빠른 시작

Node.js 24 이상이 필요합니다.

```bash
npm install
npm run build
node dist/cli.js setup all
```

`setup all`은 설치되어 있는 Claude Code, Codex, GJC를 찾아 사용자 범위에
`agents-memory` MCP 서버를 등록합니다. 설치되지 않은 클라이언트는 오류로
중단하지 않고 `skipped` 상태로 표시합니다.

등록 전에 실행될 명령만 확인할 수도 있습니다.

```bash
node dist/cli.js setup all --dry-run
```

설정 명령은 현재 Node 실행 파일과 `dist/mcp.js`의 절대 경로를 저장합니다. 저장소를
옮기거나 Node 설치 경로를 변경한 경우 `npm run build`와 `setup`을 다시 실행해야 합니다.

## MCP 클라이언트 설정

### 자동 설정

```bash
# 세 클라이언트 중 설치된 항목을 사용자 범위에 등록
node dist/cli.js setup all

# 하나의 클라이언트만 등록
node dist/cli.js setup claude
node dist/cli.js setup codex
node dist/cli.js setup gjc

# 프로젝트 범위에 등록
node dist/cli.js setup claude --scope project
node dist/cli.js setup gjc --scope project

# 별도 데이터베이스 사용
node dist/cli.js setup all --database /absolute/path/memory.db
```

지원하는 scope는 다음과 같습니다.

| 클라이언트 | `user` | `project` |
| --- | --- | --- |
| Claude Code | 지원 | 지원 |
| Codex | 지원 | CLI 미지원으로 건너뜀 |
| GJC | 지원 | 지원 |

설정을 반복 실행하면 같은 scope의 기존 `agents-memory` 등록을 제거한 뒤 현재
실행 경로로 다시 등록합니다. 다른 이름의 MCP 서버 설정은 변경하지 않습니다.

등록 결과는 JSON 배열로 출력됩니다.

- `configured`: 등록 완료
- `planned`: `--dry-run`으로 실행 예정 명령만 생성
- `skipped`: 클라이언트가 없거나 scope를 지원하지 않음
- `failed`: 클라이언트 명령은 존재하지만 등록 실패

### 수동 설정

자동 설정을 사용하지 않을 때는 저장소 루트에서 다음 명령을 실행합니다.

```bash
# Claude Code
claude mcp add --scope user agents-memory -- "$(command -v node)" "$PWD/dist/mcp.js"

# Codex
codex mcp add agents-memory -- "$(command -v node)" "$PWD/dist/mcp.js"

# GJC
gjc mcp add agents-memory --force \
  --command "$(command -v node)" \
  --arg "$PWD/dist/mcp.js"
```

등록 확인 명령:

```bash
claude mcp get agents-memory
codex mcp get agents-memory
gjc mcp list
```

## MCP 도구

| 도구 | 용도 | 주요 입력 |
| --- | --- | --- |
| `memory.ingest` | 필터링한 원본 작업 이벤트 저장 | `type`, `content`, `agent`, `cwd` |
| `memory.record` | 구조화된 장기 기억과 근거 이벤트 생성 | `kind`, `summary`, `agent`, `cwd` |
| `memory.search` | 현재 프로젝트 전체에서 FTS 검색 | `query`, `cwd`, `branch`, `limit` |
| `memory.get` | 기억 ID로 본문과 근거 이벤트 ID 조회 | `id` |

`memory.record`가 지원하는 기억 종류:

- `goal`: 작업 목표
- `decision`: 기술·제품 결정
- `change`: 중요한 변경
- `problem`: 확인된 문제
- `solution`: 문제 해결 방법
- `constraint`: 반드시 지켜야 하는 제약
- `todo`: 남은 작업
- `fact`: 프로젝트에서 확인된 사실

현재는 자동 수집 어댑터가 없으므로 에이전트가 MCP 도구를 호출해야 기억이
생성됩니다. 예를 들어 에이전트에 “이 결정을 프로젝트 기억으로 저장해”라고
요청하면 `memory.record`를 사용할 수 있습니다.

## CLI 사용법

CLI는 MCP와 같은 SQLite 저장소와 Git scope 판별 코드를 사용합니다.

```bash
# 현재 프로젝트 ID, 저장소 루트, 브랜치와 HEAD 확인
node dist/cli.js context

# 장기 기억 생성
node dist/cli.js record decision "SQLite를 로컬 저장소로 사용한다"
node dist/cli.js record todo "Claude Code 자동 수집 hook을 구현한다" --agent developer

# 현재 프로젝트의 기억 검색
node dist/cli.js search "로컬 저장소"

# 다른 브랜치를 우선해 검색
node dist/cli.js search "결제 재시도" --branch feature/payments --limit 20

# 원본 이벤트만 저장
node dist/cli.js ingest tool.completed "npm test: 12 tests passed" --agent codex

# ID로 기억 조회
node dist/cli.js get 00000000-0000-0000-0000-000000000000
```

`--cwd PATH`를 사용하면 현재 디렉터리 대신 지정한 checkout의 Git context로
처리합니다.

## 데이터 저장과 프로젝트 구분

기본 데이터베이스 경로는 다음과 같습니다.

```text
~/.agents-memory/memory.db
```

CLI와 MCP 프로세스 모두 `AGENTS_MEMORY_DB` 환경 변수를 지원합니다.

```bash
AGENTS_MEMORY_DB=/absolute/path/memory.db node dist/cli.js search "검색어"
```

프로젝트 ID는 다음 정보의 SHA-256 hash입니다.

1. 인증정보를 제거하고 정규화한 Git remote URL 집합
2. 저장소의 root commit

따라서 같은 저장소의 다른 checkout과 worktree는 같은 프로젝트로 인식합니다.
브랜치 이름과 HEAD commit은 각 이벤트와 기억에 별도로 저장합니다. Git 저장소가
아니면 canonical 절대 경로를 기반으로 프로젝트 ID를 생성합니다.

검색은 프로젝트 ID를 경계로 삼습니다. 현재 브랜치 결과를 우선하지만 다른 브랜치
결과도 제외하지 않습니다. `--branch` 또는 MCP의 `branch` 입력이 있으면 요청한
브랜치를 현재 브랜치보다 먼저 반환합니다.

## 민감정보 처리

입력은 SQLite에 기록되기 전에 deterministic filter를 통과합니다.

현재 제거 대상:

- PEM private key 블록
- Bearer token
- GitHub token과 `sk-` 형태 token
- `api_key`, `access_token`, `password`, `secret` 형태의 설정값
- 사용자명과 비밀번호가 포함된 연결 URL

이벤트 본문은 최대 262,144자로 제한됩니다. 데이터베이스 디렉터리는 생성 시
사용자만 접근할 수 있도록 `0700` mode를 요청합니다.

현재 필터는 모든 비밀값 형식을 보장하지 않습니다. 파일 glob 제외, 사용자 정의
필터 규칙, 저장 전 dry-run과 기존 데이터 정리 기능은 아직 구현되지 않았습니다.
민감한 원문을 의도적으로 `memory.record`에 전달하면 안 됩니다.

## 개발

```bash
npm install
npm run check
npm run lint
npm run format
npm run format:check
npm test
npm run build
```

코드 포맷과 lint는 Biome을 사용합니다.

- `npm run check`: TypeScript 타입 검사 후 Biome lint·format·import 검사
- `npm run lint`: Biome lint만 실행
- `npm run format`: 파일을 Biome 형식으로 수정
- `npm run format:check`: 파일 변경 없이 format 상태 확인
- `npm test`: Vitest 단위·통합 테스트
- `npm run build`: 배포 파일을 `dist/`에 생성

## 문제 해결

### `MCP 서버를 찾을 수 없습니다`

`setup` 전에 빌드가 필요합니다.

```bash
npm run build
node dist/cli.js setup all
```

### MCP 클라이언트에서 서버가 시작되지 않음

등록된 Node와 MCP 파일 경로를 확인하고 설정을 갱신합니다.

```bash
node dist/cli.js setup all --dry-run
node dist/cli.js setup all
```

Node.js 24 미만에서는 내장 `node:sqlite`를 사용할 수 없으므로 Node.js를
업그레이드해야 합니다.

### 기억이 검색되지 않음

`context`로 현재 프로젝트 ID와 브랜치를 확인합니다. remote URL 또는 root commit이
다르면 별도 프로젝트로 처리됩니다.

```bash
node dist/cli.js context
node dist/cli.js search "기억에 포함된 단어"
```

FTS 검색은 현재 의미 검색이 아니라 token 기반 전문 검색입니다. 기억에 없는
동의어만 사용하면 결과가 나오지 않을 수 있습니다.

## 기획 문서

- [제품 요구사항](docs/product-requirements.md)
- [시스템 아키텍처](docs/architecture.md)

## 근거 자료

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk):
  v2는 2026-07-28 MCP 명세를 구현하며 서버·클라이언트와 주요 transport를
  제공합니다.
- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks):
  `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd` 등 자동
  수집에 필요한 lifecycle 이벤트를 제공합니다.
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference):
  사용자·프로젝트 설정, MCP 구성 및 작업 완료 알림 명령 통합 지점을 제공합니다.
