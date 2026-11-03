# 하네스 엔지니어링 논문과 세션 기록으로 본 j-cc 최적화 근거

논문 한 편의 설계 권고와 실제 세션 기록 3,581개를 대조해 j-cc가 무엇을 바꿨는지 측정하고, 남은 빈틈을 고친 기록이다.
기준은 Claude Code 2.1.316이다. mod(함수 훅) API는 early access라 릴리스마다 바뀔 수 있다.

## 근거로 삼은 논문

Paul Barbaste, Tristan Darrigol, Germain Vu, Tom Wiltberger. *Harness Engineering: Anatomy, Architecture, and Evolution of Coding Agents — A Source-Code Study of Eleven Systems*. arXiv:2609.00006v1, 2026년 7월. <https://arxiv.org/html/2609.00006v1>

Claude Code, Codex CLI, Gemini CLI, Mistral Vibe, OpenHands, Aider, Mini-SWE-Agent, Hermes, Pi, OpenCode, OpenClaw 등 11개 하네스의 소스를 7개 하위 시스템(루프, LLM 연동, 도구, 메모리·맥락, 안전·권한, 오케스트레이션, 확장)으로 나눠 비교한 논문이다. 성능 순위는 매기지 않는다. j-cc에 쓴 부분은 다음과 같다.

| 논문의 근거 | 내용 | j-cc에 적용한 방식 |
|---|---|---|
| §7.3 Read-before-edit and verify-before-claim | 프롬프트 문장은 동작을 바라는 말일 뿐 강제 장치가 아니다. OpenCode의 Edit 설명은 읽지 않으면 오류가 난다고 적지만 소스에는 그런 검사가 없다. 거짓 성공 보고를 막는 Claude Code 문구는 내부 빌드에 먼저 나간다. Hermes만 verify-on-stop 가드로 이를 강제한다. | 셸 오용은 문장으로 부탁하지 않고 훅으로 막는다(기존). 검증 후 보고는 강제할 훅이 없어 한 줄 규칙으로만 넣었다(아래 "바꾼 것" 2). |
| §14.5 Policy migrated out of prose, Observation 3 | 행동 정책이 모델이 읽는 프롬프트에서 플랫폼이 강제하는 설정으로 옮겨 가고 있다. | 새 규칙은 가능한 한 훅에 둔다. 문장 규칙은 훅이 없는 곳에만 쓴다. |
| Recommendation 11 | 안전 규칙은 명령형 코드보다 데이터나 정책 파일로 둔다. Claude Code의 PreToolUse 훅이 예다. YOLO 모드에도 바닥 규칙을 남긴다. | j-cc 규칙은 훅이고, auto mode에서도 같은 차단이 적용된다. |
| Recommendation 4, §8.3 | 도구가 15개를 넘으면 지연 로딩을 쓴다. Claude Code의 ToolSearch가 초기 프롬프트를 약 40% 줄인다. | 지연 도구 목록 묶기, 필요한 도구가 없을 때 ToolSearch 먼저 쓰기(기존). |
| §6.4, §11.2 Coordinator-worker, Context forking | Claude Code의 서브에이전트는 따로 떼어 낸 맥락으로 시작한다. | 메인 세션에 넣은 규칙이 서브에이전트에 전해진다고 가정하지 않는다(아래 "바꾼 것" 1). |
| Recommendation 18 | 고착 감지는 과하게 만들지 말되, 싼 상한은 둔다. Claude Code와 Codex에는 자동 고착 감지가 없다. | 이번에는 넣지 않았다. Opus에서는 같은 호출 3연속이 거의 없다(아래 "바꾸지 않은 것"). |
| Table 12 Outer Verification Loop | OpenHands의 `/goal` 판정, Hermes의 verify-on-stop처럼 턴 밖에서 완료를 검증한다. | 이번 API로는 턴 종료를 막을 수 없어 적용하지 않았다. |

논문의 Claude Code 분석은 2026년 3월 소스 스냅숏 기준이다. 논문 스스로 "도구 수, 기능 표 같은 목록형 주장은 몇 주 만에 낡는다"고 적는다(§14.5). 그래서 Claude Code에 관한 주장은 2.1.316의 실제 프롬프트와 기록으로 다시 확인한 것만 썼다.

## 세션 기록 조사

### 방법

`~/.claude/projects` 아래 jsonl 3,581개(7.4GB, 2026-09-10 ~ 11-02)를 스크립트로 모두 읽었다. 조사 스크립트는 저장소에 넣지 않았다. 서브에이전트 기록은 `<세션>/subagents/` 아래 파일이며 부모 세션의 분류를 따른다.

