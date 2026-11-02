import { expect, test } from 'claude-code/testing'
import { EXEC_TOOL, MAX_YIELD_MS, POLL_TOOL, appendOutput, clip, statusLine, takeReport, yieldMs, type Run } from './exec'

test('출력이 한도를 넘으면 앞부분 일부와 뒷부분을 남긴다', () => {
  expect(clip('0123456789', 20)).toBe('0123456789')
  expect(clip('0123456789', 4)).toBe('0\n…[6 chars omitted]…\n789')
})

test('버퍼가 가득 차면 오래된 출력을 버리고 버린 글자 수를 센다', () => {
  const run = { unread: 'abcdef', droppedChars: 0 }

  appendOutput(run, 'ghij', 8)

  expect(run).toEqual({ unread: 'cdefghij', droppedChars: 2 })
})

test('대기 시간은 기본 5초이고 8초와 남은 훅 예산을 넘지 않는다', () => {
  expect(yieldMs(undefined, Infinity)).toBe(5_000)
  expect(yieldMs(60_000, Infinity)).toBe(MAX_YIELD_MS)
  expect(yieldMs(5_000, 4_000)).toBe(2_500)
  expect(yieldMs(-1, 1_000)).toBe(0)
})

test('상태 줄은 종료 코드나 이어서 읽을 session_id를 알려 준다', () => {
  expect(statusLine({ id: 3, startedAtMs: 0, exit: { code: 1, signal: null } }, 2_500)).toBe('Process exited with code 1 (wall 2.5s)')
  expect(statusLine({ id: 3, startedAtMs: 0 }, 1_000)).toContain('Process running with session_id 3 (wall 1.0s)')
})

test('exec은 j-cc 셸 규칙을 그대로 적용해 파일 보기 명령을 막는다', async ($, on) => {
  on('env.get', () => ({ value: undefined }))
  const r = await $.tool.call({ tool: EXEC_TOOL, cmd: 'cat src/app.ts' } as never)

  expect(JSON.stringify(r)).toContain('[j-cc] Blocked (view)')
})

const fakeRun = (fields: Partial<Run>): Run => ({
  id: 1,
  command: 'npm run build',
  startedAtMs: 0,
  unread: '',
  droppedChars: 0,
  finished: Promise.resolve(),
  stream: null as never,
  ...fields,
})

test('보고는 읽지 않은 출력을 넘기고 버퍼를 비운다', () => {
  const run = fakeRun({ unread: 'compiling\n', droppedChars: 5 })

  const report = takeReport(run, 3_000, undefined)

  expect(report).toBe('Process running with session_id 1 (wall 3.0s). Call poll with this session_id to read more output, or with terminate: true to stop it.\nOutput:\n[5 earlier chars dropped from the buffer]\ncompiling\n')
  expect(run.unread).toBe('')
  expect(run.droppedChars).toBe(0)
})

test('끝난 명령의 보고에는 종료 코드와 한도에 맞춘 출력이 들어간다', () => {
  const run = fakeRun({ unread: 'built\n', exit: { code: 0, signal: null } })

  expect(takeReport(run, 1_000, 3)).toBe('Process exited with code 0 (wall 1.0s)\nOutput:\n\n…[3 chars omitted]…\nlt\n')
})

test('poll은 session_id 없이 부르면 실행 중인 명령이 없다고 알린다', async $ => {
  const r = await $.tool.call({ tool: POLL_TOOL } as never)

  expect(JSON.stringify(r)).toContain('No running commands.')
})
