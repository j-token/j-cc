# auto 모드에서 호출이 막히던 원인

auto 모드에서 j-cc를 쓰면 위험하지 않은 호출도 자주 막혔다. Claude Code 2.1.330에서 원인 두 가지를 확인했고, 하나는 확인하지 못했다.

## 1. 훅이 입력을 바꾸면 같은 응답의 다른 호출이 판정을 잃는다

서버 분류기는 한 응답에 든 도구 호출을 함께 판정한다. 그중 하나라도 훅이 입력을 바꾸면 나머지 호출의 판정을 버리고 이렇게 거부한다.

```
The server-side auto mode classifier gave no verdict for mcp__j-cc__exec: another call in this response was changed after auto mode reviewed it, or could not be confirmed unchanged
```

j-cc는 `limit` 없는 Read에 `limit: 500`을, `head_limit` 없는 Grep에 `head_limit: 100`을 넣고 있었다. j-cc가 독립된 조회를 한 메시지에 묶으라고 안내하므로 Read·Grep과 exec가 한 응답에 함께 오는 일이 많았다.

같은 세션에서 확인한 결과:

- `head_limit`을 직접 준 Grep과 exec를 한 응답에 보내면 exec가 실행됐다.
- `head_limit` 없는 Grep과 exec를 한 응답에 보내면 exec가 위 문구로 거부됐다.

### 응답의 도구 목록으로 가려 넣는 방법은 쓸 수 없다

응답의 호출이 모두 Read·Grep·Glob일 때만 기본값을 넣으려 했지만 두 가지 이유로 동작하지 않았다.

- `turn.step` 결과의 `toolUses`에는 `name`과 `input`만 있고 `tool_use_id`가 없다.
- Read 같은 읽기 도구는 응답이 끝나기 전에 시작한다. `claude -p --plugin-dir`로 실험하니 Read의 `tool.call`이 `turn.step`보다 먼저 와서 기본값이 한 번도 들어가지 않았다.

그래서 Read·Grep 입력은 바꾸지 않는다. 범위 없이 Read한 파일이 끝까지 읽히지 않았을 때 남은 줄 수를 알리는 안내(`context`)는 입력을 바꾸지 않으므로 그대로 둔다.

대가가 있다. 엔진은 범위 없는 Read로 256KB가 넘는 파일을 읽지 않고 오류를 낸다. 예전에는 j-cc가 500줄 한도를 넣어 이런 파일도 앞부분이 읽혔지만, 이제 모델이 `offset`/`limit`을 주고 다시 읽어야 한다. Grep도 엔진 기본값(250개)까지 돌려준다.

### 다른 훅도 같은 문제를 일으킨다

사용자 설정의 PreToolUse 훅이 Agent 호출의 `description`을 바꾸는 경우에도 같은 일이 생긴다. 그 Agent 호출은 "a hook changed this call's input after auto mode reviewed it"로, 같은 응답의 exec는 위 문구로 거부됐다. j-cc가 고칠 수 없는 설정이라 사용자에게 알린다.

## 2. 막을 규칙이 없는 명령에 붙은 `# j-cc:allow:` 주석

auto 모드가 `# j-cc:allow: <이유>` 주석이 붙은 일괄 수정 명령(스크립트로 여러 파일을 고치고 포매터를 돌린 뒤 diff를 보는 체인)을 `Undermining Oversight`로 막은 일이 있었다. 그 명령은 체이닝 차단이 꺼진 기본 설정에서 j-cc 규칙에 걸리지 않으므로 주석이 필요 없었다. 그런데 exec 경로는 필요 없는 주석을 알리지 않았다.

이제 j-cc는 막을 규칙이 없는 명령에 주석이 붙으면 실행하지 않고 주석 없이 다시 내라고 알린다. 입력에서 주석을 지워 실행하면 1번처럼 분류기 판정이 무효가 되므로 지우지 않고 거절한다. 주석 안내에는 사용자 승인이나 급함을 이유로 쓰지 말라는 문장을 넣었다.

모델이 스크립트를 읽고 내린 차단(끝나지 않는 루프 등)은 주석과 상관없이 다시 돌기 때문에, 그 차단 문구에서는 주석을 권하지 않는다. 권하면 "주석이 필요 없다"는 거절과 번갈아 돈다.

### 확인하지 못한 것

`git status --short # j-cc:allow: 사용자 요청 작업`만 따로 보냈을 때 분류기는 막지 않았다. 따라서 그때의 차단이 주석 때문인지, 여러 파일을 한 번에 고치는 명령 전체 때문인지는 확인하지 못했다. 그 세션에서 체이닝 차단이 켜져 있었다면 주석은 필요했고, 이 수정은 그 경우를 다루지 않는다.
