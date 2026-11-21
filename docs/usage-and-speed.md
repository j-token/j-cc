# 사용량과 속도: 세션 기록으로 본 레버

5시간·주간 사용량을 줄이고 작업을 빠르게 하려고, 세션 기록에서 비용과 시간이 어디서 나오는지 잰 기록이다. Claude Code 2.1.316, j-cc 0.10.0 기준이다.

## 방법

- `~/.claude/projects` 아래 jsonl 3,698개(7.9GB)를 읽었다. 10월 16일 이후 요청만 세고, `AppData` 아래 벤치마크 폴더는 뺐다. 이전 조사([harness-engineering-evidence.md](harness-engineering-evidence.md))와 달리 j-cc 개발 세션과 `cli`가 아닌 진입점은 빼지 않았다.
- 한 API 요청은 기록에서 여러 줄(내용 블록마다 한 줄)로 남는다. `requestId`로 묶고, `usage` 값은 그 줄들 가운데 가장 큰 값을 쓴다. 첫 줄만 읽으면 서브에이전트의 출력 토큰이 중앙값 8개처럼 작게 나온다.
- 비용은 API 단가로 환산했다. 입력/출력은 Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50(Mtok당)이다. 캐시 읽기는 입력 단가의 0.05배, 5분 캐시 쓰기는 1.25배, 1시간 캐시 쓰기는 2배로 셌다.
  - 이 단가는 엔진의 `cost-state` 기록(세션별 `modelUsage` 토큰 수와 `costUSD`)을 최소제곱으로 역산해 확인했다. Opus 5.5(951개)는 입력 4.11, 출력 19.80, 캐시 읽기 0.21, 5분 쓰기 4.88, 1시간 쓰기 7.15이고, 오차 중앙값은 5.9%였다. Sonnet 5.5(546개)는 입력 2.08, 캐시 읽기 0.10, 오차 16%였다. Haiku 5.5는 100k 토큰 구간별 단가라 선형 역산이 맞지 않았다.
  - 구독의 5시간·주간 한도가 API 단가를 따르는지는 공개되지 않았다. 그래서 아래 결과는 절대 금액이 아니라 비율로 읽는다.
  - 실제 한도 사용률은 훅 API의 `session.measure` 이벤트가 `rateLimits`(`five_hour`, `seven_day`)로 준다. 과거 기록에는 남아 있지 않다.
- 모델 시간은 요청 직전 입력(사용자 메시지나 도구 결과)의 시각부터 그 요청의 마지막 블록 시각까지로 셌다. 도구 시간은 `tool_use`부터 `tool_result`까지다.

## 결과

### 비용은 Opus와 캐시 읽기에서 나온다

- 가중 비용의 96%가 Opus다. 서브에이전트 Opus가 51%, 메인 Opus가 45%이고, Sonnet과 Haiku를 합쳐 4%다.
- 메인 비용의 구성은 캐시 읽기 47%, 1시간 캐시 쓰기 31%, 출력 22%다. 서브에이전트는 캐시 읽기 41%, 5분 캐시 쓰기 35%, 출력 24%다.
- 메인 Opus 요청의 컨텍스트 크기는 중앙값 18만, 상위 10%가 31.5만 토큰이다. 서브에이전트 Opus는 중앙값 13.6만 토큰이다. 비용은 요청 수와 요청당 컨텍스트 크기로 거의 정해진다.

### 서브에이전트 비용은 implementer에 몰려 있다

| 타입, 모델 | 비용 비율 | 세션 | 세션당 요청 중앙값 | 도구 오류율 |
|---|---|---|---|---|
| implementer, Opus | 33% | 323 | 47 | 3.4% |
| implementation-lead, Opus | 9% | 36 | 78 | 5.1% |
| verifier, Opus | 4% | 66 | 37 | 5.4% |
| computer-use, Sonnet | 2% | 30 | 68 | 3.7% |
| implementer, Sonnet | 0.4% | 11 | 37 | 4.8% |

- 메인이 부른 Agent 호출 565개 가운데 558개가 `model`과 `effort`를 지정하지 않았다. 서브에이전트의 모델은 사실상 정의 파일이 정한다.
- `implementer` 요청 4,889개(27%)가 `high` effort로 돌았다. 지금 정의는 `medium`이다. 과거 정의가 어땠는지는 기록이 없어 확인하지 못했다.
- `verifier` 3,059건, `security-reviewer` 939건 같은 요청은 이미 GPT 프록시 모델로 돌아 Claude 한도 밖에 있다. 대신 도구 오류율이 22~45%로 높다.

### 서브에이전트는 읽기를 하나씩 순서대로 한다

