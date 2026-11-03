import type { EngineInterface, Register } from 'claude-code'
import { screen, type ScreenOptions } from './bypass'
import type { Shell } from './shell'

// Codex 의 exec_command/write_stdin 처럼, 명령을 시작하고 정해진 시간 안에 출력과 session_id 를 돌려준다.
// 내장 Bash/PowerShell 은 끝나거나 타임아웃이 날 때까지 아무것도 돌려주지 않아, 멈춘 명령을 모델이 몇 분씩 기다린다.
// 명령은 내장 Bash/PowerShell 도구에 백그라운드로 맡긴다. 그래야 샌드박스, 작업 목록, 완료 알림이 Bash 와 같다.

export const EXEC_TOOL = 'mcp__j-cc__exec'
export const POLL_TOOL = 'mcp__j-cc__poll'

// Codex 와 같은 값이다. exec 은 30초, 출력만 기다리는 poll 은 5분까지 기다린다.
export const DEFAULT_YIELD_MS = 10_000
export const MAX_EXEC_YIELD_MS = 30_000
export const MAX_POLL_YIELD_MS = 300_000
// tick 프로세스를 띄우지 못했을 때의 상한. tool.call 훅의 예산은 10초이고 $.clock.sleep 은 예산을 쓴다.
export const MAX_BUDGETED_YIELD_MS = 8_000
const BUDGET_RESERVE_MS = 1_500
const TICK_MS = 250
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000
const MAX_RUNNING = 16
const TERMINATE_WAIT_MS = 2_000
const MAX_REPORTED_TASKS = 200

const GIT_BASH_CANDIDATES = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe']

export type TaskExit = { code: number | null; signal: string | null }

export type Run = {
  id: number
  command: string
  startedAtMs: number
  taskId: string
  outputPath: string
  reportedChars: number
  exit?: TaskExit
  failure?: string
}

const runs = new Map<number, Run>()
// 종료까지 보고한 작업. 엔진이 뒤늦게 보내는 완료 알림은 같은 내용이라 지운다.
const reportedTasks = new Set<string>()
let nextRunId = 1

export const shellToolName = (shell: Shell) => (shell === 'powershell' ? 'PowerShell' : 'Bash')

// 실패 원인은 보통 끝에 찍히므로 꼬리를 더 남긴다.
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const headChars = Math.floor(maxChars * 0.25)
  const tailChars = maxChars - headChars
  return `${text.slice(0, headChars)}\n…[${text.length - maxChars} chars omitted]…\n${text.slice(-tailChars)}`
}

// 엔진은 백그라운드 작업이 끝나면 출력 파일 끝에 `[exited with code N]` 이나 `[killed]` 를 붙인다(Claude Code 2.1.316).
const TASK_END = /\n\[(exited with code (-?\d+)|killed|stopped|interrupted|timed out[^\]\n]*)\]\n?$/

export function parseTaskOutput(fileText: string): { output: string; exit?: TaskExit } {
  const end = TASK_END.exec(fileText)
  if (!end) return { output: fileText }
  const output = fileText.slice(0, end.index)
  const code = end[2]
  return { output, exit: code !== undefined ? { code: Number(code), signal: null } : { code: null, signal: end[1] ?? 'stopped' } }
}

export const isDone = (run: Pick<Run, 'exit' | 'failure'>) => run.exit !== undefined || run.failure !== undefined

export function statusLine(run: Pick<Run, 'id' | 'exit' | 'failure' | 'startedAtMs'>, nowMs: number): string {
  const wall = `wall ${((nowMs - run.startedAtMs) / 1000).toFixed(1)}s`
  if (run.failure !== undefined) return `Process failed: ${run.failure} (${wall})`
  if (run.exit) return `Process exited with ${run.exit.signal ? `signal ${run.exit.signal}` : `code ${run.exit.code}`} (${wall})`
  return `Process running in the background with session_id ${run.id} (${wall}). You are notified when it exits; meanwhile do other work. Call poll with this session_id only if you need more output before then, or with terminate: true to stop it.`
}

