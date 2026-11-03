import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import { mayBeEnglish } from './language'

const ENGLISH_NOTE = "Domain reload during recompile drops the socket; I'll check compile status once it settles."
const KOREAN_NOTE = '컴파일이 끝났습니다. `hooks/register.ts`를 Read로 다시 확인합니다.'
const WARNING = '[j-cc] Your last note to the user was not in 한국어. Write in 한국어 from now on, including the short notes between tool calls.'

test('영문자가 대부분인 산문만 영어일 수 있다고 본다', () => {
  expect(mayBeEnglish(ENGLISH_NOTE)).toBe(true)
  expect(mayBeEnglish('Compiles cleanly (TMP font errors are pre-existing package noise).')).toBe(true)
  expect(mayBeEnglish(KOREAN_NOTE)).toBe(false)
  expect(mayBeEnglish('결과는 아래와 같습니다.\n```ts\nconst answer = await next(e)\nreturn answer\n```')).toBe(false)
  expect(mayBeEnglish('`C:\\Users\\me\\j-cc\\hooks\\register.ts` https://example.com/some/long/path')).toBe(false)
  expect(mayBeEnglish('Checking the tests now.')).toBe(true)
  expect(mayBeEnglish('Read로 다시 확인합니다.')).toBe(false)
  expect(mayBeEnglish('PowerShell로 확인합니다.')).toBe(false)
  expect(mayBeEnglish('Done.')).toBe(false)
  expect(mayBeEnglish('')).toBe(false)
})

async function step($: EngineInterface, agentId?: string): Promise<void> {
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'test', messageCount: 1, ...(agentId ? { agentId } : {}) })) {
  }
}

const contextOf = (r: unknown) => ((r as { context?: string[] }).context ?? []).join('\n')

type On = Parameters<Parameters<typeof test>[1]>[1]

function engine(on: On, answer: string, verdict: () => string | undefined, settings: object = { language: '한국어' }) {
  const asked: string[] = []
  on('settings.read', () => ({ value: settings }))
  on('turn.step', async function* ($, e) {
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'tool_use' as const, usage: null }
  })
  on('model.classify', ($, e) => {
    asked.push(e.text)
    return { value: verdict() }
  })
  const tool = { runs: 0 }
  on('tool.call', () => {
    tool.runs += 1
    return { result: 'ok' }
  })
  return Object.assign(asked, { tool })
}

test('설정 언어가 아닌 응답 뒤 첫 도구 결과에만 경고를 붙인다', async ($, on) => {
  const asked = engine(on, ENGLISH_NOTE, () => 'written in another language')

  await step($)
  const first = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.ts' } as never))
  const second = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.md' } as never))

  expect(asked).toEqual([ENGLISH_NOTE])
  expect(first).toEndWith(WARNING)
  expect(second).not.toContain('[j-cc]')
})

async function endTurn($: EngineInterface, answer: string, agentId?: string): Promise<void> {
  await $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...(agentId ? { agentId } : {}) } as never)
}

function promptEngine(on: On) {
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context, origin: e.origin }))
}

const submit = ($: EngineInterface) => $.prompt.submit({ text: '다음 작업' } as never)

test('턴을 끝낸 답변이 설정 언어가 아니면 다음 프롬프트에 한 번만 경고를 붙인다', async ($, on) => {
  const asked = engine(on, KOREAN_NOTE, () => 'written in another language')
  promptEngine(on)

  await endTurn($, ENGLISH_NOTE)
  const first = contextOf(await submit($))
  const second = contextOf(await submit($))

  expect(asked).toEqual([ENGLISH_NOTE])
  expect(first).toContain(WARNING)
  expect(second).not.toContain('[j-cc]')
})

test('턴을 끝낸 답변이 한국어면 묻지 않고 다음 프롬프트에 경고하지 않는다', async ($, on) => {
  const asked = engine(on, KOREAN_NOTE, () => 'written in another language')
  promptEngine(on)

  await endTurn($, KOREAN_NOTE)
  const r = contextOf(await submit($))

  expect(asked).toEqual([])
  expect(r).not.toContain('[j-cc]')
})

test('서브에이전트의 턴이 끝날 때는 답변을 검사하지 않는다', async ($, on) => {
  const asked = engine(on, KOREAN_NOTE, () => 'written in another language')
  promptEngine(on)

  await endTurn($, ENGLISH_NOTE, 'sub-1')
  const r = contextOf(await submit($))

  expect(asked).toEqual([])
  expect(r).not.toContain('[j-cc]')
})

test('턴 끝에서 판정한 답변은 다음 도구 호출에서 다시 묻지 않는다', async ($, on) => {
  const asked = engine(on, ENGLISH_NOTE, () => 'written in another language')
  promptEngine(on)

  await step($)
  await endTurn($, ENGLISH_NOTE)
  await $.tool.call({ tool: 'Glob', pattern: '*.ts' } as never)

  expect(asked).toEqual([ENGLISH_NOTE])
})

test('짧은 영어 메모도 판정해 다음 도구 결과에 경고를 붙인다', async ($, on) => {
  const asked = engine(on, 'Checking the tests now.', () => 'written in another language')

  await step($)
  const r = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.ts' } as never))

  expect(asked).toEqual(['Checking the tests now.'])
  expect(r).toEndWith(WARNING)
})

test('모델이 설정 언어로 쓴 글이라고 판정하면 경고하지 않는다', async ($, on) => {
  engine(on, ENGLISH_NOTE, () => 'written in 한국어')

  await step($)
  const r = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.ts' } as never))

  expect(r).not.toContain('[j-cc]')
})

test('한국어 응답은 모델에게 묻지 않는다', async ($, on) => {
  const asked = engine(on, KOREAN_NOTE, () => 'written in another language')

  await step($)
  const r = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.ts' } as never))

  expect(asked).toEqual([])
  expect(r).not.toContain('[j-cc]')
})

test('서브에이전트의 응답은 검사하지 않는다', async ($, on) => {
  const asked = engine(on, ENGLISH_NOTE, () => 'written in another language')

  await step($, 'sub-1')
  const r = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.ts' } as never))

  expect(asked).toEqual([])
  expect(r).not.toContain('[j-cc]')
})

test('응답 언어 설정이 없으면 모델에게 묻지 않는다', async ($, on) => {
  const asked = engine(on, ENGLISH_NOTE, () => 'written in another language', {})

  await step($)
  const r = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.ts' } as never))

  expect(asked).toEqual([])
  expect(r).not.toContain('[j-cc]')
})

test('판정이 실패해도 경고하지 않고 도구를 한 번만 실행한다', async ($, on) => {
  const { tool } = engine(on, ENGLISH_NOTE, () => {
    throw new Error('model unavailable')
  })

  await step($)
  const r = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.ts' } as never))

  expect(r).not.toContain('[j-cc]')
  expect(tool.runs).toBe(1)
})

test('modelJudge 를 끄면 응답 언어도 검사하지 않는다', { options: { modelJudge: false } }, async ($, on) => {
  const asked = engine(on, ENGLISH_NOTE, () => 'written in another language')

  await step($)
  const r = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.ts' } as never))

  expect(asked).toEqual([])
  expect(r).not.toContain('[j-cc]')
})