- 한 응답에서 도구를 하나만 부른 비율은 메인 61%, 서브에이전트 71%다.
- 읽기 전용 도구(Read, Grep, Glob 등) 하나만 부른 요청이 3번 이상 이어진 구간은 서브에이전트에서 951구간, 4,872요청이다. 메인에서는 761요청이다. 이 가운데에는 Grep 결과를 보고 Read하는 것처럼 앞 결과에 기대는 호출도 있으므로, 이 수는 합칠 수 있는 요청 수의 상한이다.
- 메인에는 `# Tool routing`의 "Issue independent lookups in one message"가 들어가지만, 서브에이전트 맥락(`subagentNote`)에는 같은 문장이 없었다. 병렬 호출 안내는 체이닝 차단 문장에만 붙어 있었고, 체이닝 차단은 기본으로 꺼져 있다.

### 시간은 모델 생성이 더 크다

- 모델 생성 시간은 메인 Opus 52시간, 서브에이전트 Opus 76시간이다. 도구 시간은 메인 48시간, 서브에이전트 49시간이다. 메인 도구 시간 가운데 `AskUserQuestion` 4.8시간은 사용자를 기다린 시간이다.
- 요청당 생성 시간 중앙값은 Opus 4.8초, Sonnet 3.1초, Haiku 2.6~3.7초다.
- 속도를 올리려면 요청 수를 줄여야 한다. 독립된 호출은 한 응답에 묶고, 위임할 때는 더 빠른 모델을 쓴다.

### 5분 캐시 만료는 대기가 아니라 다시 이어 쓰기에서 나온다

- 서브에이전트에서 직전 요청보다 5분 넘게 지나 캐시를 대부분 새로 쓴 요청은 174회, 비용의 약 5%다.
- 그 직전 요청은 도구 없이 끝난 응답이 102회, `SubagentHandback` 46회였다. Bash를 기다린 경우는 20회뿐이다. 끝난 서브에이전트를 5분 넘게 지나서 SendMessage로 다시 이어 쓴 경우가 대부분이다.
- 그래서 "오래 기다리지 말라"는 안내로는 줄일 수 없다. 이 비용과 이어 쓰기로 맥락을 지키는 이점 사이의 균형은 따로 판단할 문제라 바꾸지 않았다.

## 훅 API로 할 수 있는 것

- `agent.spawn`은 서브에이전트의 `model`과 `subagentType`을 다시 쓸 수 있다. effort는 spawn에 없다.
- `turn.step`은 요청마다 `model`과 `effort`를 바꿀 수 있다. 하지만 아래 두 이유로 쓰지 않는다.
  - 프롬프트 캐시는 모델마다 따로 있다. 대화 도중 모델을 바꾸면 컨텍스트 전체(메인 중앙값 18만 토큰)를 새 모델의 캐시에 다시 써야 해서, 작은 모델로 바꿔 아끼는 금액보다 더 든다. 작은 모델은 새로 시작하는 서브에이전트 단위로 정해야 한다.
  - effort 단계를 바꾼 값은 입력이 있는 다음 요청까지 기다렸다가 적용된다. 도구 결과만 있는 요청에서는 바뀌지 않으므로 "읽기 단계만 낮게" 같은 조정을 할 수 없다. 바로 적용되는 것은 숫자로 준 값뿐이다.
- 에이전트 정의는 사용자 범위(`~/.claude/agents`)에 있다. 모델·effort 라우팅은 j-cc가 하지 않고 사용자가 정의 파일에서 정한다.

## 바꾼 것

- `subagentNote`에 병렬 조회 규칙을 넣었다: "Send independent lookups (Read, Grep, Glob, exec) together as parallel calls in one message, not one per turn: each extra turn re-sends your whole context." (`hooks/prompt.ts`)
- 효과는 같은 조사를 다시 돌려 서브에이전트의 "한 응답의 도구 수"와 "읽기 하나짜리 요청이 이어진 구간"을 비교해 확인한다.
- 메인 세션에서 exec의 `cwd`가 세션 폴더와 같으면 안쪽 명령 앞에 `cd -- '<cwd>' && `를 붙이지 않는다(`hooks/exec.ts`의 `cwdToEnter`). 서브에이전트는 워크트리처럼 세션과 다른 폴더에서 돌 수 있으므로, 경로가 같아 보여도 `cd`를 그대로 붙인다.
  - A/B 시험 실행(`claude -p`, 허용 도구를 좁힌 설정)에서 모델이 세션 폴더를 `cwd`로 넘겼다. 그러자 엔진이 "This Bash command contains multiple operations. The following part requires approval: cd -- '…'"로 두 번 거절했고, 모델은 `cwd` 없이 다시 실행했다.
  - 실제 세션에서는 `cwd`를 준 exec 729회 가운데 이 오류가 2회뿐이었다. 대화형 세션의 권한 설정에서는 거의 나지 않는다. 다른 폴더를 `cwd`로 주는 경우는 그대로 `cd`를 붙인다.