- **j-cc 사용 여부**: 훅 맥락(`hook_additional_context`)이나 도구 결과가 `[j-cc]`로 시작하거나, 시스템 프롬프트 스냅숏에 `# Automatic backgrounding (j-cc)`가 있거나, `mcp__j-cc__*` 도구를 부른 세션을 j-cc 세션으로 본다. 파일 내용에 `[j-cc]`가 들어 있는 경우(소스 읽기)는 세지 않는다.
- **이전 플러그인**: 도구 결과나 훅 출력에 `[use-right-tool] Blocked`가 있으면 use-right-tool 세션으로 따로 센다.
- **제외**: 사람이 직접 입력한 프롬프트가 없는 세션, 진입점이 `cli`가 아닌 세션(SDK, 데스크톱 앱 등), `AppData` 아래 임시·벤치마크 작업 폴더, j-cc와 이전 플러그인의 개발 폴더. 남은 메인 세션은 469개, 서브에이전트는 1,792개다.
- **같은 기간 비교**: j-cc는 10월 16일부터 쓰였으므로, 미사용 세션은 전체 기간과 10월 16일 이후로 나눠 본다.
- **셸 파일 보기·검색**은 이 조사용 근사 분류다(첫 명령이 cat/head/Get-Content 등이면 보기, grep/rg/find/Select-String 등이면 검색). j-cc의 차단 규칙과 똑같지는 않다.
- **검사 없이 끝난 코드 수정 턴**: 사람 프롬프트 사이의 한 턴에서 코드 파일(.ts, .py, .rs 등)을 Edit/Write했는데, 마지막 수정 뒤에 테스트·빌드·타입 검사·실행 명령이 한 번도 없었던 턴의 비율이다.

### 이 기간에 실제로 켜져 있던 기능

수치를 해석할 때 중요하다. 10월 16일부터 켜져 있던 것은 `CLAUDE_CODE_THRIFTY_SONIC=0`, 셸 파일 작업 차단, 루프·대기 차단, 자동 백그라운드 전환, Read/Grep 기본 한도, 목록 줄이기, 서브에이전트 첫 셸 결과 안내다. exec/poll, ToolSearch 안내, 스킬 규칙, 체이닝 차단, 우회 이유 검토, 응답 언어 경고는 11월 2일에 들어가서 이 기록으로는 효과를 잴 수 없다. 스킬 사용률, ToolSearch 사용률, 영어 응답 비율은 그래서 아래 결론에 쓰지 않았다.

### 메인 세션 (Opus)

| 지표 | j-cc (38) | 미사용, 10/16 이후 (120) | 미사용, 전체 (324) | use-right-tool (35) |
|---|---|---|---|---|
| 도구 호출 중 셸 비율 | 28.5% | 35.1% | 43.6% | 62.9% |
| 셸 100회당 파일 보기 / 검색 | 3.3 / 1.8 | 8.0 / 9.2 | 13.7 / 9.4 | 19.3 / 11.4 |
| 셸 1,000회당 60초 넘는 포그라운드 명령 | 11.5 | 28.6 | 40.0 | 45.6 |
| 셸 1회당 포그라운드 대기 | 4.5초 | 8.8초 | 11.6초 | 13.0초 |
| 검사 없이 끝난 코드 수정 턴 | 6.7% | 14.5% | 10.8% | 2.6% |
| 도구 오류율 | 3.5% | 5.8% | 4.4% | 3.9% |
| 같은 도구 호출 3연속 (1,000회당) | 0.0 | 1.37 | 0.91 | 0.58 |

j-cc 세션은 같은 기간의 미사용 세션보다 셸로 파일을 보는 일이 절반 이하, 검색은 1/5 수준이고, 1분 넘게 포그라운드에서 기다린 명령은 약 40%다. 세션의 작업 종류가 서로 다르므로 차이를 모두 j-cc 효과로 볼 수는 없다.

### 서브에이전트 (Opus)

| 지표 | j-cc 서브에이전트 (362) | 미사용 서브에이전트, 10/16 이후 (102) | j-cc 메인 (참고) |
|---|---|---|---|
| 셸 100회당 파일 보기 / 검색 | 12.7 / 9.4 | 22.7 / 23.6 | 3.3 / 1.8 |
| 셸 100회당 j-cc 차단 | 10.0 | — | 4.4 |

j-cc는 서브에이전트에서도 셸 파일 작업을 줄였지만, 같은 j-cc 세션의 메인보다 보기는 약 4배, 검색은 약 5배 많고 차단도 2배 넘게 당한다. 차단은 명령을 실행하지 않고 돌려보내므로 한 번마다 왕복 하나를 버린다.

