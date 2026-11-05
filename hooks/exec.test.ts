import { expect, test } from 'claude-code/testing'
import {
  EXEC_TOOL,
  MAX_EXEC_YIELD_MS,
  MAX_POLL_YIELD_MS,
  MIN_POLL_YIELD_MS,
  POLL_TOOL,
  budgetedYieldMs,
  clip,
  cutMainLoopWaits,
  holdWait,
  isIdlePoll,
  isReportedTaskNotice,
  launchedTask,
  markReported,
  noteActivity,
  noticeTaskId,
  parseTaskOutput,
  passedPermission,
  quoteCwd,
  statusLine,
  takeReport,
  yieldMs,
  type Run,
} from './exec'
import { isUserSteering } from './register'

test('출력이 한도를 넘으면 앞부분 일부와 뒷부분을 남긴다', () => {
  expect(clip('0123456789', 20)).toBe('0123456789')
  expect(clip('0123456789', 4)).toBe('0\n…[6 chars omitted]…\n789')
})

test('대기 시간은 기본 10초이고 exec 은 30초, poll 은 5분을 넘지 않는다', () => {
  expect(yieldMs(undefined, MAX_EXEC_YIELD_MS)).toBe(10_000)
  expect(yieldMs(-1, MAX_EXEC_YIELD_MS)).toBe(10_000)
  expect(yieldMs(60_000, MAX_EXEC_YIELD_MS)).toBe(30_000)
  expect(yieldMs(600_000, MAX_POLL_YIELD_MS)).toBe(300_000)
})

test('poll 은 짧은 대기를 요청해도 5초는 기다린다', () => {
  expect(yieldMs(500, MAX_POLL_YIELD_MS, MIN_POLL_YIELD_MS)).toBe(5_000)
  expect(yieldMs(0, MAX_POLL_YIELD_MS, MIN_POLL_YIELD_MS)).toBe(5_000)
  expect(yieldMs(60_000, MAX_POLL_YIELD_MS, MIN_POLL_YIELD_MS)).toBe(60_000)
})

test('tick 프로세스 없이 기다릴 때는 8초와 남은 훅 예산을 넘지 않는다', () => {
  expect(budgetedYieldMs(60_000, Infinity)).toBe(8_000)
  expect(budgetedYieldMs(5_000, 4_000)).toBe(2_500)
  expect(budgetedYieldMs(5_000, 1_000)).toBe(0)
})

test('작업 출력 파일 끝의 종료 표식을 떼어 종료 코드나 멈춘 이유로 읽는다', () => {
  expect(parseTaskOutput('0\r\n1\r\n')).toEqual({ output: '0\r\n1\r\n' })
  expect(parseTaskOutput('built\r\n\n[exited with code 2]\n')).toEqual({ output: 'built\r\n', exit: { code: 2, signal: null } })
  expect(parseTaskOutput('0\r\n14\r\n\n[killed]\n')).toEqual({ output: '0\r\n14\r\n', exit: { code: null, signal: 'killed' } })
})

test('상태 줄은 종료 코드를, 아직 돌면 백그라운드로 넘어갔고 알림이 온다는 것을 알려 준다', () => {
  expect(statusLine({ id: 3, startedAtMs: 0, exit: { code: 1, signal: null } }, 2_500)).toBe('Process exited with code 1 (wall 2.5s)')
  expect(statusLine({ id: 3, startedAtMs: 0 }, 1_000)).toContain('Process running in the background with session_id 3 (wall 1.0s). You are notified when it exits')
})

test('Bash 백그라운드 실행 결과에서 작업 ID와 출력 파일 경로를 꺼낸다', () => {
  const launched = {
    result: { stdout: '', backgroundTaskId: 'b7ywg0ifx' },
    text: 'Command running in background with ID: b7ywg0ifx. Output is being written to: C:\\Temp\\tasks\\b7ywg0ifx.output. You will be notified when it completes.',
  }

  expect(launchedTask(launched)).toEqual({ taskId: 'b7ywg0ifx', outputPath: 'C:\\Temp\\tasks\\b7ywg0ifx.output' })
  expect(launchedTask({ deny: 'blocked' })).toBe(null)
})