function rememberReported(taskId: string): void {
  reportedTasks.add(taskId)
  if (reportedTasks.size <= MAX_REPORTED_TASKS) return
  const oldest = reportedTasks.values().next().value
  if (oldest !== undefined) reportedTasks.delete(oldest)
}

// 이미 돌려준 출력은 건너뛰고, 끝난 실행은 보고와 함께 잊는다.
export function takeReport(run: Run, fileText: string, nowMs: number, maxOutputChars: unknown): string {
  const maxChars = typeof maxOutputChars === 'number' && maxOutputChars > 0 ? maxOutputChars : DEFAULT_MAX_OUTPUT_CHARS
  const parsed = parseTaskOutput(fileText)
  run.exit ??= parsed.exit
  const fresh = parsed.output.slice(run.reportedChars)
  run.reportedChars = parsed.output.length
  if (isDone(run)) {
    runs.delete(run.id)
    rememberReported(run.taskId)
  }
  return `${statusLine(run, nowMs)}\nOutput:\n${clip(fresh, maxChars)}`
}

export function yieldMs(requested: unknown, maxMs: number): number {
  const wanted = typeof requested === 'number' && requested >= 0 ? requested : DEFAULT_YIELD_MS
  return Math.min(wanted, maxMs)
}

export function budgetedYieldMs(wantedMs: number, remainingBudgetMs: number): number {
  const budget = Number.isFinite(remainingBudgetMs) ? remainingBudgetMs - BUDGET_RESERVE_MS : MAX_BUDGETED_YIELD_MS
  return Math.max(0, Math.min(wantedMs, MAX_BUDGETED_YIELD_MS, budget))
}

// 권한을 통과하면 엔진은 이 도구를 실행할 처리기를 찾다가 이 문구의 오류를 낸다(Claude Code 2.1.316).
// 그 밖의 결과는 거부로 보고 실행하지 않는다. 문구가 바뀌면 exec 가 실행되지 않을 뿐, 권한을 건너뛰지는 않는다.
const UNANSWERED_CALL = 'no tool.call hook answered this call'

export function passedPermission(gate: { deny?: string; isError?: boolean; text?: string }): boolean {
  return gate.deny === undefined && gate.isError === true && (gate.text ?? '').includes(UNANSWERED_CALL)
}

// auto 모드에서 훅이 Bash 판정을 따로 물으면, 서버 분류기는 모델이 낸 적 없는 Bash 행동이라 판정하지 않고 이 문구로 거부한다.
// 이 거부는 명령에 대한 판단이 아니므로 ask 처럼 다룬다. 문구가 바뀌면 거부가 그대로 남을 뿐, 권한을 건너뛰지는 않는다.
const CLASSIFIER_NO_VERDICT = 'classifier gave no verdict'

export function defersToEngine(shellVerdict: { decision?: string }): boolean {
  if (shellVerdict.decision === 'ask') return true
  return shellVerdict.decision === 'deny' && JSON.stringify(shellVerdict).includes(CLASSIFIER_NO_VERDICT)
}

// 엔진의 완료 알림 본문에 `<task-id>...</task-id>` 가 들어 있다.
export function noticeTaskId(text: string): string | undefined {
  return /<task-id>([^<\s]+)<\/task-id>/.exec(text)?.[1]
}

export const isReportedTaskNotice = (text: string) => {
  const taskId = noticeTaskId(text)
  return taskId !== undefined && reportedTasks.has(taskId)
}

