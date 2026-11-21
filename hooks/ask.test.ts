import { expect, test } from 'claude-code/testing'
import { ASK_TOOL, parseChoices, replyWindowMs } from './ask'

test('답을 기다릴 시간은 기본 5분이고 120분을 넘지 않는다', () => {
  expect(replyWindowMs(undefined)).toBe(300_000)
  expect(replyWindowMs(-3)).toBe(300_000)
  expect(replyWindowMs(2)).toBe(120_000)
  expect(replyWindowMs(0.5)).toBe(30_000)
  expect(replyWindowMs(500)).toBe(7_200_000)
})

test('선택지는 비어 있지 않은 문자열만 남긴다', () => {
  expect(parseChoices(['기술 평가', '', ' 가격 논의 ', 3])).toEqual(['기술 평가', '가격 논의'])
  expect(parseChoices('기술 평가')).toEqual([])
})

type On = Parameters<Parameters<typeof test>[1]>[1]

const contextOf = (r: unknown) => ((r as { context?: string[] }).context ?? []).join('\n')
const resultOf = (r: unknown) => String((r as { result?: unknown }).result ?? '')

function engine(on: On, clock: { nowMs: number }) {
  const statuses: (string | undefined)[] = []
  on('clock.now', () => ({ value: clock.nowMs }) as never)
  on('ui.status', ($, e) => {
    statuses.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-channel' } }) as never)
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context, origin: e.origin }))
  return statuses
}

const ask = ($: Parameters<Parameters<typeof test>[1]>[0], input: object) => $.tool.call({ tool: ASK_TOOL, ...input } as never)

test('질문하면 바로 돌아오고, 열린 동안 사용자가 보낸 메시지에 답이라는 표시를 붙인 뒤 질문을 닫는다', { options: { timeAwareness: false } }, async ($, on) => {
  const clock = { nowMs: 1_000_000 }
  const statuses = engine(on, clock)

  const asked = await ask($, { question: '미팅 목적이 기술 평가인가요, 가격 논의인가요?', choices: ['기술 평가', '가격 논의'], reply_within_minutes: 10 })
  clock.nowMs += 90_000
  const reply = contextOf(await $.prompt.submit({ text: '가격 논의요', origin: { kind: 'composer' } } as never))
  const next = contextOf(await $.prompt.submit({ text: '다음 작업', origin: { kind: 'composer' } } as never))

  expect(resultOf(asked)).toStartWith('Asked the user (q')
  expect(resultOf(asked)).toContain('Keep working on what does not depend on the answer')
  expect(statuses[0]).toContain('미팅 목적이 기술 평가인가요, 가격 논의인가요? (기술 평가 / 가격 논의)')
  expect(reply).toContain('[j-cc] The user sent this message 1m30s after your question q')
  expect(reply).not.toContain('after it expired')
  expect(statuses.at(-1)).toBe(undefined)
  expect(next).not.toContain('after your question')
})

test('답이 없이 마감이 지나면 다음 도구 결과 하나에만 만료를 알리고, 늦은 답에도 표시를 붙인다', { options: { timeAwareness: false } }, async ($, on) => {
  const clock = { nowMs: 2_000_000 }
  engine(on, clock)

  await ask($, { question: '어느 지역 고객인가요?', reply_within_minutes: 1 })
  clock.nowMs += 30_000
  const before = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.ts' } as never))
  clock.nowMs += 31_000
  const expiredResults = await Promise.all([
    $.tool.call({ tool: 'Glob', pattern: '*.md' } as never),
    $.tool.call({ tool: 'Glob', pattern: '*.json' } as never),
  ])
  const later = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.txt' } as never))
  const lateReply = contextOf(await $.prompt.submit({ text: '아시아요', origin: { kind: 'composer' } } as never))

  expect(before).not.toContain('expired')
  expect(expiredResults.filter(r => contextOf(r).includes('expired at')).length).toBe(1)
  expect(expiredResults.map(contextOf).join('\n')).toContain('Go on with your best assumption')
  expect(later).not.toContain('expired at')
  expect(lateReply).toContain('after it expired')
})