원인은 안내가 닿는 위치다. j-cc의 `# Tool routing`, `# User workflow first` 섹션은 메인 시스템 프롬프트에 들어간다. 서브에이전트에는 그때까지 첫 셸 결과에 붙는 백그라운드 안내만 갔고, 파일 도구 규칙은 없었다. 필터 전 전체 기록 기준으로 Opus 서브에이전트 1,600여 개 중 892개가 첫 도구로 Bash를 불렀으므로, 그 안내조차 첫 셸 호출 뒤에야 도착했다. 서브에이전트 기록에는 시스템 프롬프트 스냅숏이 남지 않아, 서브에이전트가 메인의 j-cc 섹션을 받는지는 기록으로 확인하지 못했다. 행동 지표만으로 판단했다.

### 차단 뒤의 행동

j-cc 세션에서 차단 약 840건 뒤 바로 다음 호출을 봤다(필터 전 전체 기록 기준이며, j-cc 개발 폴더의 세션도 들어 있다). 약 79%는 안내한 전용 도구(Grep, Read, Write, Edit, Glob, Monitor)로 바꿨다. 13%는 우회 주석 없이 셸을 다시 불렀고, 8%는 `# j-cc:allow:` 주석을 붙였다. 차단 문구가 대체 도구를 이름으로 알려 주는 방식은 대체로 통한다.

## 바꾼 것

### 1. 서브에이전트는 시작할 때 규칙을 받는다

`agent.spawn` 훅에서 서브에이전트 과제 프롬프트 끝에 j-cc 맥락을 붙인다. 내용은 세 가지다.

- 파일은 Read, Grep, Glob, Edit, Write로 다루고 셸의 cat, grep, find, sed, heredoc 등은 막힌다는 사실
- 체이닝 차단이 켜져 있으면, 셸 명령은 호출마다 하나씩 실행한다는 규칙
- 기존 서브에이전트 규칙: 결과가 필요한 명령은 포그라운드로, 백그라운드로 돌렸다면 끝나기 전에 Monitor로 기다린다

이렇게 안내한 서브에이전트는 첫 셸 결과에 같은 안내를 다시 붙이지 않는다. fork는 부모의 맥락을 그대로 이어받으므로 프롬프트를 바꾸지 않는다. 훅을 거치지 않고 시작한 서브에이전트에는 이전처럼 첫 셸 결과에 붙이며, 이 안내에도 이제 파일 도구 규칙이 들어간다.

### 2. 코드 변경을 완료라고 보고하기 전에 검사한다

`# User workflow first` 섹션에 한 줄을 넣었다. "코드 변경을 완료라고 보고하기 전에 그 변경을 다루는 가장 좁은 검사(테스트, 빌드, 타입 검사, 실행)를 돌린다. 돌리지 않았거나 못 했으면 보고에 그렇게 쓴다."

- 2.1.316 기본 프롬프트에는 이미 "Report outcomes faithfully: if tests fail, say so"가 있다. 그 문장은 결과를 정직하게 보고하라는 뜻이고, 보고 전에 검사를 돌리라는 말은 없다. 빠진 그 절반만 넣었다.
- Hermes의 verify-on-stop처럼 턴 종료를 막고 계속 진행시키는 방식이 더 강하다. 하지만 `turn.complete`는 답 아래에 글을 보여 줄 수만 있고 턴을 이어 가게 할 수 없어서 문장 규칙으로 넣었다.
- 메인 세션 Opus에서 검사 없이 끝난 코드 수정 턴은 j-cc 6.7%, 같은 기간 미사용 14.5%였다.

## 바꾸지 않은 것

- **고착 감지(같은 호출 반복 경고)**: Opus 메인에서 같은 호출 3연속은 j-cc 0건, 미사용 1,000회당 0.9~1.4건이다. 큰 값은 프록시로 연결한 GPT 서브에이전트(1,000회당 30.7건)에서만 나온다. Recommendation 18과 같이 Claude Code에서는 넣지 않는다.
- **GPT 서브에이전트의 입력 검증 오류**: j-cc 세션의 GPT 서브에이전트는 도구 오류율이 29.7%다. 대부분 필수 인자가 빈 호출(`Read {}` 936건, `Glob {}` 274건, `Bash {}` 199건)이다. 프록시 모델의 스키마 문제이고, 검증은 `tool.call` 훅보다 먼저 일어나는 것으로 보이며, j-cc의 대상은 Claude 모델이라 다루지 않는다.
- **응답 언어 장치 추가**: 언어 이탈 경고가 11월 2일에 들어가 아직 측정 자료가 없다.

## 두 번째 논문: 하네스 부품을 하나씩 바꾼 실험

Run-Ze Fan 외. *An Empirical Study of Harness Design for Coding Agents*. arXiv:2609.20804v1, 2026년 9월. <https://arxiv.org/abs/2609.20804>. 해설: <https://core.today/blog/coding-agent-harness-design-empirical-study-2026>