test('cwd는 셸에 맞게 인용해 명령 앞에 붙인다', () => {
  expect(quoteCwd('bash', "C:/it's here")).toBe("cd -- 'C:/it'\\''s here' && ")
  expect(quoteCwd('powershell', "C:\\it's")).toBe("Set-Location -LiteralPath 'C:\\it''s'; ")
})

test('셸 판정이 ask이면 exec에 대한 엔진 판정을 넘기고, allow와 deny는 셸 판정을 따른다', async ($, on) => {
  const SHELL_VERDICTS: Record<string, 'allow' | 'ask' | 'deny'> = { 'git status': 'allow', 'mkdir /outside': 'ask', 'rm -rf /': 'deny' }
  on('tool.check', ($, e) => {
    const input = e.input as { command?: string }
    if (e.tool === EXEC_TOOL) return { decision: 'ask', reason: 'engine verdict for exec' }
    return { decision: SHELL_VERDICTS[input.command ?? ''], reason: `shell verdict for ${input.command}` }
  })

  const allowed = await $.tool.check({ tool: EXEC_TOOL, input: { cmd: 'git status' } })
  const asked = await $.tool.check({ tool: EXEC_TOOL, input: { cmd: 'mkdir /outside' } })
  const denied = await $.tool.check({ tool: EXEC_TOOL, input: { cmd: 'rm -rf /' } })

  expect(allowed.decision).toBe('allow')
  expect(asked).toEqual({ decision: 'ask', reason: 'engine verdict for exec' })
  expect(denied.decision).toBe('deny')
})

test('auto 분류기가 Bash 판정을 내지 않아 거부하면 exec에 대한 엔진 판정을 넘긴다', async ($, on) => {
  const NO_VERDICT = 'The server-side auto mode classifier gave no verdict for Bash: the request that produced this action did not ask for one.'
  on('tool.check', ($, e) => {
    if (e.tool === EXEC_TOOL) return { decision: 'ask', reason: 'engine verdict for exec' }
    return { decision: 'deny', reason: NO_VERDICT }
  })

  const verdict = await $.tool.check({ tool: EXEC_TOOL, input: { cmd: 'msedge --headless' } })

  expect(verdict).toEqual({ decision: 'ask', reason: 'engine verdict for exec' })
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
  taskId: 'task-1',
  outputPath: 'C:/Temp/tasks/task-1.output',
  reportedChars: 0,
  ...fields,
})

test('보고는 이미 돌려준 출력을 건너뛰고 새 출력만 넘긴다', () => {
  const run = fakeRun({})

  const first = takeReport(run, 'compiling\n', 3_000, undefined)
  const second = takeReport(run, 'compiling\nlinking\n', 4_000, undefined)

  expect(first).toEndWith('Output:\ncompiling\n')
  expect(second).toEndWith('Output:\nlinking\n')
})

test('끝난 명령의 보고에는 종료 코드와 한도에 맞춘 출력이 들어간다', () => {
  const run = fakeRun({})

  expect(takeReport(run, 'built\n\n[exited with code 0]\n', 1_000, 3)).toBe('Process exited with code 0 (wall 1.0s)\nOutput:\n\n…[3 chars omitted]…\nlt\n')
})

test('완료 알림에서 작업 ID를 읽는다', () => {
  expect(noticeTaskId('<task-notification>\n<task-id>bc9tb1vsb</task-id>\n<status>completed</status>')).toBe('bc9tb1vsb')
  expect(noticeTaskId('The user sent a new message.')).toBe(undefined)
})

