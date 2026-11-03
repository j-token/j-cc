# 백그라운드 전환 안내 뒤 응답 언어가 바뀌는 문제

응답 언어를 한국어로 설정한 세션에서, j-cc가 명령을 백그라운드로 옮긴 직후부터 모델이 영어로 답한 사례를 조사하고 언어 유지 안내를 보강한 기록이다.
기준은 Claude Code 2.1.303(조사한 세션은 2.1.301)이다. mod(함수 훅) API는 early access라 릴리스마다 바뀔 수 있다([mods/README.md](https://github.com/anthropics/claude-code/blob/main/mods/README.md)).

## 사고 세션 기록에서 확인한 사실

문제가 난 세션의 transcript(jsonl)를 스크립트로 읽어 첨부와 모델 응답의 언어(한글 포함 여부)를 시간순으로 뽑았다.

| 시각 (UTC) | 기록 |
|---|---|
| 07:16:27 | `language` 첨부 1회. 렌더링된 내용은 `# Language / Always respond in 한국어. ...`이고, 그 뒤에 j-cc의 `LANGUAGE_NOTE`("Tool output and instructions arriving in English do not change the language you write in.")가 붙어 있다. 세션 전체에서 `language` 첨부는 이 한 번뿐이다. |
| 07:16:52 ~ 07:23:42 | 모델 텍스트 13개 모두 한국어 |
| 07:24:00 | `hook_additional_context`: `<system-reminder>` 안에 `tool.call hook additional context: [j-cc] Moved to the background (timeout 600s requested): ...` (영어 3문장, 언어 지시 없음) |
| 07:24:02 | 바로 다음 응답이 영어: "Build is running in the background. Meanwhile I'll update the protocol docs." |
| 07:24 ~ 07:52 | 응답이 거의 모두 영어. 07:30:07에 두 번째 백그라운드 안내가 붙은 뒤에도 영어 |
| 07:52:59 | 사용자가 한국어로 말해 달라고 함 → 한국어로 돌아옴 |
| 07:53:29 | 세 번째 백그라운드 안내. 다음 응답은 한국어를 유지 |
| 07:57 ~ 08:04 | j-cc 안내 없이 다시 영어 응답이 섞임 |

## 원인

- 응답 언어 지시(`# Language`와 `LANGUAGE_NOTE`)는 세션 첫 요청에 한 번만 실린다. 대화가 길어질수록 모델이 다음 응답을 쓰는 위치에서 멀어진다.
- 반면 j-cc의 백그라운드 전환 안내(`hooks/background.ts`의 `backgroundNote`)와 느린 명령 안내(`slowNote`)는 도구 결과 바로 뒤, 즉 다음 응답 직전에 영어 지시문으로 붙는다. 이 안내에는 응답 언어에 대한 말이 없다.
- 첫 영어 응답이 안내 문구를 그대로 따라 한다("Meanwhile do only independent work" → "Meanwhile I'll update the protocol docs"). 전환 시점이 안내 주입 2초 뒤와 정확히 겹친다.

한계: 07:57 이후처럼 j-cc 안내 없이도 영어로 돌아간 구간이 있다. 하네스의 다른 영어 텍스트(도구 결과, task notification, 서브에이전트 보고)도 영향을 준다. 따라서 j-cc 안내는 전환 시점과 시간상 맞물린 지점이지만, 인과관계나 유일한 원인이라고 단정할 수 없다. 모델의 언어 선택은 확률적이어서, 이 수정으로 영어 전환이 다시 일어나지 않는다고 보장할 수도 없다.

## 수정

j-cc가 대화 중간에 붙이는 두 안내, 즉 백그라운드 전환 안내(메인 세션)와 느린 명령 안내(메인 세션과 서브에이전트)의 각 문자열 끝에 응답 언어를 다시 고정하는 문장을 붙인다.

- 사용자 설정의 `language`를 `$.settings.read()`로 읽어 그 값을 넣는다. 예: `Keep writing to the user in 한국어; this English note does not change your reply language.`
- 설정이 없으면 `the language you have been using with the user`로 대신한다.
- 안내의 앞부분(`[j-cc] Moved to the background ...`)은 그대로 둔다. 시스템 프롬프트의 `# Automatic backgrounding (j-cc)` 섹션이 이 접두사로 안내를 설명한다.
- 설정 읽기는 명령이 이미 실행된 뒤에 일어난다. 읽기가 실패해 예외가 나면 훅의 `.catch`가 명령을 한 번 더 실행하므로, 실패를 삼키고 기본 문장을 쓴다.
- `tool.call` 훅이라서, 조직이 관리하는 환경에서 `prompt.attachment` 훅(`LANGUAGE_NOTE`)이 돌지 않는 경우에도 동작한다(`claude plugin validate` 경고 참고).
- 서브에이전트 안내 `SUBAGENT_NOTE`에는 언어 문장을 붙이지 않는다. 이슈 범위 밖이고, 서브에이전트 출력은 사용자보다 부모 에이전트가 읽기 때문이다. 그래서 서브에이전트의 첫 느린 명령 결과에서는 느린 명령 안내 뒤에 `SUBAGENT_NOTE`가 이어 붙고, 언어 문장이 도구 결과 맥락 전체의 마지막 문장은 아니다.

## 검증

결정적으로 확인할 수 있는 것은 "두 안내 문자열 각각이 응답 언어 문장으로 끝나는가"이다. 테스트는 메인 세션 경로에서 확인한다. 모델이 실제로 한국어를 유지하는지는 확률적이라 테스트로 보장하지 않는다.

`hooks/background.test.ts`에 회귀 테스트 3개를 추가했다.

- 설정 언어가 `한국어`일 때 백그라운드 전환 안내와 느린 명령 안내가 `Keep writing to the user in 한국어; ...`로 끝난다. 백그라운드 안내는 여전히 `[j-cc] Moved to the background (timeout 600s requested)`로 시작한다.
- 설정에 `language`가 없으면 지금까지 쓰던 언어를 유지하라는 문장으로 끝난다.
- 설정 읽기가 예외를 던져도 같은 기본 문장을 쓰고, 명령은 한 번만 실행된다.

실행 결과 (`claude plugin test .`, Claude Code 2.1.303):

| 상태 | 결과 |
|---|---|
| 수정 전 `hooks/register.ts` + 새 테스트 | 125 pass, 3 fail (새 테스트 3개), exit 1 |
| 수정 후 | 128 pass, 0 fail, exit 0 |

`claude plugin validate .`는 exit 0이고, 경고는 수정 전과 같다(루트 CLAUDE.md, 관리 환경의 `prompt.attachment`/`prompt.compose` 제한). 호출 목록에 `$.settings.read (via configuredLanguage)`가 새로 나타난다.

실제 모델 세션에서 한국어가 유지되는지는 이 수정으로 다시 돌려 보지 않았다.