같은 ReAct 루프에서 계획, 행동 공간(도구 세트 대 bash 단독), 맥락 관리만 바꿔 4개 모델 × 2개 벤치마크 × 22개 설정 = 176개 설정을 쟀다. 모델은 Nemotron-3 30B·120B·550B와 Mistral Medium 3.5이고 Claude는 없다. 창이 넓고(128k) 모델이 강할수록 부품의 효과가 작아졌으므로, Opus에 쓰는 j-cc에서는 정확도보다 호출 수와 비용 쪽 근거로 읽는다.

| 논문의 근거 | 내용 | j-cc 결정 |
|---|---|---|
| §4.3 행동 공간, Table 6 | bash에 능한 550B는 bash 단독에서 SWE-Bench +3.6pp, 비용 −53%. 여러 저수준 작업을 셸 명령 하나로 묶어 도구 호출이 24~32% 줄었다. | 체이닝 차단을 기본으로 끈다(아래 1). |
| §4.3, Figure 7 | 저장소 편집(SWE-Bench)에서는 도구 세트가 낫다(Mistral −23.2pp, 30B −15.0pp). 셸 중심 과제(Terminal-Bench)에서는 bash 단독이 나은 모델이 있다. 도구 세트에는 읽기 전 쓰기 검사, 상태 추적, 편집 후 진단이 함께 들어 있어 도구 개수만의 효과가 아니다. | 셸 파일 작업 차단은 유지한다(아래 2). |
| §2 고정된 바닥, 편집 후 진단 | 파이썬 파일을 편집하면 ruff·pyflakes 결과를 도구 응답에 붙인다. | j-cc에 만들지 않는다. Claude Code가 LSP 플러그인으로 같은 일을 한다(아래 3). |
| §4.1 recall 사용률, Table 13 | 지운 출력을 되찾는 도구는 64개 설정 중 56%에서 한 번도 불리지 않았고 성적 차이도 없었다. | 되찾기 도구는 만들지 않는다. Read·Grep 기본 한도와 "더 읽으려면" 안내(생략 + 다시 읽기)는 논문의 가장 싼 방식(T4의 첫 단계)과 같다. |

### 1. 체이닝 차단을 기본으로 끈다

체이닝 차단은 사용자 설정의 훅을 11월 2일에 j-cc로 옮긴 것이다. 그 뒤 하루 남짓한 기록(`[j-cc] Blocked (chain` 검색)에서 j-cc 개발 세션 4개를 빼면, 차단된 호출은 23번, 명령 모양으로는 13종이었다.

| 막힌 명령 | 종류 | 뒤의 행동 |
|---|---|---|
| `node -v; npm -v`, `Get-Process …; Get-Command …`, `Get-ChildItem …; Test-Path …`, `npx … ; echo "exit=$?"`, `Copy-Item …; Copy-Item …; Get-Item …` 등 | 해가 없는 조회·작업을 `;`로 묶음 (9종) | 같은 명령을 한 번 더 보냈다가 다시 막히거나, 호출 2~3개로 나눴다 |
| `for g in …; do <cli> $g …; done` | 반복문 (1종) | 호출 4~5개로 나눴다 |
| `until <cli> … status … ; do sleep 2; done` (2종) | 백그라운드 대기 루프 | j-cc의 대기 규칙은 백그라운드 until 루프를 허용하는데, 체이닝 규칙이 대신 막았다. scratchpad 스크립트로 우회했다 |
| `cd /c/…/<프로젝트> && node … …` | `cd … &&` (1종) | 절대 경로로 다시 실행했다. 이 차단은 쓸모가 있었다 |

막힌 호출은 실행되지 않고 왕복 하나를 버린다. 그 뒤 나눠 실행하면 호출이 더 늘어난다. 논문에서 bash의 이점은 이렇게 묶어 실행하는 데서 나왔다. 파일 보기·검색·수정은 체인 안에서도 막히므로(전용 도구 규칙은 세그먼트마다 본다), 체이닝 차단을 꺼도 j-cc의 핵심 규칙은 남는다.

- `blockChaining` 기본값을 `false`로 바꿨다. 켜는 것은 사용자가 `true`로 정했을 때뿐이다(`register.ts`). 꺼져 있으면 Bash·PowerShell 설명, exec의 `cmd` 설명, 서브에이전트 맥락에도 체이닝 금지 문장이 들어가지 않는다.
- `cd … &&`는 이제 막히지 않는다. Claude Code 자체 Bash 설명이 이미 절대 경로를 권하고, 복합 명령의 `cd`는 권한 확인을 부를 수 있다고 적는다.

### 2. 셸 파일 작업 차단은 유지한다