## implementer 모델·effort A/B

### 방법

- 과제 3개를 만들었다. 모두 상위 에이전트가 쓰는 형식(맡은 파일, 수용 기준)으로 적었고, 수용 기준만 검사하는 숨은 테스트로 채점한다.
  - `ratelimit`: 토큰 버킷 버그 수정과 기능 추가, 2개 파일
  - `report`: CSV 집계를 Decimal로 바꾸고 `--top` 옵션 추가, 3개 파일
  - `ttlcache`: TTL·LRU 캐시와 데코레이터를 새로 구현
- 기준 구현을 직접 작성해 숨은 테스트를 모두 통과하는 것을 먼저 확인했다.
- 실행은 `claude -p --model <m> --effort <e> --plugin-dir <j-cc> --setting-sources project,local`이다. 시스템 프롬프트에 `implementer.md` 본문을 붙였고, Agent와 advisor는 막았다.
- 조합은 Opus medium, Sonnet medium, Opus low 세 가지다. 과제마다 3회씩, 모두 27회 돌렸다.
- 1회차 도중 exec `cwd` 수정(위 "바꾼 것")을 넣었다. 실행은 회차 순서로 돌아서 같은 회차 안의 조합끼리는 조건이 같다. 1회차 10건 가운데 6건은 `cd` 거절로 턴 두 번을 버렸다. 2·3회차에는 `cwd`를 준 exec 27회가 모두 거절 없이 돌았다.

### 결과

| 조합 | 숨은 테스트 | 비용 합(엔진 `total_cost_usd`) | 실행 시간 중앙값 | 턴 중앙값 |
|---|---|---|---|---|
| Opus medium | 84/84, 9/9 완전 통과 | $3.08 | 57초 | 11 |
| Opus low | 84/84, 9/9 | $2.70 (−12%) | 44초 (−23%) | 10 |
| Sonnet medium | 84/84, 9/9 | $1.55 (−50%) | 47초 (−18%) | 12 |

이 A/B는 implementer를 진짜 서브에이전트가 아니라 `-p` 메인 세션으로 돌렸다. 그래서 캐시 TTL(메인 1시간, 서브에이전트 5분)과 부모가 쓴 프롬프트의 모양이 실제와 다르다.

세 조합이 모두 만점이라, 이 정도 크기로 명세가 분명한 과제에서는 품질 차이가 드러나지 않았다(천장 효과). 그래서 이 결과만으로는 어려운 과제에서 회귀가 없다고 말할 수 없다.

### 공개 벤치마크 수치

어려운 과제의 수치는 조사 에이전트가 찾은 공개 자료로 보완했다. effort별 값은 Anthropic 발표 차트를 2차 출처(apidog)가 옮겨 적은 것이라 원문 표와 다를 수 있다.

- Terminal-Bench 4.0: Opus medium 57.6%, Opus low 38.5%, Sonnet medium 28.8%, Sonnet high 43.0%, Sonnet xhigh 61.5%(시도당 $5.30, Opus medium은 $2.94).
- FrontierCode Main: Opus medium 54.6%, Opus low 47.3%, Sonnet medium 36.5%, Sonnet high 49.4%.
- VulcanBench(독립, 23과제, Claude Code, 숨은 테스트): Opus medium 90.86(23/23 통과, 과제당 $2.84), Opus low 86.36, Sonnet medium 84.10(17/23, $3.00), Sonnet high 86.79(20/23, $2.39), Sonnet xhigh 90.20(22/23, $3.38). Sonnet 값은 공개 원자료 CSV(`swe-v4-sonnet55-v323-scores.csv`)에서, Opus 값은 모델 페이지에서 직접 확인했다. 이 측정은 Max 구독으로 했고 Claude Code의 refusal fallback이 켜져 있다. Opus 5.5는 max effort에서 응답의 47.8%를 Opus 4.8이 썼다고 밝힌다.
- 출처: <https://www.anthropic.com/claude-opus-5-5>, <https://www.anthropic.com/claude-sonnet-5-5>, <https://apidog.com/blog/claude-sonnet-5-5-benchmarks/>, <https://vulcanbench.com/models/claude-sonnet-5-5.html>, <https://vulcanbench.com/models/claude-opus-5-5.html>

어려운 과제에서는 Sonnet medium과 Opus low 모두 Opus medium보다 낮다. VulcanBench에서는 Sonnet medium의 과제당 비용($3.00)이 Opus medium($2.84)보다 오히려 높았다. 토큰을 더 많이 쓰기 때문이다. Sonnet이 Opus medium에 가까워지려면 xhigh가 필요하고, 그러면 과제당 비용은 $3.38로 더 오른다. 그러므로 implementer 전체를 Sonnet이나 Opus low로 바꾸면 어려운 과제에서 회귀할 가능성이 크다.