test('종료까지 보고한 작업의 알림만 이미 보고한 알림으로 본다', () => {
  const stillRunning = fakeRun({ taskId: 'running-task' })
  takeReport(fakeRun({ taskId: 'reported-task' }), 'ok\n\n[exited with code 0]\n', 1_000, undefined)
  takeReport(stillRunning, 'compiling\n', 1_000, undefined)

  expect(isReportedTaskNotice('<task-notification><task-id>reported-task</task-id></task-notification>')).toBe(true)
  expect(isReportedTaskNotice('<task-notification><task-id>running-task</task-id></task-notification>')).toBe(false)
  expect(isReportedTaskNotice('The user sent a new message.')).toBe(false)
})

test('권한을 통과해 처리기를 찾지 못한 결과일 때만 명령을 실행한다', () => {
  const unanswered = 'j-cc registered the tool exec but no tool.call hook answered this call: add on("tool.call", ...) to the plugin.'
  const refused = "Permission to use mcp__j-cc__exec denied by plugin j-cc: mkdir in '/tmp/x' needs approval."

  expect(passedPermission({ isError: true, text: unanswered })).toBe(true)
  expect(passedPermission({ isError: true, text: refused })).toBe(false)
  expect(passedPermission({ deny: 'blocked' })).toBe(false)
  expect(passedPermission({ text: 'ok' })).toBe(false)
})

test('메인 루프가 보고 뒤 다른 일 없이 부른 poll만 쉬는 poll로 본다', () => {
  const run = fakeRun({})
  markReported(run)

  expect(isIdlePoll(run, undefined)).toBe(true)
  expect(isIdlePoll(run, 'agent-1')).toBe(false)
  noteActivity()
  expect(isIdlePoll(run, undefined)).toBe(false)
})

test('사용자 메시지가 오면 메인 루프의 대기만 끊고 서브에이전트의 대기는 둔다', () => {
  const engine = new AbortController()
  const mainWait = holdWait(undefined, engine.signal)
  const subagentWait = holdWait('agent-1', engine.signal)

  expect(cutMainLoopWaits()).toBe(1)

  expect(mainWait.cutByUser()).toBe(true)
  expect(subagentWait.signal.aborted).toBe(false)
  mainWait.release()
  subagentWait.release()
})

test('엔진이 중단한 대기는 사용자 메시지로 끊긴 것으로 보지 않는다', () => {
  const engine = new AbortController()
  const wait = holdWait(undefined, engine.signal)

  engine.abort()

  expect(wait.signal.aborted).toBe(true)
  expect(wait.cutByUser()).toBe(false)
  wait.release()
})

test('끝난 대기는 다음 사용자 메시지에 끊기지 않는다', () => {
  const wait = holdWait(undefined, new AbortController().signal)
  wait.release()

  expect(cutMainLoopWaits()).toBe(0)
  expect(wait.signal.aborted).toBe(false)
})

test('턴 도중 사용자가 직접 보낸 메시지만 대기를 끊는다', () => {
  expect(isUserSteering({ turnId: 't1', wait: false, origin: { kind: 'composer' } })).toBe(true)
  expect(isUserSteering({ turnId: 't1', wait: false, origin: { kind: 'bridge' } })).toBe(true)
  expect(isUserSteering({ turnId: 't1', wait: true, origin: { kind: 'composer' } })).toBe(false)
  expect(isUserSteering({ turnId: 't1', wait: false, origin: { kind: 'task-notification' } })).toBe(false)
  expect(isUserSteering({ turnId: 't1', wait: false, origin: { kind: 'peer' } })).toBe(false)
  expect(isUserSteering({ wait: false, origin: { kind: 'composer' } })).toBe(false)
})

test('poll은 session_id 없이 부르면 실행 중인 명령이 없다고 알린다', async $ => {
  const r = await $.tool.call({ tool: POLL_TOOL } as never)

  expect(JSON.stringify(r)).toContain('No running commands.')
})