j-cc가 다루는 작업은 대부분 저장소 편집이다. 논문에서 저장소 편집은 도구 세트가 나았고, 도구를 빼면 편집 전 읽기 검사와 편집 후 진단도 함께 빠진다. 다만 셸 중심 작업(시스템 관리, 데이터 처리)에서는 전용 도구 강제가 호출을 늘릴 수 있다. 위 1로 셸 명령을 묶어 실행하는 이점은 되찾았으므로, 파일 작업 차단은 그대로 둔다.

### 3. 편집 후 진단은 j-cc에 만들지 않는다

Claude Code 실행 파일에는 플러그인 `lspServers`와 편집 뒤 모델에게 보내는 `<new-diagnostics>` 첨부가 있다. 세션 기록에도 Rust(`rustc`)와 TypeScript(`ts`) 파일의 `<new-diagnostics>`가 남아 있어, 편집 후 진단은 이미 모델에게 간다. 진단이 없는 언어에 붙이려면 j-cc가 아니라 그 언어의 LSP 플러그인을 켜면 된다. 이는 사용자 설정의 선택이라 j-cc에서 바꾸지 않는다.

## 셸 명령을 exec 하나로 모은다

풀려던 문제는 두 가지다. 하나는 5초면 끝날 명령이 실수(닫히지 않은 heredoc, 입력 대기)로 멈췄을 때, 모델이 포그라운드 Bash의 타임아웃(최대 10분)까지 기다리는 것이다. 다른 하나는 학습·서버처럼 로그가 나오는 긴 작업을 20초마다 다시 확인하는 것이다.

Codex(`openai/codex`의 codex-rs)에서는 이런 문제가 없다. `exec_command`는 기본 10초, 최대 30초(`MAX_YIELD_MS = 30_000`)를 기다린 뒤 출력과 `session_id`를 돌려준다. 빈 입력으로 `write_stdin`을 부르면 최대 300초(`background_terminal_max_timeout`)까지 출력을 기다린다. 셸 도구가 늘 정해진 시간 안에 돌아오므로, 멈춘 명령은 모델이 다음 응답에서 알아챈다.

이전 시도와 버린 이유:

- 45초 이상 걸린 적 있는 명령을 자동으로 백그라운드로 보내는 방식. 처음 걸리는 명령에는 효과가 없었다.
- 30초가 지나면 `$.turn.abort`로 턴을 끊어 실행 중인 Bash를 백그라운드로 넘기는 방식. 모델이 아직 출력을 쓰는 중이면 명령이 취소되고, 같이 줄 선 호출도 "re-run if still needed"로 취소되었다.
- Bash `timeout`을 30초로 낮추는 방식. 타임아웃이 지나면 명령은 죽지 않고 백그라운드로 넘어간다("moved to the background"). 처음에 죽는 것처럼 보였던 것은 사용자가 Esc를 눌렀기 때문이었다. 다만 넘어간 명령이 끝나지 않으면 완료 알림도 오지 않는다.

그래서 포그라운드 Bash·PowerShell을 막고 exec(`shell` 인자로 bash·powershell 선택)로 모았다. `run_in_background: true`는 그대로 둔다. PowerShell은 ToolSearch 뒤로 미뤘다. 셸 명령은 exec로 가고, 백그라운드 작업은 Bash로 충분하기 때문이다. 서브에이전트도 훅을 거치므로 똑같이 막는다. 다만 정의 파일의 `tools:` 목록에 exec가 없는 에이전트는 막지 않는다. `$.tool.list`와 `agent.spawn`은 에이전트별 도구 목록을 주지 않아서 정의 파일을 읽는다.

### 훅 예산 실험

`tool.call` 훅의 예산은 10초다. exec가 30초, poll이 5분을 기다리려면 기다리는 시간이 예산에 들어가지 않아야 한다. scratchpad의 시험용 mod로 잰 결과는 다음과 같다.

| 기다리는 방법 | 예산에 들어가는가 |
|---|---|
| `$.clock.sleep`, `$.clock.after`로 만든 타이머 | 들어간다 |
| 같은 호출에서 띄운 `$.process.spawn` 출력을 분리된 루프로 읽는 동안 기다리기 | 들어가지 않는다 |
| 훅 안에서 `for`/`stream.next()`로 직접 읽기 | 오류가 난다 |
| 앞선 호출이 띄운 프로세스 기다리기 | 들어간다. 정확히 10초에 초과했다 |
| poll 호출에서 `sleep` 프로세스를 새로 띄우고 그 출력을 읽으며 기다리기 | 들어가지 않는다. 20초 대기 2회를 확인했다 |

처음 구현에서 exec는 `$.process.spawn`으로 명령을 직접 띄우고 30초까지 기다렸고, poll은 `sleep` 프로세스를 띄워 기다렸다. 이 구현은 아래 "exec를 Bash 도구에 맡긴다"에서 바꿨다.

