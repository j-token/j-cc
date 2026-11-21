# 스킬 목록 설명을 자르지 않음

## 증상

pi에서는 작업에 맞는 스킬을 잘 불러오는데, j-cc를 켠 Claude Code에서는 맞는 스킬이 있어도 부르지 않고 직접 처리하는 경우가 있었다.

## 원인

j-cc는 `skill_listing` 첨부의 각 설명을 첫 문장(최대 120자)으로 줄이고, 항목에 이어지는 줄은 버렸다. 스킬 설명은 대개 첫 문장에 "무엇을 하는지", 그 뒤에 "언제 쓰는지"를 적는다. 줄이면 모델이 작업과 대조할 부분이 사라진다.

엔진 원본과 줄인 결과(2026-11-21, Claude Code 세션 transcript의 `skill_listing` 첨부 기준):

- `stop-slop`: "Remove AI writing patterns from prose. ~~Use when drafting, editing, or reviewing text to eliminate predictable AI tells.~~"
- `supabase:supabase-postgres-best-practices`: "Postgres best practices maintained by Supabase, for Postgres running anywhere. ~~Load this skill BEFORE writing or changing anything that lives in a Postgres database: creating or altering tables …~~"
- `claude-api`: 둘째 줄부터 오는 `TRIGGER …`, `SKIP …` 줄이 통째로 빠짐
- `commit-rule`, `pr-rule`, `branch-rule`: 끝의 `예시 지시)커밋해줘,…` 가 빠짐

pi(1.6.0)는 설명을 자르지 않는다. `dist/core/skills.js`의 `formatSkillsForPrompt`는 스펙 상한 1024자를 넘으면 경고만 하고 설명 전체를 `<available_skills>`에 넣고, `dist/core/system-prompt.js`가 그 결과를 시스템 프롬프트에 붙인다.

## 실험

`claude -p --model opus --output-format stream-json`을 빈 임시 디렉터리에서 돌리고 응답의 `Skill` 호출을 셌다. 쓰기와 셸 도구는 막았다. 설치된 j-cc는 끄고, 켠 조건에서는 `--plugin-dir`로 j-cc를 불렀다. init 이벤트의 도구 목록에 `mcp__j-cc__*`가 있는지로 조건이 맞게 갈렸는지 확인했다.

1차(조건마다 프롬프트당 2회). 기존 j-cc와 수정 후 실행 사이에 다른 작업이 같은 트리를 바꿔서, 이 비교만으로는 원인을 단정할 수 없다.

- `sql`(Postgres 마이그레이션 작성): j-cc 끔 0/2, 기존 j-cc 0/2, 수정 후 2/2
- `llm`(LLM으로 요약하는 스크립트, `claude-api`): 셋 다 2/2
- `prose`(문단 다듬기, `stop-slop`): 끔 0/2, 기존 2/2, 수정 후 2/2
- `pdf`(PDF 합치기, 설명이 잘리지 않음): 끔 0/2, 기존 2/2, 수정 후 2/2

2차(교란 제거, 프롬프트당 4회). 같은 시점의 트리를 두 벌 복사해 한쪽만 스킬 목록을 예전처럼 첫 문장으로 줄이고, 두 조건을 동시에 돌렸다.

- `sql`(트리거가 첫 문장 뒤에만 있음): 줄임 0/4, 그대로 4/4
- `pixel`(Unity 2D 레트로 게임이 흐리고 떨림, `unity:2d-pixel-perfect`): 둘 다 4/4
- `prose`(`stop-slop`): 둘 다 4/4

설명을 자르면 첫 문장만으로 작업과 이어지지 않는 스킬(`sql`)을 놓쳤다. 첫 문장만으로도 짐작할 수 있는 스킬(`pixel`, `prose`)은 차이가 없었다. 또 j-cc를 끈 조건이 가장 적게 불렀다. 스킬 목록 머리말과 `# User workflow first`의 규칙이 스킬을 먼저 보게 하고, 설명 전체가 있어야 그 규칙이 맞는 스킬을 찾는다. 프롬프트 수가 적어 비율보다 방향만 본다.

## 비용

이 환경(스킬 91개)의 엔진 원본 목록은 28,993자이고, 예전처럼 줄이면 9,202자다. 수정 후에는 약 19,800자(대략 5천 토큰 안팎)가 더 실린다. 목록은 대화 앞쪽에 한 번 실려 캐시되므로 매 요청 비용은 캐시 읽기 단가로 붙는다. 가장 긴 항목은 `dataviz`(1,447자), `code-review`(1,216자)다.

## 결정

- 스킬 설명은 자르지 않는다. 같은 이름의 중복 항목은 빼고, 뺀 항목에 이어지는 줄도 함께 뺀다(`prepareSkillListing`).
- 목록 크기는 엔진이 토큰 예산으로 정한다. 예산을 넘으면 엔진이 일부 스킬을 이름만 남기는데(`unity:ui` 등), 이건 j-cc가 고칠 수 없다.
- 에이전트 목록은 그대로 첫 문장으로 줄인다. 에이전트는 이번 실험 범위 밖이다.
