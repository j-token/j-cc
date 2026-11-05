# GPT 모델의 에이전트 메시지·스티어링·시간 감지 조사

2026-11-05, Claude Code 2.1.318 기준. GPT 모델을 프록시로 붙였을 때 보이는 세 가지 장점이 Claude 모델에서도 가능한지 조사했다.

## 결론

- Claude Code 엔진에는 GPT를 판별하는 분기가 없다. 모델별 분기는 Claude 쪽에만 있고, 그중 Opus 5.5에 해당하는 위임 억제 분기도 없다.
- GPT의 스티어링이 빨라 보이는 주된 이유는 도구 호출이 짧기 때문으로 보인다. 엔진은 턴 도중 받은 사용자 메시지를 도구 결과가 돌아올 때만 모델에 건넨다.
- GPT가 SendMessage를 많이 쓰는 것은 작업 구성의 영향이 크다. 프롬프트 차이로 설명할 근거는 찾지 못했다.
- Claude Code에는 경과 시간을 알려 주는 장치가 있지만 모든 모델에서 꺼져 있다. Codex는 도구 결과마다 `Wall time`을 붙인다.

## 엔진의 모델별 분기

- `opus_5_prompt_bundle` 기능이 있는 모델(Opus 5)은 위임 스티어가 `no_nudges`로 고정되고 `opus5_reduced_delegation` 섹션("요청 없으면 Agent 도구를 쓰지 말라")을 받는다.
- Opus 5.5의 카탈로그 기능 목록에는 이 기능이 없다. 그래서 Opus 5.5와 카탈로그에 없는 GPT 모델 모두 기본값(`default`, 위임 안내 포함)을 받는다. GrowthBook 값은 확인하지 못했다.
- 모델 기능은 `CLAUDE_CODE_MODEL_CAPABILITIES`(`모델=기능,-기능;...`)로 켜고 끌 수 있다.

## 세션 기록 측정 (2026-09-01 ~ 11-05, 메인 루프)

- 30초 이상 걸린 도구 호출(1,000회당): Opus 5.5 39.6, Opus 5 51.6, GPT 4.6
- 도구 호출 시간 p99: Opus 5.5 97초, GPT 22초
- SendMessage(메인 1,000회당): Opus 5.5 12.5, GPT 205.7. 다만 GPT의 449회 중 274회가 세션 하나에서 나왔다.
- 사용자 메시지가 입력된 뒤 전달될 때까지의 지연은 표본이 Opus 5.5 10건뿐이라 비교하지 못했다.
  - 기록에서 `queued_command` 첨부의 시각은 입력 시각이고, 전달 시각은 `queue-operation`의 `remove`(`absorbed_mid_turn`)다.

## exec·poll 대기 끊기 실험

- 사용자가 턴 도중 메시지를 보내면 `prompt.submit` 훅에서 메인 루프의 exec·poll 대기를 끊어, 메시지가 바로 다음 도구 결과와 함께 전달되게 해 보았다.
- `claude -p --input-format stream-json`으로 확인한 결과, `prompt.submit`은 메시지가 들어온 시점이 아니라 exec 결과가 나간 직후에 실행됐다. 메시지는 exec 시작 4초 뒤 큐에 들어갔고, 훅은 그로부터 26.8초 뒤 exec 결과가 나간 8ms 뒤에 실행됐다. 그래서 대기를 끊지 못했다.
- j-cc 없이 내장 Bash만 돌려도 `-p`에서는 같았다. 그래서 j-cc 훅 때문이 아니라 `-p` 입력 경로의 동작이다.
- 대화형 TUI(ConPTY로 구동, Sonnet 5.5, `sleep 28`을 `yield_time_ms` 30000으로 실행, 4초 뒤 메시지 입력)에서는 동작했다.
  - 변경본: 메시지 입력 0.2초 뒤 `Process running in the background with session_id 1 (wall 3.9s)`로 돌아왔다.
  - 변경 전: 27.5초 뒤 `Process exited with code 0 (wall 31.3s)`로 돌아왔다.

## 시간 감지

- Claude Code는 날짜를 대화 시작에 한 번 준다.
- `elapsed_time_reminder`("Elapsed time so far: Xm YYs")는 엔진에 있지만 카탈로그의 어느 모델에도 켜져 있지 않다.
- `per_turn_timing` API 베타는 `CLAUDE_CODE_PER_TURN_TIMING` 환경 변수가 있어야 켜진다.
- Codex(openai/codex main)는 셸·도구 결과마다 `Wall time: N seconds`를 붙이고, `<current_date>`와 `<timezone>`을 환경 컨텍스트로 준다. 매 초 현재 시각을 주는 `<current_time_reminder>`는 기본으로 꺼진 실험 기능이다.
- j-cc의 exec는 이미 `wall N.Ns`를 상태 줄에 넣는다. 다른 도구 결과에는 시간이 없다.
