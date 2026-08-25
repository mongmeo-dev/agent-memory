# agents-memory

`agents-memory`는 Claude Code, Codex, GJC가 프로젝트별 작업 맥락을 세션과
에이전트 경계를 넘어 공유하도록 만드는 로컬 우선(local-first) MCP 서버입니다.

사용자는 기억 저장을 직접 지시하지 않아도 됩니다. 클라이언트별 어댑터가 세션,
프롬프트, 도구 실행, 작업 결과를 이벤트로 수집하고, 민감정보를 제거한 뒤 검색
가능한 장기 기억으로 정리합니다.

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