### exec를 Bash 도구에 맡긴다

**문제.** `$.process.spawn`은 명령을 호스트에서 바로 실행한다(타입 문서: "Starts a command on the host"). 인자는 `argv`, `cwd`, `env`, `input`뿐이고 샌드박스 옵션이 없다. 엔진의 샌드박스 관리자도 플러그인에 노출되지 않는다. 그래서 샌드박스를 켜도 exec 명령은 샌드박스 밖에서 돈다. 게다가 exec의 권한은 같은 명령의 Bash 판정을 따르므로, `autoAllowBashIfSandboxed`가 켜져 있으면 묻지도 않고 샌드박스 밖에서 실행될 수 있었다.

**확인한 샌드박스 상태 (Claude Code 2.1.316, Windows 11).**
- 실행 파일 안의 문구 "Sandboxing is currently only supported on macOS, Linux, and WSL2"는 낡은 오류 메시지다. 실제 판정(`isSupportedPlatform`)은 Windows에서 `r4()`를 보고, `r4()`는 기능 플래그 `tengu_nankeen_kestrel`이나 환경변수 `CLAUDE_CODE_NANKEEN_KESTREL`을 본다.
- `claude sandbox status`: `"The Windows sandbox is not enabled on this build."`, `supported: false`.
- `CLAUDE_CODE_NANKEEN_KESTREL=1 claude sandbox status`: `supported: true`. 다만 "set up by a different release (setup version 2; this release needs 3)"라서 `claude sandbox install`(관리자 승인 필요)이 다시 필요하다. 설치는 하지 않았다.
- 엔진은 Windows에서 실행 파일 자신을 샌드박스 실행기로 쓴다(`exe: process.execPath` + 내부 인자). 플러그인이 이것을 흉내 낼 수는 있지만, 인자와 설정 전달 방식이 공개되지 않아 버전마다 깨질 수 있어 쓰지 않았다.

**검토한 방법.**
1. 샌드박스 실행기를 직접 감싼다: 내부 인자에 기대므로 버렸다.
2. 샌드박스가 켜져 있으면 포그라운드 Bash 차단을 푼다: 구현은 쉽지만, 멈춘 명령을 10분 기다리는 원래 문제가 돌아온다.
3. exec가 훅 안에서 `$.tool.call`로 엔진의 Bash·PowerShell 도구를 부른다: 샌드박스, 작업 목록, 완료 알림이 Bash와 같아진다. 이 방법을 실험했다.

**실험 (scratchpad의 `delegate-probe` mod, `claude -p --plugin-dir`, Claude Code 2.1.316).** `PROBE_DELEGATE=<모드>`가 든 Bash 호출을 훅이 가로채, 그 안에서 Bash 도구를 다시 부른다.

| 실험 | 결과 |
|---|---|
| 바로 끝나는 명령(`raise SystemExit(3)`) | 3초에 `Exit code 3`과 출력이 돌아왔다. |
| 40초 명령을 포그라운드, `timeout` 15초로 호출 | 훅 안에서 16초를 기다렸는데 예산이 그대로였다(9999→9998ms). 남의 호출을 기다릴 때와 달리 `$.tool.call`을 기다리는 시간은 예산에 들어가지 않았다. 15초가 지나자 엔진이 명령을 백그라운드로 넘기고, 출력과 `backgroundTaskId`, 출력 파일 경로를 돌려줬다. |
| 그 출력 파일을 `$.fs.read`로 읽기 | 진행 중인 출력을 읽을 수 있었다. 끝난 뒤에는 엔진이 파일 끝에 `[exited with code 0]`을 붙였다. 멈춘 작업에는 `[killed]`가 붙었다. |
| `TaskStop`을 `$.tool.call`로 호출 | 바로 멈췄다. |
| 바깥 `echo`만 허용(`--allowedTools "Bash(echo:*)"`)하고 안쪽 `python` 호출 | 안쪽 호출이 그대로 실행됐다. 훅이 부른 도구는 권한을 다시 묻지 않는다. |
| 같은 플러그인의 훅 | 다시 걸리지 않았다(디버그 로그 `skipped: re-entry (its own frame is being dispatched)`). 그래서 j-cc의 포그라운드 Bash 차단이 exec의 내부 호출을 막지 않는다. |
| 다른 플러그인의 훅 | 걸렸다. 설치된 j-cc(체이닝 차단 켜짐)가 안쪽 `;` 명령을 막았다. |
| 서브에이전트에서 포그라운드, `timeout` 15초로 호출 | 처음부터 백그라운드로 시작했고(`is_backgrounded: true`), 15초에 "stopped after reaching its background time limit"으로 멈췄다. 서브에이전트에서는 `timeout`이 백그라운드 마감으로 쓰인다. |
| 백그라운드로 넘어간 작업 | 끝나거나 멈추면 엔진이 `task_notification`을 모델에게 보냈다. |