test('질문이 열려 있으면 새 질문을 띄우지 않고, 만료된 뒤에는 새 질문을 받는다', { options: { timeAwareness: false } }, async ($, on) => {
  const clock = { nowMs: 3_000_000 }
  const statuses = engine(on, clock)

  await ask($, { question: '첫 질문인가요?', reply_within_minutes: 1 })
  const busy = await ask($, { question: '두 번째 질문인가요?' })
  clock.nowMs += 61_000
  const fresh = await ask($, { question: '세 번째 질문인가요?' })

  expect(resultOf(busy)).toContain('is still open until')
  expect(statuses.filter(s => s?.includes('두 번째')).length).toBe(0)
  expect(resultOf(fresh)).toStartWith('Asked the user (q')
  expect(statuses.at(-1)).toContain('세 번째 질문인가요?')
})

test('작업 완료 알림 같은 사용자가 보내지 않은 프롬프트는 답으로 보지 않는다', { options: { timeAwareness: false } }, async ($, on) => {
  const clock = { nowMs: 4_000_000 }
  engine(on, clock)

  await ask($, { question: '배포해도 되나요?' })
  const notice = contextOf(await $.prompt.submit({ text: '<task-notification><task-id>t1</task-id></task-notification>', origin: { kind: 'task-notification' } } as never))
  const reply = contextOf(await $.prompt.submit({ text: '네', origin: { kind: 'composer' } } as never))

  expect(notice).not.toContain('after your question')
  expect(reply).toContain('after your question')
})

test('서브에이전트와 빈 질문은 거절한다', { options: { timeAwareness: false } }, async ($, on) => {
  engine(on, { nowMs: 5_000_000 })

  const fromSubagent = await ask($, { question: '괜찮나요?', agentId: 'sub-1' })
  const empty = await ask($, { question: '  ' })

  expect((fromSubagent as { deny?: string }).deny).toContain('ask_async is for the main session')
  expect((empty as { deny?: string }).deny).toBe('question is required.')
})

const BAND = {
  plugin: 'j-cc',
  component: 'AbovePrompt',
  requestId: 'band',
  surface: 'terminal',
  props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 20, columns: 60, scroll: { offset: 0, bodyRows: 20 } },
} as const

test('열린 질문은 입력창 위 띠에 전문을 보이고, 선택지를 누르면 보내지 않고 입력창에만 채운다', { options: { timeAwareness: false } }, async ($, on) => {
  const clock = { nowMs: 6_000_000 }
  engine(on, clock)
  const fills: unknown[] = []
  on('prompt.fill', ($, e) => {
    fills.push(e)
    return { isFilled: true } as never
  })
  const question = '데모 스테이지를 버린다면 어디까지 지울까요? (가) 테스트만 (나) 레벨 파일과 스냅숏까지 (다) 위키 문서와 번역까지'

  await ask($, { question, choices: ['(가) 테스트만', '(다) 위키까지'] })
  const open = await $.ui.mount(BAND as never)
  const shown = await open.find({ type: 'Text', text: /데모 스테이지/ })
  await $.ui.press({ plugin: 'j-cc', key: 'ask-choice-1' })
  await open.unmount()
  await $.prompt.submit({ text: '(다) 위키까지', origin: { kind: 'composer' } } as never)
  const answered = await $.ui.mount(BAND as never)
  const leftOver = await answered.find({ type: 'Text', text: /데모 스테이지/ })
  await answered.unmount()

  expect(shown?.text).toBe(question)
  expect(fills).toEqual([expect.objectContaining({ text: '(다) 위키까지' })])
  expect(leftOver).toBe(undefined)
})

function registrations(on: On): string[] {
  const registered: string[] = []
  on('tool.register', ($, e) => {
    registered.push((e as { name: string }).name)
    return { value: undefined } as never
  })
  on('session.start', ($, e) => ({ cwd: (e as { cwd: string }).cwd }) as never)
  return registered
}

test('세션이 시작되면 exec 과 함께 ask_async 를 등록한다', async ($, on) => {
  const registered = registrations(on)

  await $.session.start({ cwd: 'C:/Users/me/proj' } as never)

  expect(registered).toContain('exec')
  expect(registered).toContain('ask_async')
})

test('askAsync 를 끄면 ask_async 를 등록하지 않는다', { options: { askAsync: false } }, async ($, on) => {
  const registered = registrations(on)

  await $.session.start({ cwd: 'C:/Users/me/proj' } as never)

  expect(registered).toContain('exec')
  expect(registered).not.toContain('ask_async')
})
