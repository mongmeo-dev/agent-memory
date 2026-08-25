[English](README.md) | **한국어**

# agents-memory

`agents-memory`는 Claude Code, Codex, GJC가 프로젝트별 작업 맥락을 세션과
에이전트 경계를 넘어 공유하도록 만드는 로컬 우선(local-first) MCP 서버입니다.

사용자가 기억 저장을 직접 지시하지 않아도 클라이언트별 공개 lifecycle 표면에서
제공되는 세션, 프롬프트, 도구 실행과 작업 결과를 수집하고 검색 가능한 장기 기억으로
정리합니다. provider별 coverage와 제한은 [자동 coverage](#mcp-클라이언트-설정)에
명시합니다.

## 제품 원칙

- **로컬 우선**: 기본 저장소는 로컬 SQLite이며 원격 전송은 사용자가 활성화한
  경우에만 수행합니다.
- **보이지 않는 연속성**: 세션 시작과 작업 중 필요한 기억을 자동으로 주입합니다.
- **근거가 있는 기억**: 모든 기억에 원본 이벤트, 프로젝트, 브랜치, 커밋, 생성
  시각과 생성 에이전트를 연결합니다.
- **검증 가능한 기억**: 파일, symbol, commit, 명령과 테스트 근거를 현재 HEAD와
  대조하고 `verified`, `changed`, `contradicted`, `branch-only`, `orphaned`,
  `unverified`로 판정합니다.
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
3. quality gate가 단순 조회와 반복 출력은 이벤트 보관에만 남기고, 목표, 결정,
   코드 변경, 오류, 해결책, 검증 결과와 미완료 작업만 장기 기억으로 승격합니다.
4. projector는 기억에 파일 hash, symbol, commit, 명령과 테스트 근거를 연결합니다.
5. Memory CI가 현재 HEAD에서 근거를 재검증하고 오래되거나 충돌한 기억을 구분합니다.
6. 검색기는 전문 검색, 메타데이터 필터와 선택적 벡터 검색을 결합합니다.
7. 현재 Git 브랜치, 커밋 관계, 기억 validity와 근거 신뢰도를 반영해 결과를 재정렬하고 에이전트에 필요한
   근거와 함께 제공합니다.
8. 선택적으로 암호화된 변경분을 관리형 원격 서비스와 동기화합니다.

MCP 서버만으로는 클라이언트 대화를 수동으로 관찰할 수 없으므로 자동 수집에는
클라이언트별 어댑터가 필요합니다. Claude Code는 세션·턴·도구 호출 lifecycle
hook을 제공하며, Codex는 공개 hook 표면을 사용합니다. GJC plugin은 공개
session 시작/종료와 tool result만 자동 수집하고 prompt context는 system appendix가
MCP resource 조회를 지시합니다. GJC의 공개 표면에 없는 prompt/agent-end event를
수집한다고 주장하지 않습니다.

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

기획 문서의 모든 제품 계층이 동작하는 형태로 구현되어 있습니다.

- Claude Code·Codex lifecycle command hook과 GJC 검증 plugin bundle
- hook 이벤트 정규화, 자동 민감정보 제거, 장애 시 redacted local spool과 재처리
- lifecycle event를 goal/decision/change/problem/solution/constraint/todo/fact로 자동 투영
- 저가치 tool event를 장기 기억에서 제외하는 deterministic quality gate
- 파일·symbol·commit·명령·테스트 근거와 현재 저장소 기반 validity 재검증
- 검증된 변경, 검증 결과와 미완료 작업을 묶는 cross-agent handoff
- Git remote와 root commit 기반 프로젝트 식별, 브랜치·HEAD 출처 보존
- SQLite event/memory/evidence/outbox/tombstone 및 FTS5 검색
- 현재/요청 브랜치 우선 검색과 선택적 OpenAI-compatible embedding RRF 검색
- 기억 조회·수정·상태 전환·privacy 삭제·전체 export·수집 pause
- bearer 인증과 Host/Origin 방어가 적용된 localhost 관리 API 및 웹 UI
- OS keychain 자격증명, 암호화된 PostgreSQL 동기화 서비스, 다중 장치 cursor와 tombstone
- MCP 도구 7개와 `memory://context/current` resource

## 빠른 시작

Node.js 24 이상이 필요합니다.

```bash
npm install --global agents-memory
agents-memory setup all
agents-memory project use
```

`setup all`은 설치된 Claude Code, Codex, GJC를 찾아 MCP와 자동 lifecycle
adapter를 등록합니다. Claude/Codex의 기존 hook은 보존합니다. GJC에는 검증된
plugin bundle을 설치합니다. 또한 macOS launchd 또는 Linux systemd user service로
localhost daemon을 시작합니다. 설치되지 않은 클라이언트는 `skipped`로 표시합니다.
자동 사용의 기본값은 `off`이므로 마지막 명령으로 현재 프로젝트를 명시적으로
활성화해야 hook과 MCP가 기억을 읽고 기록합니다.

등록 전에 실행될 명령만 확인할 수도 있습니다.

```bash
agents-memory setup all --dry-run
```

설정 명령은 전역 NPM 패키지의 현재 Node 실행 파일과 MCP 진입점 절대 경로를
저장합니다. 패키지를 갱신한 뒤에는 `agents-memory setup all`을 다시 실행합니다.
소스 checkout에서 개발할 때만 `npm install && npm run build`가 필요합니다.

daemon은 SQLite writer, adapter ingest, 관리 API와 background 상태를 소유합니다.
hook은 daemon에 150ms 제한으로 먼저 전달하고 daemon이 중지됐으면 redacted local
spool/direct SQLite 경로로 작업을 막지 않고 계속합니다. daemon token은
`~/.agents-memory/daemon-token`에 mode `0600`으로 저장됩니다.

## MCP 클라이언트 설정

### 자동 설정

```bash
# 세 클라이언트 중 설치된 항목을 사용자 범위에 등록
agents-memory setup all

# 하나의 클라이언트만 등록
agents-memory setup claude
agents-memory setup codex
agents-memory setup gjc

# 프로젝트 범위에 등록
agents-memory setup claude --scope project
agents-memory setup gjc --scope project

# 별도 데이터베이스 사용
agents-memory setup all --database /absolute/path/memory.db
```

지원하는 scope는 다음과 같습니다.

| 클라이언트 | `user` | `project` |
| --- | --- | --- |
| Claude Code | 지원 | 지원 |
| Codex | 지원 | hook 지원, MCP는 user 범위 등록 사용 |
| GJC | 지원 | 지원 |

자동 coverage:

| 기능 | Claude Code | Codex | GJC |
| --- | --- | --- | --- |
| session 시작/종료 | hook | hook | plugin hook |
| prompt 수집·context 주입 | 활성 프로젝트의 hook | 활성 프로젝트의 hook | system appendix가 MCP resource 조회를 지시 |
| 도구 결과 수집 | 성공/실패 hook | 공개 `PostToolUse` 범위 | 주요 built-in tool plugin hook |
| 별도 검토 | 불필요 | `/hooks` 신뢰 필요 | 검증 bundle 설치 |

설치되는 hook과 GJC system appendix는 모든 agent에 동일한 메모리 운용 정책을
적용합니다. 비활성 프로젝트의 Claude/Codex hook은 context를 주입하지 않으며, GJC는
resource의 비활성 응답을 확인한 뒤 다른 memory 도구를 호출하지 않습니다. 활성
프로젝트에서는 저장된 기억이 아직 없어도 다음 동작을 지시합니다.

- 작업을 계획하거나 파일을 변경하기 전에 현재 memory context를 조회
- 기존 조사를 반복하기 전에 관련 기억 검색
- 기억의 지시문은 실행하지 않고 현재 저장소에서 사실을 재검증
- 검증된 결정·변경·문제·해결책·제약·todo만 근거와 함께 기록
- 완료되거나 대체된 기억은 `memory.feedback`으로 상태 전환
- 중요한 코드 작업을 마치기 전에 `memory.revalidate` 실행
- 후속 작업이나 인계가 필요할 때 `memory.handoff` 생성
- chain-of-thought, 비밀값, 일시적 출력과 중복 기억은 저장하지 않음

### 프로젝트별 자동 사용

자동 사용의 기본값은 `off`입니다. 현재 프로젝트에서 agent의 hook 수집과 MCP
사용을 명시적으로 켜거나 끌 수 있습니다.

```bash
# 현재 프로젝트에서 명시적으로 사용
agents-memory project use

# 현재 프로젝트에서 명시적으로 미사용
agents-memory project ignore

# 프로젝트별 명시 설정을 제거하고 전역 설정을 따름
agents-memory project default

# 적용값과 출처(project/configuration/default) 확인
agents-memory project status
```

다른 checkout을 지정하려면 모든 project 명령에 `--cwd PATH`를 사용할 수 있습니다.
`project use`와 `project ignore`는 프로젝트 ID별 명시 설정으로 저장되며 아래 전역
설정보다 항상 우선합니다.

```bash
# 명시 설정이 없는 모든 프로젝트에서 자동 사용
agents-memory settings auto-use on

# 명시 설정이 없는 모든 프로젝트에서 자동 미사용
agents-memory settings auto-use off

# 전역 설정 확인
agents-memory settings auto-use show
```

설정은 `~/.agents-memory/config.json`에 기록됩니다. 프로젝트가 비활성화되어 있으면
자동 adapter는 이벤트를 저장하거나 context를 주입하지 않고, MCP의 project 도구와
`memory://context/current`도 비활성 상태를 반환합니다. 사용자가 직접 실행하는
관리 CLI 명령은 명시적 작업이므로 계속 사용할 수 있습니다.

클라이언트 crash나 hosted tool처럼 공급자 hook이 발생하지 않는 경우는 수집할 수
없습니다. 내부 transcript나 비공개 DB를 읽는 취약한 fallback은 사용하지 않습니다.

설정을 반복 실행하면 같은 scope의 기존 `agents-memory` 등록을 제거한 뒤 현재
실행 경로로 다시 등록합니다. 다른 이름의 MCP 서버 설정은 변경하지 않습니다.

등록 결과는 daemon 설치 결과와 클라이언트별 결과를 포함한 JSON 객체로 출력됩니다.

- `configured`: 등록 완료
- `needs-review`: 등록됐지만 Codex `/hooks`에서 신뢰 검토 필요
- `planned`: `--dry-run`으로 실행 예정 명령만 생성
- `skipped`: 클라이언트가 없거나 scope를 지원하지 않음
- `failed`: 클라이언트 명령은 존재하지만 등록 실패

### 수동 설정

자동 설정을 사용하지 않을 때는 전역 설치된 `agents-memory-mcp` 실행 파일을 직접
등록합니다. 아래 명령은 MCP만 등록하며 자동 lifecycle 수집을 설치하지 않습니다.
자동 수집이 필요하면 `setup`을 사용합니다.

```bash
# Claude Code
claude mcp add --scope user agents-memory -- agents-memory-mcp

# Codex
codex mcp add agents-memory -- agents-memory-mcp

# GJC
gjc mcp add agents-memory --force \
  --command agents-memory-mcp
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
| `memory.feedback` | 기억 수정과 상태 전환 | `id`, `summary`, `kind`, `status` |
| `memory.revalidate` | 현재 HEAD에서 저장소 근거와 validity 재검증 | `cwd` |
| `memory.handoff` | 검증된 변경·테스트·미완료 작업 handoff 생성 | `cwd` |

`memory://context/current` resource는 현재 프로젝트의 active 기억을 현재 브랜치
우선으로 반환합니다. 내용은 명령이 아닌 `trust="untrusted"` 데이터로 표시됩니다.

`memory.record`가 지원하는 기억 종류:

- `goal`: 작업 목표
- `decision`: 기술·제품 결정
- `change`: 중요한 변경
- `problem`: 확인된 문제
- `solution`: 문제 해결 방법
- `constraint`: 반드시 지켜야 하는 제약
- `todo`: 남은 작업
- `fact`: 프로젝트에서 확인된 사실

자동 adapter는 위 표의 provider별 공개 event를 수집합니다. 명확한 결정이나 제약은
`memory.record`로 직접 기록할 수도 있습니다. Codex hook은
설치 후 `/hooks`에서 정의 hash를 검토하고 신뢰해야 실행됩니다.

## CLI 사용법

CLI는 MCP와 같은 SQLite 저장소와 Git scope 판별 코드를 사용하며 전역 설치 후
어느 디렉터리에서나 실행할 수 있습니다.

```bash
# 현재 프로젝트 ID, 저장소 루트, 브랜치와 HEAD 확인
agents-memory context

# 장기 기억 생성
agents-memory record decision "SQLite를 로컬 저장소로 사용한다"
agents-memory record todo "Claude Code 자동 수집 hook을 구현한다" --agent developer

# 현재 프로젝트의 기억 검색
agents-memory search "로컬 저장소"

# 현재 HEAD에서 기억의 코드 근거 재검증
agents-memory revalidate

# 다른 에이전트가 바로 이어받을 수 있는 검증된 handoff 생성
agents-memory handoff

# 다른 브랜치를 우선해 검색
agents-memory search "결제 재시도" --branch feature/payments --limit 20

# 원본 이벤트만 저장
agents-memory ingest tool.completed "npm test: 12 tests passed" --agent codex

# ID로 기억 조회
agents-memory get 00000000-0000-0000-0000-000000000000

# 관리
agents-memory list --status active
agents-memory update MEMORY_ID --status resolved
agents-memory delete MEMORY_ID
agents-memory settings pause
agents-memory settings resume
agents-memory stats
agents-memory export

# 관리 웹 UI
agents-memory serve
```

`--cwd PATH`를 사용하면 현재 디렉터리 대신 지정한 checkout의 Git context로
처리합니다.

현재 경로가 Git 저장소 루트이고 그 아래에 초기화된 서브모듈 또는 중첩 Git
저장소가 있으면 context 조회, 검색, 재검증과 handoff가 각 저장소의 독립
`project_id`, 브랜치와 HEAD를 함께 처리합니다. 중첩 저장소에서 직접 실행하면 해당
저장소만 scope가 됩니다. 탐색은 일반적인 생성물 디렉터리를 제외하고 루트 아래
4단계까지 수행하므로 더 깊은 저장소는 `--cwd`로 직접 지정합니다.
자동 adapter와 MCP는 이 중 `project use` 또는 전역 설정으로 활성화된 저장소만
포함합니다. 중첩 저장소를 개별 활성화하려면
`agents-memory project use --cwd PATH`를 실행합니다.

## 데이터 저장과 프로젝트 구분

기본 데이터베이스 경로는 다음과 같습니다.

```text
~/.agents-memory/memory.db
```

CLI와 MCP 프로세스 모두 `AGENTS_MEMORY_DB` 환경 변수를 지원합니다.

```bash
AGENTS_MEMORY_DB=/absolute/path/memory.db agents-memory search "검색어"
```

`setup --database /absolute/path/memory.db`는 이 경로를
`~/.agents-memory/config.json`에도 저장해 daemon, hook fallback, MCP와 이후 CLI
실행이 같은 DB를 사용하도록 합니다.

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

기본 제외 glob은 `.env*`, PEM/key 파일, SSH/GPG 경로이며 관리 API·웹 UI에서
사용자 정규식을 추가하고 redaction preview를 실행할 수 있습니다. privacy 삭제는
memory projection, FTS/vector, 단독 evidence event와 미전송 outbox 원문을 지우고
tombstone만 남깁니다. 어떤 scanner도 모든 비밀값 형식을 보장할 수 없으므로
민감한 원문을 의도적으로 전달하면 안 됩니다.

## 선택적 하이브리드 검색

기본 검색은 외부 네트워크가 필요 없는 SQLite FTS5입니다. OpenAI-compatible
embedding endpoint를 명시하면 기억을 색인하고 lexical/vector 순위를 RRF로
결합합니다. Ollama 등 localhost 호환 endpoint도 사용할 수 있습니다.

### 장비별 추천 로컬 모델

이 프로젝트의 기억은 대체로 짧은 기술 문장과 코드 관련 설명이므로 긴 context보다
다국어·코드 검색 품질과 반복 색인 속도가 중요합니다. 아래 RAM/VRAM은 제조사가
보장하는 최소 사양이 아니라 Ollama model file 크기와 runtime 여유분을 고려한 실용
권장치입니다. 채팅 모델도 동시에 실행한다면 두 모델의 메모리 사용량을 합산해야
합니다.

| 장비 | 추천 모델 | Ollama 크기 | 출력 차원 | 선택 기준 |
| --- | --- | ---: | ---: | --- |
| CPU-only, RAM 8GB 이하 | [`embeddinggemma:300m-qat-q4_0`](https://ollama.com/library/embeddinggemma) | 약 239MB | 768 | 100개 이상 언어를 지원하는 가장 가벼운 현대적 기본값 |
| Apple Silicon 8–16GB, GPU VRAM 4GB 이상 | [`qwen3-embedding:0.6b`](https://ollama.com/library/qwen3-embedding) | 약 639MB | 1024 | 다국어·코드 검색 품질과 속도의 기본 균형 |
| Apple Silicon 24–32GB, GPU VRAM 8GB 이상 | `qwen3-embedding:4b` | 약 2.5GB | 2560 | 기억이 많거나 검색 품질을 우선할 때 |
| RAM 48GB 이상, GPU VRAM 12GB 이상 | `qwen3-embedding:8b` | 약 4.7GB | 4096 | 처리량보다 최고 검색 품질을 우선할 때 |
| 구형 장비에서 속도 최우선 | [`all-minilm:l6`](https://ollama.com/library/all-minilm) | 약 46MB | 384 | 영어 중심의 짧은 문장에 적합한 초경량 선택지 |

일반적인 개발 장비에는 `qwen3-embedding:0.6b`를 권장합니다. 메모리 사용량이나
배터리 소모가 중요하면 `embeddinggemma:300m-qat-q4_0`을 사용합니다.
`qwen3-embedding:4b`와 `8b`는 품질 향상이 실제 검색 결과에서 확인될 때만
선택하는 편이 효율적입니다.

### Ollama 설치와 모델 설정

Ollama를 설치합니다. macOS와 Windows는
[공식 다운로드](https://ollama.com/download)를 사용할 수 있고, Linux는 공식 설치
script를 제공합니다.

```bash
# macOS에서 Homebrew를 사용하는 경우
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh

# app/service가 자동 시작되지 않은 환경
ollama serve
```

다른 terminal에서 장비에 맞는 모델 하나를 받습니다.

```bash
# 일반적인 기본값
ollama pull qwen3-embedding:0.6b

# 메모리 절약형
ollama pull embeddinggemma:300m-qat-q4_0

# 고성능 장비
ollama pull qwen3-embedding:4b
```

Ollama의 OpenAI-compatible endpoint가 동작하는지 확인합니다.

```bash
curl http://127.0.0.1:11434/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3-embedding:0.6b",
    "input": "SQLite를 로컬 기억 저장소로 사용한다"
  }'
```

endpoint와 model은 자체 설정에 저장할 수 있습니다. 설정은
`~/.agents-memory/config.json`에 기록되며 CLI와 MCP 서버가 함께 사용합니다.

```bash
agents-memory embeddings configure \
  --endpoint http://127.0.0.1:11434/v1/embeddings \
  --model qwen3-embedding:0.6b

agents-memory embeddings show
agents-memory embeddings index
agents-memory embeddings search "retry strategy"
```

일회성 실행에서는 `embeddings index` 또는 `embeddings search`에 `--endpoint`와
`--model`을 직접 전달할 수도 있습니다. 저장된 설정을 제거하려면
`agents-memory embeddings disable`을 실행합니다.

환경 변수도 지원합니다. 환경 변수는 저장된 설정보다 우선하고 명령행 옵션은 환경
변수보다 우선합니다.

```bash
export AGENTS_MEMORY_EMBEDDING_ENDPOINT=http://127.0.0.1:11434/v1/embeddings
export AGENTS_MEMORY_EMBEDDING_MODEL=qwen3-embedding:0.6b

agents-memory embeddings index
agents-memory embeddings search "retry strategy"
```

MCP 서버는 저장된 자체 설정이나 위 두 환경 변수 중 유효한 값을 사용해 검색 전에
변경된 기억만 색인하고 hybrid 검색을 수행합니다. API key가 필요하면
`AGENTS_MEMORY_EMBEDDING_API_KEY` 환경 변수를 사용합니다. endpoint/model이 모두
없으면 FTS로 완전히 동작하며 네트워크 요청을 하지 않습니다.

환경 변수는 MCP 서버를 시작하는 Claude Code, Codex 또는 GJC process에도
전달되어야 합니다. terminal에서 client를 실행한다면 shell profile에 export를
추가합니다.

```bash
cat >> ~/.zshrc <<'EOF'
export AGENTS_MEMORY_EMBEDDING_ENDPOINT=http://127.0.0.1:11434/v1/embeddings
export AGENTS_MEMORY_EMBEDDING_MODEL=qwen3-embedding:0.6b
EOF
```

GUI에서 직접 실행하는 client도 자체 설정을 읽으므로 endpoint와 model 환경 변수를
별도로 전달할 필요가 없습니다. 환경 변수로 자체 설정을 덮어쓰려면 해당 MCP
설정의 environment 항목에 같은 두 값을 추가해야 합니다. 로컬 Ollama에는 API
key가 필요하지 않습니다.

모델을 변경하면 출력 차원이 달라질 수 있으므로 기존 vector와 혼용하면 안 됩니다.
`embeddings index`는 저장된 provider/model/content hash가 달라진 기억을 자동으로
다시 색인합니다. model 변경 후 `agents-memory embeddings index`를 한 번
실행하십시오.

```bash
# CPU/GPU 배치 상태 확인
ollama ps
```

`Processor`가 `100% GPU`, `100% CPU` 또는 혼합 비율로 표시됩니다. Apple
Silicon에서는 GPU memory가 system unified memory를 공유합니다.

## 관리 웹 UI

```bash
agents-memory serve
```

명령이 출력하는 fragment token URL을 브라우저에서 엽니다. token은 URL query나
서버 로그에 남지 않으며 UI가 읽은 직후 주소창에서 제거합니다.

지원 기능:

- 반응형 control-room dashboard와 archive 상태 telemetry
- 기억 검색·kind/status 필터·생성·수정·상태 전환·privacy 삭제
- 기억별 branch/commit provenance와 evidence trail 조회
- 수집 pause/resume
- custom glob·redaction 정책 편집과 비저장 preview
- OS keychain 기반 원격 sync 설정·실행·해제
- 전체 JSON export

키보드 focus, native dialog, live status, reduced-motion 처리를 포함하며 Lighthouse
접근성 audit 기준 100점을 확인했습니다.
- 동기화 endpoint 설정, 상태 확인과 수동 실행

관리 서버는 기본적으로 `127.0.0.1:3789`에만 bind합니다. 모든 관리 API는 health
endpoint를 제외하고 bearer token을 요구하며 non-loopback Host와 Origin을
거부합니다.

## 원격 동기화

동기화는 프로젝트별 opt-in입니다. 활성화 전에는 네트워크 요청이 없습니다.
자격증명은 macOS Keychain 또는 Linux Secret Service에 저장하고 SQLite나 로그에
기록하지 않습니다.

```bash
# token은 shell history를 피하려면 환경 변수로 전달
export AGENTS_MEMORY_SYNC_TOKEN='issued-bearer-token'
agents-memory sync configure \
  --url https://memory-sync.example.com \
  --remote-project REMOTE_PROJECT_UUID

agents-memory sync status
agents-memory sync run
agents-memory sync disable
```

localhost 개발 service에만 `--allow-insecure-loopback`을 사용할 수 있습니다.
그 외 endpoint는 HTTPS와 redirect 거부가 강제됩니다.

### 동기화 서비스 배포

관리형 서비스용 PostgreSQL API, migration, tenant/project/token 관리자와
non-root Docker image가 포함되어 있습니다.

```bash
export DATABASE_URL='postgresql://...'
export TOKEN_HMAC_PEPPER='long-random-pepper'
export SYNC_MASTER_KEY='64-character-hex-key'

agents-memory-sync-migrate
agents-memory-sync-admin create
agents-memory-sync-service
```

`sync-admin`은 bearer token을 한 번만 출력하고 DB에는 HMAC만 저장합니다. change
payload는 AES-256-GCM으로 암호화되며 PostgreSQL에는 ciphertext, nonce와 auth
tag만 저장합니다.

```bash
agents-memory-sync-admin revoke --token 'issued-bearer-token'
```

Docker image:

```bash
docker build -f Dockerfile.sync-service -t agents-memory-sync .
```

운영 환경에서는 TLS ingress, PostgreSQL backup, secret/KMS 관리와 monitoring을
별도로 구성해야 합니다.

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

### npm 릴리스

GitHub Release를 발행하면 `.github/workflows/publish-npm.yml`이 실행됩니다.
워크플로는 릴리스 태그를 체크아웃하고 `v1.2.3` 또는 `1.2.3` 태그에서 패키지
버전을 설정한 뒤 패키지를 검증하고 provenance와 함께 npm에 배포합니다.
GitHub 시험판 릴리스에는 npm `next` dist-tag를, 안정 릴리스에는 `latest`를
사용합니다.

첫 릴리스 전에 npm trusted publisher에 `mongmeo-dev/agent-memory` 저장소와
`publish-npm.yml` 워크플로를 등록해야 합니다. 이 워크플로는 GitHub OIDC를
사용하므로 `NPM_TOKEN` secret이 필요하지 않습니다. 생성된 버전 변경은 배포
작업 공간에만 존재하므로 릴리스 태그가 버전의 단일 기준입니다.

현재 검증 기준:

- 단위·통합 테스트: 16개 파일, 97개 테스트
- 실제 MCP in-memory client/server 도구·resource 왕복
- 실제 localhost daemon→adapter→SQLite E2E
- 실제 브라우저에서 기억 생성·조회와 token fragment 제거/reload 유지
- PostgreSQL 17 container에서 두 장치 push/pull과 tenant envelope encryption 검증
- sync-service Docker image 빌드 검증
- 100,000개 기억 FTS 검색 100회 측정 p95 약 5.3ms
  (Apple M5 개발 장비, 성능 보장은 환경에 따라 달라짐)

## 문제 해결

### `MCP 서버를 찾을 수 없습니다`

전역 패키지를 다시 설치한 뒤 클라이언트 등록을 갱신합니다.

```bash
npm install --global agents-memory
agents-memory setup all
```

### MCP 클라이언트에서 서버가 시작되지 않음

등록된 Node와 MCP 파일 경로를 확인하고 설정을 갱신합니다.

```bash
agents-memory setup all --dry-run
agents-memory setup all
```

Node.js 24 미만에서는 내장 `node:sqlite`를 사용할 수 없으므로 Node.js를
업그레이드해야 합니다.

### 기억이 검색되지 않음

`context`로 현재 프로젝트 ID와 브랜치를 확인합니다. remote URL 또는 root commit이
다르면 별도 프로젝트로 처리됩니다.

```bash
agents-memory context
agents-memory search "기억에 포함된 단어"
```

embedding endpoint를 설정하지 않은 경우 token 기반 FTS만 사용하므로 기억에 없는
동의어만 사용하면 결과가 나오지 않을 수 있습니다. 의미 검색이 필요하면
[선택적 하이브리드 검색](#선택적-하이브리드-검색)을 활성화합니다.

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
- [Ollama embeddings](https://docs.ollama.com/capabilities/embeddings)와
  [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility):
  추천 embedding model, `/v1/embeddings` 요청 형식과 normalized vector 동작의
  근거입니다.
- [EmbeddingGemma model card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card):
  300M급 다국어 model의 context와 768/512/256/128 Matryoshka 차원을 설명합니다.
- [Qwen3 Embedding](https://qwenlm.github.io/blog/qwen3-embedding/):
  0.6B/4B/8B model의 다국어·code retrieval 특성과 출력 차원의 근거입니다.