export function quoteCwd(shell: Shell, cwd: string): string {
  return shell === 'powershell' ? `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ` : `cd -- '${cwd.replace(/'/g, `'\\''`)}' && `
}

export function launchedTask(launched: unknown): { taskId: string; outputPath: string } | null {
  const r = launched as { result?: { backgroundTaskId?: unknown }; text?: unknown }
  const taskId = typeof r?.result?.backgroundTaskId === 'string' ? r.result.backgroundTaskId : undefined
  const outputPath = typeof r?.text === 'string' ? /Output is being written to: (.+?\.output)/.exec(r.text)?.[1] : undefined
  return taskId && outputPath ? { taskId, outputPath } : null
}

export const EXEC_DESCRIPTION = [
  'Run a shell command (shell: "bash" or "powershell").',
  `If it finishes within yield_time_ms (default ${DEFAULT_YIELD_MS}, at most ${MAX_EXEC_YIELD_MS}) you get the exit code and output.`,
  'Otherwise it keeps running in the background like Bash run_in_background: you get the output so far and a session_id, and you are notified when it exits, so go on with other work.',
  `Call poll with that session_id only when you need its output before then (it waits up to ${MAX_POLL_YIELD_MS} ms per call), or with terminate: true to stop it.`,
  'A command with no new output that has not exited when you expected it to is usually waiting for input or stuck: terminate it and fix the command.',
  'Each call starts a fresh shell with stdin closed, so interactive prompts do not work.',
  'The same permission rules and sandbox as the Bash and PowerShell tools apply.',
].join(' ')

export const POLL_DESCRIPTION = `Wait for new output from a command exec left running, up to yield_time_ms (default ${DEFAULT_YIELD_MS}, at most ${MAX_POLL_YIELD_MS}); it returns as soon as the command exits. terminate: true stops it. Omit session_id to list running commands.`

type ExecArgs = { cmd?: unknown; shell?: unknown; cwd?: unknown; yield_time_ms?: unknown; max_output_chars?: unknown }
type PollArgs = { session_id?: unknown; yield_time_ms?: unknown; terminate?: unknown; max_output_chars?: unknown }

const shellOf = (args: ExecArgs): Shell => (args.shell === 'powershell' ? 'powershell' : 'bash')

// $ 를 받는 함수는 엔진이 import 너머로 따라갈 수 있게 최상위 function 선언으로 둔다.
async function bashPath($: EngineInterface): Promise<string | null> {
  const configured = await $.env.get('CLAUDE_CODE_GIT_BASH_PATH')
  if (configured) return configured
  if ((await $.env.get('OS')) !== 'Windows_NT') return 'bash'
  // Windows 의 PATH 에 있는 bash 는 WSL 일 수 있어, Git Bash 를 직접 찾는다.
  for (const candidate of GIT_BASH_CANDIDATES) if (await $.fs.exists(candidate)) return candidate
  return null
}

async function readTaskOutput($: EngineInterface, run: Run): Promise<string> {
  return $.fs.read(run.outputPath).catch(() => '')
}

async function tickerArgv($: EngineInterface, waitMs: number): Promise<string[]> {
  const ticks = Math.max(1, Math.ceil(waitMs / TICK_MS))
  const bash = await bashPath($).catch(() => null)
  if (bash) return [bash, '-c', `for ((i=0; i<${ticks}; i++)); do sleep ${TICK_MS / 1000}; echo; done`]
  return ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `for ($i = 0; $i -lt ${ticks}; $i++) { Start-Sleep -Milliseconds ${TICK_MS}; '' }`]
}

// 작업은 엔진이 돌리므로 그 출력 파일을 읽어 끝났는지 본다. 남의 작업을 기다리는 시간은 훅 예산을 쓰지만,
// 이번 호출이 띄운 프로세스의 출력을 읽는 동안은 예산이 줄지 않는다(Claude Code 2.1.316에서 실험).
// 그래서 TICK_MS 마다 한 줄을 찍는 tick 프로세스를 띄우고, 한 줄이 올 때마다 파일을 다시 읽는다.
async function waitForTask($: EngineInterface, run: Run, waitMs: number, budgetMs: number, signal: AbortSignal): Promise<string> {
  let text = await readTaskOutput($, run)
  if (parseTaskOutput(text).exit || waitMs <= 0) return text
  const ticker = $.process.spawn({ argv: await tickerArgv($, waitMs) })
  const stop = () => void ticker.return(undefined as never).catch(() => undefined)
  signal.addEventListener('abort', stop, { once: true })
  let ticked = false
  try {
    for (;;) {
      const step = await ticker.next()
      if (step.done || signal.aborted) break
      ticked = true
      text = await readTaskOutput($, run)
      if (parseTaskOutput(text).exit) break
    }
  } catch {
    // tick 프로세스를 띄우지 못하면 아래에서 예산 안에서만 기다린다.
  } finally {
    stop()
    signal.removeEventListener('abort', stop)
  }
  if (ticked || signal.aborted) return text
  return waitWithinBudget($, run, waitMs, budgetMs, signal)
}

async function waitWithinBudget($: EngineInterface, run: Run, waitMs: number, budgetMs: number, signal: AbortSignal): Promise<string> {
  const deadline = (await $.clock.now()) + budgetedYieldMs(waitMs, budgetMs)
  let text = await readTaskOutput($, run)
  while (!parseTaskOutput(text).exit && !signal.aborted && (await $.clock.now()) < deadline) {
    await $.clock.sleep(TICK_MS, { signal }).catch(() => {})
    text = await readTaskOutput($, run)
  }
  return text
}

// session.start 훅은 모듈에 하나만 둘 수 있어, register 의 session.start 에서 부른다.
const CMD_DESCRIPTION = 'The command to run.'
const CMD_DESCRIPTION_NO_CHAINING =
  'The command to run: one command, since `&&`, `||` and `;` outside quotes are blocked. Use `cwd` instead of `cd dir &&`; put a loop in a scratchpad script and run that file.'

export async function registerExecTools($: EngineInterface, { blockChaining = true }: { blockChaining?: boolean } = {}): Promise<void> {
  const execSchema = {
    type: 'object',
    properties: {
      cmd: { type: 'string', description: blockChaining ? CMD_DESCRIPTION_NO_CHAINING : CMD_DESCRIPTION },
      shell: { type: 'string', enum: ['bash', 'powershell'], description: 'bash (Git Bash on Windows, the default) or powershell.' },
      cwd: { type: 'string', description: "Working directory; the session's when omitted." },
      yield_time_ms: { type: 'number', description: `How long to wait before returning; default ${DEFAULT_YIELD_MS}, at most ${MAX_EXEC_YIELD_MS}.` },
      max_output_chars: { type: 'number', description: `Output budget; default ${DEFAULT_MAX_OUTPUT_CHARS}. Head and tail are kept.` },
    },
    required: ['cmd'],
  }
  const pollSchema = {
    type: 'object',
    properties: {
      session_id: { type: 'number', description: 'The session_id exec returned.' },
      yield_time_ms: { type: 'number', description: `How long to wait; default ${DEFAULT_YIELD_MS}, at most ${MAX_POLL_YIELD_MS}.` },
      terminate: { type: 'boolean', description: 'Stop the command.' },
      max_output_chars: { type: 'number', description: `Output budget; default ${DEFAULT_MAX_OUTPUT_CHARS}.` },
    },
  }
  await $.tool.register({ name: 'exec', description: EXEC_DESCRIPTION, inputSchema: execSchema, isDeferred: false })
  await $.tool.register({ name: 'poll', description: POLL_DESCRIPTION, inputSchema: pollSchema, isDeferred: false })
}

type On = Parameters<Register>[0]

export function registerExec(on: On, screenOptions: ScreenOptions): void {
  // exec 은 셸 명령을 그대로 돌리므로, exec 자체를 따로 허락받지 않고 같은 명령의 Bash/PowerShell 판정을 따른다.
  // 훅이 부른 Bash 는 권한을 다시 묻지 않으므로(Claude Code 2.1.316에서 실험) 이 판정이 유일한 관문이다.
  on('tool.check', { tool: EXEC_TOOL }, async ($, e, next) => {
    const own = await next(e)
    if (own.decision === 'deny') return own
    const args = (e.input ?? {}) as ExecArgs
    const command = typeof args.cmd === 'string' ? args.cmd : ''
    const shellVerdict = await $.tool.check({ tool: shellToolName(shellOf(args)), input: { command } })
    // 훅이 돌려준 ask 는 사람만 답할 수 있어, auto 분류기의 허용도 "항상 허용" 규칙도 듣지 않고 매번 묻는다.
    // 같은 명령의 셸 판정이 ask 이면 엔진이 exec 에 내린 판정을 받은 그대로 넘겨, 묻는 일을 모드의 결정자에게 맡긴다.
    // 그러면 auto 분류기는 모델이 실제로 낸 exec 호출을 판정한다.
    return defersToEngine(shellVerdict) ? own : shellVerdict
  }).catch(() => ({ decision: 'deny' as const, reason: 'j-cc could not check the permission for this command.' }))

  // poll 은 exec 이 이미 허락받고 시작한 명령의 출력을 읽거나 멈추기만 한다.
  on('tool.check', { tool: POLL_TOOL }, async ($, e, next) => {
    const own = await next(e)
    return own.decision === 'deny' ? own : { decision: 'allow' as const }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: EXEC_TOOL }, async ($, e, next) => {
    const args = e as unknown as ExecArgs
    const command = typeof args.cmd === 'string' ? args.cmd : ''
    if (!command.trim()) return { deny: 'cmd is required.' }
    const shell = shellOf(args)
    // exec 은 기다리지 않고 돌아오므로 백그라운드 실행처럼 판정한다. 파일 보기·검색·수정과 끝없는 루프는 그대로 막는다.
    const screened = await screen($, command, shell, true, screenOptions)
    if ('deny' in screened) return { deny: screened.deny }

    const running = [...runs.values()].filter(run => !isDone(run)).length
    if (running >= MAX_RUNNING) return { deny: `${running} commands are still running; poll or terminate some first.` }
    // 권한 확인은 next(e) 안에서만 일어난다. 그 안에서 위의 tool.check 훅이 같은 명령의 Bash/PowerShell 판정을 내고, 대화상자나 auto 분류기가 묻는다.
    const gate = await next(e)
    if (!passedPermission(gate)) return gate

    const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : undefined
    const startedAtMs = await $.clock.now()
    // 훅이 부른 도구에는 이 플러그인의 훅이 다시 걸리지 않으므로, 포그라운드 셸 차단에 막히지 않는다.
    // 서브에이전트에서는 포그라운드로 불러도 엔진이 백그라운드로 돌리고 timeout 을 마감으로 쓰므로, 처음부터 백그라운드로 맡긴다.
    const launched = await $.tool.call({
      tool: shellToolName(shell),
      command: `${cwd ? quoteCwd(shell, cwd) : ''}${command}`,
      run_in_background: true,
      description: `exec: ${command.slice(0, 60)}`,
    } as never)
    const task = launchedTask(launched)
    if (!task) return launched

    const run: Run = { id: nextRunId++, command, startedAtMs, ...task, reportedChars: 0 }
    runs.set(run.id, run)
    const text = await waitForTask($, run, yieldMs(args.yield_time_ms, MAX_EXEC_YIELD_MS), next.budget.remainingMs, next.signal)
    return { result: takeReport(run, text, await $.clock.now(), args.max_output_chars) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'j-cc exec failed before the command started.' }))

  on('tool.call', { tool: POLL_TOOL }, async ($, e, next) => {
    const args = e as unknown as PollArgs
    if (typeof args.session_id !== 'number') {
      const listing = [...runs.values()].map(run => `${run.id}: ${run.command.slice(0, 80)}`)
      return { result: listing.length ? `Running commands:\n${listing.join('\n')}` : 'No running commands.' }
    }
    const run = runs.get(args.session_id)
    if (!run) return { deny: `No session ${args.session_id}: it already finished and was reported, or never existed.` }

    if (args.terminate === true) {
      await $.tool.call({ tool: 'TaskStop', task_id: run.taskId } as never)
      const text = await waitWithinBudget($, run, TERMINATE_WAIT_MS, next.budget.remainingMs, next.signal)
      if (!parseTaskOutput(text).exit) run.failure = 'terminated by poll'
      return { result: takeReport(run, text, await $.clock.now(), args.max_output_chars) }
    }
    const text = await waitForTask($, run, yieldMs(args.yield_time_ms, MAX_POLL_YIELD_MS), next.budget.remainingMs, next.signal)
    return { result: takeReport(run, text, await $.clock.now(), args.max_output_chars) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'j-cc poll failed.' }))

  // 턴 중간에 실리는 알림은 register 의 prompt.attachment 훅이 지운다. matcher 없는 훅은 모듈에 하나만 둘 수 있다.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind === 'task-notification' && isReportedTaskNotice(e.text)) return { drop: '[j-cc] exec already reported this command.' }
    return next(e)
  }).catch(($, e, next) => next(e))
}
