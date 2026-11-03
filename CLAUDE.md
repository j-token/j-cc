# j-cc

Claude Code에서 Claude 모델이 전용 도구를 쓰고, 사용자 지침을 따르고, 오래 걸리는 명령을 기다리지 않도록 하네스를 조정하는 플러그인이다. 구조와 기능은 [README.ko.md](README.ko.md)에 있다.

## 구조

- `hooks/`: mod(함수 훅) 코드와 테스트. `register.ts`가 훅을 등록하고, 규칙은 `rules.ts`, exec/poll 도구는 `exec.ts`에 있다.
- `.claude-plugin/`: 플러그인 매니페스트(`plugin.json`)와 마켓플레이스 정의.
- `docs/`: 조사·결정 기록. 동작을 바꾼 이유와 실험 결과를 남긴다.

## 변경을 적용하는 위치

- 동작 변경은 `~/.claude/settings.json` 같은 사용자 설정이나 프로젝트 설정을 고치지 않고 플러그인(훅, 에이전트, 플러그인 `settings.json`)에 구현한다.
- 플러그인만으로 할 수 없는 변경이면 설정을 대신 고치지 말고 그 이유와 대안을 먼저 알린다.

## 검증

코드를 바꾸면 아래 두 명령을 돌린다.

```
claude plugin validate .
claude plugin test .
```

- 테스트는 `hooks/*.test.ts`에 둔다.
- 실제 엔진에서 확인할 때는 `claude -p --plugin-dir <j-cc 경로>`를 쓴다.

## 문서

- 기능이나 옵션을 바꾸면 `README.md`와 `README.ko.md`를 함께 고친다.
- 문서와 테스트 픽스처에 로컬 경로, 사용자 이름, 다른 개인 프로젝트 이름을 넣지 않는다. 경로는 `<j-cc>`, `C:\Users\me`처럼 적는다.

## 기여

- 버그 제보와 제안은 GitHub 이슈로 받는다. 외부 PR은 받지 않는다.