### 결론

- 작고 명세가 분명한 구현(이 A/B의 과제 수준)은 Sonnet medium이 Opus medium과 같은 결과를 비용 절반으로 낸다.
- 어렵거나 열린 과제는 Opus medium이 비용 대비 가장 낫다.
- 따라서 하나를 고르기보다 나누는 쪽이 맞다. Sonnet medium으로 도는 가벼운 구현 에이전트를 따로 두고, 메인이 과제 크기에 따라 고르게 한다. 정의 파일은 사용자 범위라 사용자가 정한다.
### Aider Polyglot Python 34문제

경계를 찾으려고 공개 과제로 한 번 더 쟀다. Aider Polyglot(<https://github.com/Aider-AI/polyglot-benchmark>)은 Exercism 697문제 가운데 어려운 225문제를 골라 만든 세트이고, 그 가운데 Python은 34문제다.

- **방법:** 문제 폴더에서 테스트 파일과 `.meta`, `.docs`를 빼고, `.docs`의 설명을 implementer 형식의 프롬프트에 넣었다. 실행이 끝나면 공식 테스트를 넣어 `pytest`로 채점했다. 공식 예시 답(`.meta/example.py`)으로 34문제가 모두 통과하는 것을 먼저 확인했다. 모델은 테스트를 보지 못한다. Aider는 실패한 테스트를 보여 주고 한 번 더 시키지만, 여기서는 그 단계가 없다.
- **1차:** 34문제 × Opus medium·Sonnet medium × 1회.
  - Opus 33/34(97%), $6.88
  - Sonnet 27/34(79%), $3.48
- **2차:** 결과가 갈렸거나 둘 다 실패한 7문제를 조합마다 3회 더 돌렸다.
  - Opus 20/21(95%), $3.98
  - Sonnet 11/21(52%), $2.10
- **문제별(1·2차 합계 4회):**
  - Sonnet: `dot-dsl` 0/4, `paasio` 0/4, `forth` 1/4, `go-counting` 2/4, `robot-name` 2/4, `pov` 3/4, `tree-building` 3/4
  - Opus: `tree-building` 2/4이고, 나머지 여섯 문제는 4/4
- **환산:** 문제별 통과율을 34문제에 적용하면 Opus 약 98.5%, Sonnet 약 87.5%다. 비용은 Sonnet이 약 절반이다(실행 중앙값 $0.10 대 $0.20).
- **실패 유형:**
  - 로직이나 프로토콜 세부(Sonnet): `paasio`의 컨텍스트 매니저 `__exit__` 반환값, `forth`의 음수 처리, `dot-dsl`의 검증, `robot-name`의 이름 다시 만들기
  - 명세에 없는 이름이나 문구를 맞히는 문제(양쪽): `go-counting`의 상수 이름 `NONE`, `tree-building`의 오류 문구, `pov`의 오류 문구
- **기록 손실:** 2차가 1차와 같은 작업 폴더 이름(`-1`)을 써서, 7문제의 1차 채점 기록이 덮어써졌다. 결과 줄(`round1.jsonl`)은 남아 있다.

### 결론과 적용

- 명세가 모든 동작을 적은 과제(직접 만든 3과제)에서는 Sonnet medium이 Opus medium과 같았다.
- 명세가 언어 관례나 세부 동작을 암묵적으로 남긴 과제(Exercism)에서는 Sonnet medium이 약 11%p 낮았다.
- 그래서 사용자 에이전트 정의를 둘로 나눴다(`~/.claude/agents`, j-cc 밖).
  - `implementer-lite`(Sonnet medium): 1~2개 파일이고 기대 동작이 모두 수용 기준에 적힌 변경에만 쓴다. 명세에 없는 동작(오류 문구, 프로토콜 세부, 호출자가 가져다 쓸 이름)은 추측하지 말고 assumptions에 적게 했다.
  - `implementer`(Opus medium): 설명을 여러 모듈, 적히지 않은 관례, 설계 판단, 원인을 모르는 버그로 좁혔다. 전에는 "the default for bounded production changes"라고 적혀 있어 새 에이전트보다 먼저 선택될 수 있었다.
- 효과는 1~2주 뒤 이 조사를 다시 돌려 확인한다. 볼 지표는 `implementer-lite`의 도구 오류율, 같은 과제의 재위임, 비용 비율이다.

## 바꾸지 않은 것

- 사용자 설정의 `claude-opus-5-5` `autoCompactWindow: 400000`: 낮추면 메인 캐시 읽기가 줄지만, 압축할 때 맥락을 잃을 위험이 있다. 사용자 설정이라 j-cc에서 바꾸지 않는다.