엔진 코드에서도 백그라운드 마감을 확인했다. 기본값은 `600000`ms(10분)이고, 기능 플래그(`tengu_cosmic_shore`, `tengu_crispy_glade`)와 `backgroundDeadlineDisabled`에 따라 켜진다. 켜져 있으면 Bash 설명에 "With it, `timeout` limits how long the command may run in the background"가 붙는다. 실험한 `claude -p`에서는 켜져 있었고, 대화형 세션의 Bash 설명에는 그 문구가 없었다.

**결정.**
- exec는 명령을 Bash·PowerShell 도구에 `run_in_background: true`로 넘긴다. `timeout`은 주지 않아 엔진 기본 마감을 따른다. 서브에이전트에서는 포그라운드로 불러도 백그라운드로 바뀌고 `timeout`이 마감이 되므로, 처음부터 백그라운드로 넘기는 쪽이 메인과 서브에이전트에서 똑같이 동작한다.
- 권한은 지금처럼 exec의 `tool.check` 훅이 같은 명령의 Bash·PowerShell 판정으로 정한다. 안쪽 호출은 권한을 다시 묻지 않으므로 이것이 유일한 관문이다. 샌드박스와 `autoAllowBashIfSandboxed`가 켜져 있으면 Bash 판정이 허용이 되고, 안쪽 Bash가 샌드박스 안에서 실행한다.
- exec와 poll은 출력 파일을 읽어 끝을 판단한다. 기다리는 동안에는 0.25초마다 빈 줄을 찍는 tick 프로세스(Git Bash, 없으면 pwsh)를 띄우고, 한 줄이 올 때마다 파일을 다시 읽는다. 엔진이 돌리는 작업을 기다리는 시간은 예산에 들어갈 수 있다. 반면 이번 호출이 띄운 프로세스의 출력을 읽는 동안은 예산이 줄지 않는다. tick 프로세스를 띄우지 못하면 8초와 남은 예산에서 1.5초를 뺀 값 중 작은 쪽까지만 기다린다.
- yield가 지나도 끝나지 않은 명령은 백그라운드에서 계속 돈다. 따로 안내하지 않고, 엔진의 완료 알림을 띄워 모델이 다른 일로 넘어가게 한다. exec 결과에도 "You are notified when it exits; meanwhile do other work"라고 적는다. poll은 그 전에 출력이 필요할 때만 쓴다.
- exec나 poll이 이미 종료를 보고한 작업의 알림은 중복이라 지운다. 턴 중간에 실리는 알림은 `prompt.attachment`에서 `text: null`로 지우고, 세션이 쉬는 중에 들어오는 알림은 `prompt.submit`에서 버린다. 버리는 사유 한 줄은 사용자에게 보인다. matcher 없는 `prompt.attachment` 훅은 모듈에 하나만 둘 수 있어, register.ts의 기존 훅에 합쳤다.
- terminate는 `TaskStop`을 부른다.
- `cwd`는 안쪽 명령 앞에 `cd -- '<cwd>' && `(PowerShell은 `Set-Location -LiteralPath '<cwd>'; `)를 붙여 지원한다. 같은 플러그인 훅이 다시 걸리지 않으므로 j-cc의 체이닝 차단에 걸리지 않는다.
- 덤으로, 작업을 엔진이 관리하므로 j-cc가 다시 불러와져도 exec 명령이 멈추지 않는다. 그래서 "오래 걸리는 작업은 `run_in_background`로"라는 안내를 뺐다.

**처음부터 끝까지 확인 (`claude -p --plugin-dir <j-cc>`, Claude Code 2.1.316, j-cc 0.9.0으로 낸 개발본).**

| 시나리오 | 결과 |
|---|---|
| `print('quick')` | `Process exited with code 0 (wall 3.6s)`. 첫 호출이라 셸 준비 시간이 들어간 것으로 보인다. 엔진은 완료 알림을 만들었지만 모델에게는 가지 않았다. |
| `pwd`, `cwd: <j-cc>/hooks` | `<j-cc>/hooks`의 Git Bash 경로(`/c/…/j-cc/hooks`) (0.4초). |
| `shell: powershell`, `Write-Output` | 1.0초에 출력. |
| 20초 명령, yield 5초, poll 안 함 | `Process running in the background with session_id 4 (wall 7.5s)`와 출력 0~5. 명령이 끝나자 완료 알림이 모델에게 갔다. |
| 300초 명령, yield 3초, 이어서 terminate | `Process exited with signal killed (wall 6.1s)`. "stopped" 알림은 모델에게 가지 않았다. |
| 서브에이전트에서 12초 명령, yield 4초, poll 30초 | exec가 0~4를 돌려주고, poll이 종료 시점에 `Process exited with code 0 (wall 13.8s)`와 5~11을 돌려줬다. 알림은 서브에이전트에도 메인에도 가지 않았다. |

