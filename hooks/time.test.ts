import { expect, test } from 'claude-code/testing'
import { formatDuration, formatLocalTime, isTimeNoteDue, toolTimeNote } from './time'

const NOV_21_0500_UTC = Date.UTC(2026, 10, 21, 5, 0, 0)

test('현지 시각을 오프셋과 요일을 붙여 적는다', () => {
  expect(formatLocalTime(NOV_21_0500_UTC, 540)).toBe('2026-11-21T14:00:00+09:00 (Saturday)')
  expect(formatLocalTime(NOV_21_0500_UTC, 0)).toBe('2026-11-21T05:00:00+00:00 (Saturday)')
  expect(formatLocalTime(NOV_21_0500_UTC, -330)).toBe('2026-11-20T23:30:00-05:30 (Friday)')
})

test('경과 시간은 가장 큰 두 단위로 적는다', () => {
  expect(formatDuration(0)).toBe('0s')
  expect(formatDuration(45_400)).toBe('45s')
  expect(formatDuration(192_000)).toBe('3m12s')
  expect(formatDuration(3_900_000)).toBe('1h05m')
})

test('사용자 메시지를 받은 적이 없으면 경과 시간을 적지 않는다', () => {
  expect(toolTimeNote(NOV_21_0500_UTC, null, 540)).toBe('[j-cc] Current time: 2026-11-21T14:00:00+09:00 (Saturday).')
  expect(toolTimeNote(NOV_21_0500_UTC, NOV_21_0500_UTC - 192_000, 540)).toBe(
    "[j-cc] Current time: 2026-11-21T14:00:00+09:00 (Saturday); 3m12s since the user's last message.",
  )
})

test('마지막 안내 뒤 1분이 지났거나 시계가 거꾸로 가면 다시 알린다', () => {
  expect(isTimeNoteDue(1_000, null)).toBe(true)
  expect(isTimeNoteDue(60_999, 1_000)).toBe(false)
  expect(isTimeNoteDue(61_000, 1_000)).toBe(true)
  expect(isTimeNoteDue(500, 1_000)).toBe(true)
})

const contextOf = (r: unknown) => ((r as { context?: string[] }).context ?? []).join('\n')
const TIME_NOTE = /\[j-cc\] Current time: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d \(\w+day\)/

type On = Parameters<Parameters<typeof test>[1]>[1]

function engine(on: On, clock: { nowMs: number }) {
  on('clock.now', () => ({ value: clock.nowMs }) as never)
  on('tool.call', () => ({ result: 'ok' }))
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context, origin: e.origin }))
}

test('사용자 메시지에는 현재 시각을 붙이고, 도구 결과에는 1분에 한 번만 경과 시간과 함께 붙인다', async ($, on) => {
  const clock = { nowMs: 10_000_000 }
  engine(on, clock)

  const prompt = contextOf(await $.prompt.submit({ text: '15분 뒤 미팅 준비', origin: { kind: 'composer' } } as never))
  clock.nowMs += 30_000
  const early = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.ts' } as never))
  clock.nowMs += 45_000
  const due = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.md' } as never))
  const right = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.json' } as never))

  expect(prompt).toMatch(TIME_NOTE)
  expect(early).not.toContain('Current time')
  expect(due).toMatch(TIME_NOTE)
  expect(due).toContain("1m15s since the user's last message")
  expect(right).not.toContain('Current time')
})

test('같은 스텝의 병렬 도구 호출 중 하나에만 시각을 붙인다', async ($, on) => {
  engine(on, { nowMs: 20_000_000 })

  const results = await Promise.all([
    $.tool.call({ tool: 'Glob', pattern: '*.ts' } as never),
    $.tool.call({ tool: 'Glob', pattern: '*.md' } as never),
    $.tool.call({ tool: 'Glob', pattern: '*.json' } as never),
  ])

  expect(results.filter(r => contextOf(r).includes('Current time')).length).toBe(1)
})

test('서브에이전트의 도구 결과에는 시각을 붙이지 않는다', async ($, on) => {
  engine(on, { nowMs: 30_000_000 })

  const r = await $.tool.call({ tool: 'Glob', pattern: '*.ts', agentId: 'sub-1' } as never)

  expect(contextOf(r)).not.toContain('Current time')
})

const COMPOSE_INPUT = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal' as const],
  tools: ['Read'],
  outputStyle: null,
  traits: [],
}

test('시스템 프롬프트에 시각 사용법 섹션을 넣는다', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))

  const composed = await $.prompt.compose(COMPOSE_INPUT)

  expect(composed.sections.map(s => s.id)).toContain('j-cc:time')
})

test('작업 완료 알림에는 시각을 응답 언어 문장보다 먼저 붙인다', async ($, on) => {
  engine(on, { nowMs: 35_000_000 })
  on('settings.read', () => ({ value: { language: '한국어' } }))

  const r = await $.prompt.submit({ text: '<task-notification><task-id>t9</task-id></task-notification>', origin: { kind: 'task-notification' } } as never)
  const notes = (r as { context?: string[] }).context ?? []

  expect(notes.length).toBe(2)
  expect(notes[0]).toMatch(TIME_NOTE)
  expect(notes[1]).toStartWith('Keep replying to the user in 한국어')
})

test('timeAwareness 를 끄면 시각을 붙이지 않고 시스템 프롬프트 섹션도 넣지 않는다', { options: { timeAwareness: false } }, async ($, on) => {
  engine(on, { nowMs: 40_000_000 })
  on('prompt.compose', () => ({ sections: [] }))

  const prompt = contextOf(await $.prompt.submit({ text: '다음 작업', origin: { kind: 'composer' } } as never))
  const tool = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.ts' } as never))
  const composed = await $.prompt.compose(COMPOSE_INPUT)

  expect(prompt).not.toContain('Current time')
  expect(tool).not.toContain('Current time')
  expect(composed.sections.map(s => s.id)).toContain('j-cc:routing')
  expect(composed.sections.map(s => s.id)).not.toContain('j-cc:time')
})

test('시계를 읽지 못해도 도구를 한 번만 실행하고 시각 없이 돌려준다', async ($, on) => {
  let runs = 0
  on('clock.now', () => {
    throw new Error('clock unavailable')
  })
  on('tool.call', () => {
    runs += 1
    return { result: 'ok' }
  })

  const r = await $.tool.call({ tool: 'Glob', pattern: '*.ts' } as never)

  expect(runs).toBe(1)
  expect(contextOf(r)).not.toContain('Current time')
})
