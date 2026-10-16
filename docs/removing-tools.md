# 내장 도구를 목록에서 빼는 방법

도구를 단순하게 만들고 시스템 프롬프트를 줄이려고 조사한 결과를 기록한다.
기준은 Claude Code 2.1.301과 2026-10-16 시점의 공식 문서이며, 직접 실행해서 검증하지는 않았다.
지연된 도구를 처음부터 로딩하는 방법은 [loading-tools-upfront.md](loading-tools-upfront.md)에 있다.

## 요약

- **도구 이름만 적은 deny 규칙**을 넣으면 해당 도구가 모델 컨텍스트에서 빠진다. `permissions.deny`, `--disallowedTools`, SDK `disallowedTools` 모두 같다.
- 플러그인에서는 루트 `settings.json`의 `agent` 키로 메인 세션을 도구가 제한된 에이전트로 실행할 수 있다.
- mod(함수 훅)로는 도구를 목록에서 뺄 수 없다. 설명을 바꾸거나 ToolSearch 뒤로 미루는 것까지만 된다.

## 목록에서 빼는 방법

| 방법 | 범위 | 비고 |
|---|---|---|
| `permissions.deny`에 도구 이름만 (`"Agent"`, `"WebFetch"`) | settings.json (user, project, local) | 문서: "As a deny rule, both forms remove the tool from Claude's context." |
| `--disallowedTools "Edit"` | CLI, 실행 1회 | 이름만 적으면 컨텍스트에서 제거. `"*"`는 모든 도구 제거 |
| `--tools "Read,Edit,Bash"` | CLI, 내장 도구만 대상 | 내장 도구 집합을 제한. MCP 도구는 `--disallowedTools "mcp__*"`로 따로 뺀다 |
| `--agent <name>` 또는 settings의 `"agent"` 키 | 메인 세션 | 메인 세션이 그 에이전트 정의의 `tools` 허용 목록과 모델을 따른다. CLI 플래그가 설정보다 우선 |
| 플러그인 루트 `settings.json`의 `"agent"` | 플러그인을 켜 두는 동안 | 플러그인 settings에서 효과가 있는 키는 `agent`, `subagentStatusLine` 두 개뿐 |
| 서브에이전트 frontmatter의 `tools`, `disallowedTools` | 해당 서브에이전트 | `disallowedTools`는 상속받거나 지정한 목록에서 제거 |
| 환경 변수 | 특정 도구 | 아래 표 |
| Agent SDK `disallowedTools` | SDK | 문서: "The tool definition is removed from the request." |

### 특정 도구를 끄는 환경 변수

| 변수 | 효과 |
|---|---|
| `CLAUDE_CODE_DISABLE_ARTIFACT=1` | Artifact 도구 끔 (설정 `enableArtifact: false`와 같음) |
| `CLAUDE_CODE_DISABLE_WORKFLOWS=1` | Workflow 끔 (설정 `disableWorkflows`와 같음) |
| `CLAUDE_CODE_DISABLE_WEB_FETCH=1` | WebFetch 끔. WebSearch는 남음 |
| `CLAUDE_CODE_DISABLE_CRON=1` | 예약 실행 도구 끔 |
| `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` | Explore, Plan 서브에이전트 끔. Agent 도구 자체는 남음 |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` | `run_in_background` 파라미터와 Ctrl+B 끔 |
| `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` | `-p` 모드에서 내장 서브에이전트 전부 끔 |

`ENABLE_TOOL_SEARCH`는 MCP 도구의 지연 로딩만 제어하며 내장 도구에는 적용되지 않는다.

## 목록을 줄이지 못하는 것

- `--allowedTools`: 묻지 않고 실행할 도구를 정할 뿐 목록은 그대로다. 문서도 "To restrict which tools are available, use `--tools` instead"라고 안내한다.
- `Bash(rm *)`처럼 범위를 붙인 deny 규칙: 도구는 남고 해당 호출만 막힌다.
- mod 훅:
  - `tool.describe`는 `{ description, isDeferred }`만 돌려준다. 설명 교체와 ToolSearch 뒤로 미루기만 가능하고 입력 스키마는 바꿀 수 없다.
  - `prompt.compose`의 `tools`는 입력 정보일 뿐이고, `turn.step`에서 바꿀 수 있는 값은 `model`과 `effort`뿐이다.
  - `$.settings`는 읽기 전용이라 mod가 deny 규칙을 추가할 수 없다.
  - `$.tool.register`로 만든 도구의 이름은 항상 `mcp__<plugin>__<name>` 형식이다.

## 주의할 점

- Windows에서 Git Bash가 설치돼 있으면 `Bash`를 deny할 때 `PowerShell` 도구도 함께 꺼진다.
- `--bare`는 hooks, skills, plugins, MCP, auto memory, CLAUDE.md를 건너뛰고 Bash, 파일 읽기, 파일 편집 도구를 남긴다. 다른 내장 도구까지 빠지는지는 문서에 없다.
- `--restricted`는 명령, 코드 실행 도구와 WebFetch를 제거한다.
- 플러그인 에이전트에서는 `hooks`, `mcpServers`, `permissionMode`가 무시된다.
- 도구를 빼도 시스템 프롬프트 본문에 그 도구 언급이 남는지는 문서에 없다. 남는다면 mod의 `prompt.compose`로 정리한다.

## 미확인 사항

- 플러그인 에이전트를 `agent` 키에 적을 때 `j-cc:minimal`처럼 플러그인 이름을 붙여야 하는지.
- `--tools`가 스키마를 요청에서 완전히 빼는지(문서는 "restrict"라고만 표현한다).
- 실제 토큰 감소량. `/context`로 줄기 전과 후를 측정해야 한다.

## 플러그인 하나로 묶는 구성안

1. `agents/minimal.md`: 꼭 필요한 도구만 `tools:`에 적은 에이전트 정의
2. 플러그인 루트 `settings.json`: `{ "agent": "minimal" }`로 메인 세션을 그 에이전트로 실행해 도구 목록을 줄인다
3. mod 훅: `prompt.compose`로 프롬프트 섹션을, `tool.describe`로 남은 도구 설명을, `prompt.attachment`로 reminder를 정리한다

## 출처

- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [Subagents](https://code.claude.com/docs/en/sub-agents)
- [Plugin manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference)
- [Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Environment variables](https://code.claude.com/docs/en/env-vars)
- [MCP](https://code.claude.com/docs/en/mcp)
- [Headless / bare](https://code.claude.com/docs/en/headless)
- [Tools reference](https://code.claude.com/docs/en/tools-reference)
- mod 관련 내용: plugin-authoring 스킬의 타입 정의 `claude-code.d.ts` (2.1.301)
