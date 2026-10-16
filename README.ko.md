# j-cc

Claude Code에서 Claude 모델(특히 Opus 5.5)이 **전용 도구를 쓰고, 사용자 지침과 스킬을 따르고, 오래 걸리는 명령을 기다리지 않도록** 하네스를 조정하는 플러그인입니다. 외부 모델이나 API 키 없이 Claude Code 안에서만 동작합니다.

[English](README.md)

## 왜 필요한가

Claude Code 2.1.301을 조사한 결과 다음 사실을 확인했습니다.

- Claude Code는 **Opus 5.5에만 "bash-first" 실험(`thrifty_sonic`)을 강제로 켭니다.** 이 실험이 켜지면 두 가지가 바뀝니다.
  - Bash 도구 설명에서 "find, grep, cat, head, sed 대신 전용 도구를 쓰라"는 `IMPORTANT` 경고가 빠집니다.
  - auto mode에서 "cat, head, sed -n으로 읽고 grep, find로 검색하고 sed나 heredoc으로 고쳐도 된다. 선택은 너에게 있다(The choice is yours)"는 리마인더가 붙습니다.
- 프록시로 연결한 GPT 모델은 Claude Code가 모르는 모델이라 이 실험이 꺼져 있습니다. 그래서 같은 하네스에서도 GPT 모델이 전용 도구를 더 잘 씁니다.
- 실제 세션 기록 60일치(2,558개 파일)를 비교했습니다. GPT 표본은 40세션으로 작고 작업 종류도 달라서 차이를 모두 모델 탓으로 볼 수는 없습니다.

| 지표 | Opus 5.5 (메인) | GPT (메인) |
|---|---|---|
| 셸 100회당 파일 보기 / 검색 | 25.9 / 28.9 | 0 / 0.8 |
| 60초 넘는 포그라운드 명령 | 434건 | 0건 |
| 포그라운드에서 기다린 시간 | 34시간 | 0.3시간 |
| Skill을 쓴 세션 비율 | 35.5% | 63.6% |

## 하는 일

| 기능 | 방법 |
|---|---|
| bash-first 실험 끄기 | 세션 시작 시 `CLAUDE_CODE_THRIFTY_SONIC=0`을 설정합니다. 엔진이 이 변수를 가장 먼저 읽으므로 문구 매칭에 의존하지 않습니다. 사용자가 이미 값을 정했다면 건드리지 않습니다. |
| 도구 설명 보강 | Bash와 PowerShell 설명 끝에 전용 도구와 `run_in_background` 사용 지침을 덧붙입니다. |
| 시스템 프롬프트 보강 | `# User workflow first` 섹션(CLAUDE.md 우선, 스킬 먼저 확인)과 `# Tool routing` 섹션을 추가합니다. |
| 중간 보고 언어 | `language` 안내에 "도구 호출 사이의 짧은 진행 보고도 설정 언어로 쓴다"는 문장을 덧붙입니다. |
| 셸 오용 차단 | 셸로 파일을 보기·검색·쓰기·수정하면 막고 Read, Grep, Glob, Write, Edit로 안내합니다. |
| 루프·대기 차단 | `tail -f`, 무한 루프, 포그라운드 폴링·대기, 포그라운드 dev 서버를 막고 Monitor, `run_in_background`, `/loop`, `CronCreate`로 안내합니다. |
| 오래 걸리는 명령의 백그라운드 전환 | 설치, Docker 빌드, 학습·평가 스크립트, 120초보다 긴 `timeout`, 이전에 45초 이상 걸린 명령은 자동으로 `run_in_background: true`로 실행하고, 기다리지 말고 다른 일을 하라고 알립니다. 메인 세션에만 적용합니다. 시스템 프롬프트의 `# Automatic backgrounding (j-cc)` 섹션이 이 동작을 미리 알려, 완료 알림 전에는 결과에 의존하는 단계를 실행하지 않게 합니다. |
| CC 내부 모델 판정 | 규칙으로 정하지 못한 명령은 Claude Code의 `$.model`(Haiku)로 판정합니다. 명령이나 실행 스크립트에 루프·대기·서버 단서가 있을 때만 호출하며, 결과는 명령별로 캐시합니다. 판정 라벨은 `quick`, `long_job`, `wait_poll`, `endless`, `server`입니다. |
| 회귀 감지 | 환경변수를 설정했는데도 셸 우선 리마인더가 다시 나타나면 토스트로 알리고, 예비로 해당 문단을 바꿉니다. |

## 설치

```
/plugin marketplace add j-token/j-cc
/plugin install j-cc@j-cc
```

hooks module API를 쓰므로 Claude Code 2.1.301 이상이 필요합니다.

## 설정

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `modelJudge` | `true` | 애매한 명령을 CC 내부 모델로 판정합니다. 끄면 결정적 규칙만 사용합니다. |

## 우회

잘못 막힌 명령은 이유를 적은 주석을 붙여 다시 실행합니다. 이전 플러그인 표식 `# use-right-tool:allow:`도 인식합니다.

```
grep -rn TODO src # j-cc:allow: 바이트 오프셋이 필요함
```

j-cc는 작업 흐름을 돕는 도구이며 보안 경계가 아닙니다.

## 제한

- 조직이 관리하는 Claude Code에서는 `prompt.attachment`와 `prompt.compose` 훅이 사용자가 설치한 플러그인에서 실행되지 않습니다. 이 경우 셸 차단, 도구 설명 보강, 백그라운드 전환, 환경변수 설정만 동작합니다.
- `CLAUDE_CODE_THRIFTY_SONIC`은 비공개 실험 변수라 이후 빌드에서 바뀔 수 있습니다. 그런 일이 생기면 회귀 감지 토스트가 알려 줍니다.
- 규칙은 근사 판단입니다. 실행 시간 기록은 명령 키(`npm test`, `cargo build`, `python train.py` 등) 단위로 묶입니다.

## 개발

```
claude plugin validate .
claude plugin test .
```