디버그 로그에 j-cc 훅을 건너뛰었다는 기록은 없었다. 매 exec 호출마다 남는 "no tool.call hook answered this call"은 권한 관문이 의도대로 내는 기록이다.

**아직 확인하지 않은 것.**
- 실제 샌드박스를 켠 상태(작업 폴더 밖 쓰기가 막히는지). `claude sandbox install`과 Windows 샌드박스 플래그가 필요하다.
- settings.json의 `Bash`/`PowerShell` PreToolUse 훅이 안쪽 호출에 걸리는지.
- 대화형 세션에서 exec나 poll이 기다리는 동안 Esc를 누르는 경우.

## 검증

- exec를 Bash 도구에 맡긴 뒤 `claude plugin test .`: 144 pass, 0 fail. `hooks/exec.test.ts`에 출력 파일 끝 표식 해석, 이미 돌려준 출력 건너뛰기, 작업 ID·출력 경로 꺼내기, cwd 인용, 보고한 작업의 알림 판정 테스트를 더했다. 고친 파일(exec, register, prompt)에는 tsc 오류가 없다. `claude plugin validate .`는 경고 두 개(루트 CLAUDE.md, 아이콘 없음)와 함께 통과했다. 실제 엔진 확인은 위 표와 같다.
- exec 통일 후 `claude plugin test .`: 140 pass, 0 fail. 새 테스트는 `hooks/shell-routing.test.ts`(포그라운드 차단, 백그라운드 허용, exec 없는 에이전트 예외, PowerShell 미루기)와 `hooks/exec.test.ts`의 대기 상한 두 개다. 실제 도구로 `claude -p`에서 25초 명령이 exec 한 번에 끝났고, `yield_time_ms` 60000인 poll이 약 61초 기다렸으며, terminate 뒤 남은 `sleep` 프로세스는 없었다. 훅을 건너뛰었다는 기록도 없었다. 실행 시간 기록과 자동 백그라운드 전환(`hooks/background.ts`)은 지웠다.
- 체이닝 기본값 변경 후 `claude plugin test .`: 140 pass, 0 fail. 새 테스트는 `hooks/rules.test.ts`의 "blockChaining을 켜지 않으면 훅이 이은 명령을 막지 않고 파일 보기는 그대로 막는다"이다.
- 서브에이전트 맥락 추가 당시 `claude plugin test .`: 139 pass, 0 fail. 새 테스트는 지금 `hooks/shell-routing.test.ts`에 있는 "서브에이전트는 시작할 때 과제 끝에 파일 도구와 셸 규칙을 받고 첫 셸 결과에서 다시 받지 않는다"이다. 과제 프롬프트가 원문 뒤에 j-cc 맥락으로 끝나는지, 파일 도구·체이닝·백그라운드 규칙이 모두 들어가는지, 그 서브에이전트의 첫 셸 결과에 안내가 다시 붙지 않는지 확인한다.
- `claude plugin validate .`: 통과. 훅 목록에 `agent.spawn`이 나타난다. 경고는 이전과 같다(루트 CLAUDE.md, 아이콘 없음).
- 실제 엔진 확인: `claude -p --plugin-dir <j-cc>`로 Explore 서브에이전트를 하나 띄웠다. 그 서브에이전트 기록의 첫 메시지가 과제 원문 뒤에 `[j-cc] Context for this subagent:`와 세 규칙으로 끝나는 것을 확인했다(Claude Code 2.1.316).
- 실제 세션에서 서브에이전트의 셸 파일 작업이 줄었는지는 아직 재지 않았다. 같은 조사를 다시 돌려 서브에이전트의 "셸 100회당 파일 보기 / 검색"과 "셸 100회당 j-cc 차단"을 비교하면 된다.

## 한계

- 세션마다 작업, 프로젝트, Claude Code 버전이 다르다. 표의 차이는 관찰된 상관이며 통제 실험이 아니다.
- 셸 명령 분류와 "검사 명령" 판정은 정규식 근사다. 예를 들어 `node` 실행은 모두 검사로 셌다.
- 서브에이전트 기록에는 시스템 프롬프트가 남지 않는다. 서브에이전트가 메인의 j-cc 섹션을 받는지는 확인하지 못했다.
- `agent.spawn`에서 바꾼 프롬프트는 과제 본문 뒤에 붙는다. 과제 작성자가 끝에 둔 출력 형식 지시보다 뒤에 오므로, 출력 형식에 영향을 줄 수 있는지 지켜봐야 한다.
