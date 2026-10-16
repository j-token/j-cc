# 도구를 처음부터 로딩하는 방법

ToolSearch 뒤로 지연(deferred)된 도구를 세션 시작부터 스키마째 로딩하는 방법을 조사한 결과를 기록한다.
기준은 Claude Code 2.1.301과 2026-10-16 시점의 공식 문서이며, 직접 실행해서 검증하지는 않았다.
도구를 목록에서 빼는 방법은 [removing-tools.md](removing-tools.md)에 있다.

## 요약

- MCP 도구는 설정으로 처음부터 로딩할 수 있다. `ENABLE_TOOL_SEARCH`, 서버의 `alwaysLoad`, 도구의 `_meta`를 쓴다.
- 내장 도구는 설정이나 환경 변수가 없다. mod의 `tool.describe` 훅에서 `isDeferred: false`를 돌려주는 방법 하나뿐이다.

## MCP 도구

| 방법 | 범위 | 효과 |
|---|---|---|
| `ENABLE_TOOL_SEARCH=false` | MCP 도구 전체 | 지연 없이 전부 처음부터 로딩 |
| `ENABLE_TOOL_SEARCH=auto` 또는 `auto:N` | MCP 도구 전체 | 도구 정의 합계가 컨텍스트의 10%(또는 N%) 미만이면 처음부터 로딩 |
| `ENABLE_TOOL_SEARCH=true` | MCP 도구 전체 | `ANTHROPIC_BASE_URL`이 비공식 호스트여도 지연 유지 |
| unset (기본값) | MCP 도구 전체 | 전부 지연. 일부 모델과 조건에서는 처음부터 로딩으로 전환 |
| 서버 설정에 `"alwaysLoad": true` | 서버 단위 | `ENABLE_TOOL_SEARCH` 값과 상관없이 그 서버의 도구를 처음부터 로딩. 모든 서버 종류에서 쓸 수 있음 |
| 도구 정의의 `_meta["anthropic/alwaysLoad"]: true` | 도구 단위 | 서버를 만드는 쪽에서 지정. 사용자가 서버에 `alwaysLoad: false`를 주면 덮어씀 (v2.1.287 이상) |

- `ENABLE_TOOL_SEARCH`는 settings.json의 `env`에도 넣을 수 있다.
- `alwaysLoad` 서버는 시작할 때 연결을 기다리는데, 기본 연결 제한 시간인 5초까지만 기다린다.
- `CLAUDE_CODE_MCP_STARTUP_WAIT_MS`는 첫 턴 대기 시간만 조절하며 로딩 방식은 바꾸지 않는다.

`.mcp.json` 예:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "my-server",
      "alwaysLoad": true
    }
  }
}
```

## 내장 도구

mod의 `tool.describe` 훅이 유일한 수단이다. 결과로 `isDeferred: false`를 돌려주면 스키마가 프롬프트의 도구 목록에 실리고, `true`를 돌려주면 ToolSearch 뒤로 간다. MCP 도구에도 같은 방법이 통한다.

```ts
on("tool.describe", { tool: "Monitor" }, async ($, e, next) => ({
  ...(await next(e)),
  isDeferred: false,
}))
```

- 응답은 `$.ui.invalidate("tool.describe")`를 부를 때까지 캐시된다. 응답이 바뀌면 다음 턴에 반영되고 프롬프트 캐시 전체가 다시 쓰인다.
- ToolSearch 뒤에 있는 MCP 도구는 이 훅이 두 번 실행된다. 처음에는 짧은 설명으로, 불러온 뒤에는 전체 설명으로 실행된다.
- `$.tool.register`로 만든 도구는 spec에 `isDeferred: false`를 주면 처음부터 로딩된다. `tool.describe` 응답이 spec보다 우선한다.

### 확인되지 않은 것

- 어떤 내장 도구가 지연 대상인지 고르는 기준은 문서에 없다. SDK 문서에는 "Bash, Read, Edit 같은 핵심 도구는 처음부터 로딩한다"는 문장만 있다.
- `ENABLE_TOOL_SEARCH=false`가 내장 도구에도 적용되는지. CLI 문서는 MCP 도구만 언급한다. SDK 문서에는 내장 도구도 지연 대상이라고 읽히는 문장이 있어서, 적용될 가능성은 있다.
- `permissions.deny`에 `"ToolSearch"`를 넣으면 ToolSearch가 꺼지고 세션이 tool search 없이 동작한다. 이때 지연된 도구가 처음부터 로딩되는지는 확인하지 못했다.
- 플러그인 `.mcp.json` 서버에도 `alwaysLoad`가 적용되는지.

## tool search가 저절로 꺼지는 조건

이 조건에서는 모든 도구가 처음부터 로딩된다.

- **모델:** Opus 4, Sonnet 4보다 오래된 모델. SDK 문서 기준으로는 Haiku 4.5부터 지원한다.
- **비공식 호스트:** `ANTHROPIC_BASE_URL`이 비공식 호스트면 기본으로 꺼진다. `ENABLE_TOOL_SEARCH=true`로 강제로 켤 수 있다.
- **실험 기능 비활성화:** `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`가 켜져 있으면 꺼진다. 관리 설정에는 예외가 있다 (v2.1.227 이상).
- **바꿀 수 없는 경우:** Microsoft Foundry와 HIPAA 구성 세션은 꺼지고, 다시 켤 수 없다.
- Bedrock 전용 조건은 문서에서 찾지 못했다.

## Agent SDK

- `query()`의 `options.env`에 `ENABLE_TOOL_SEARCH`를 넣는다 (예: `"auto:5"`). TypeScript에서는 `env`가 하위 프로세스 환경을 통째로 대체하므로 `...process.env`를 함께 넣어야 한다.
- `mcpServers` 설정에서 `alwaysLoad`를 쓸 수 있다.
- SDK 커스텀 도구(in-process)를 개별로 처음부터 로딩하는 옵션은 문서에서 찾지 못했다.

## 도구 최소화 구성에 적용하면

[removing-tools.md](removing-tools.md)의 구성안과 합치면 다음과 같다.

1. 남긴 내장 도구 중 지연된 것은 `tool.describe`에서 `isDeferred: false`로 처음부터 로딩한다.
2. 자주 쓰는 MCP 서버는 `alwaysLoad: true`를 준다.
3. 나머지 도구는 deny 규칙으로 아예 빼서 ToolSearch 목록도 짧게 만든다.

## 출처

- [MCP: Configure tool search](https://code.claude.com/docs/en/mcp#configure-tool-search)
- [MCP: Exempt a server from deferral](https://code.claude.com/docs/en/mcp#exempt-a-server-from-deferral)
- [MCP: Per-tool alwaysLoad](https://code.claude.com/docs/en/mcp#per-tool-alwaysload)
- [Agent SDK tool search](https://code.claude.com/docs/en/agent-sdk/tool-search)
- [Agent SDK MCP](https://code.claude.com/docs/en/agent-sdk/mcp#connection-timing)
- [Tools reference](https://code.claude.com/docs/en/tools-reference)
- [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference#events)
- mod 관련 내용: plugin-authoring 스킬의 타입 정의 `claude-code.d.ts` (2.1.301)
