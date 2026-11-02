import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'
import { screen, type ScreenOptions } from './bypass'
import type { Shell } from './shell'

// Codex 의 exec_command/write_stdin 처럼, 명령을 시작하고 몇 초 안에 중간 출력과 session_id 를 돌려준다.
// 내장 Bash/PowerShell 은 끝나거나 타임아웃이 날 때까지 아무것도 돌려주지 않아, 모델이 긴 명령을 몇 분씩 기다린다.

export const EXEC_TOOL = 'mcp__j-cc__exec'
export const POLL_TOOL = 'mcp__j-cc__poll'

export const DEFAULT_YIELD_MS = 5_000
// tool.call 훅의 예산은 10초이고 $.clock.sleep 은 예산을 쓴다. 결과를 만들 시간을 남긴다.
export const MAX_YIELD_MS = 8_000
const BUDGET_RESERVE_MS = 1_500
export const DEFAULT_MAX_OUTPUT_CHARS = 20_000
export const MAX_BUFFERED_CHARS = 1_000_000
const MAX_RUNNING = 16
const TERMINATE_WAIT_MS = 2_000

const GIT_BASH_CANDIDATES = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe']

export type Run = {
  id: number
  command: string
  startedAtMs: number
  unread: string
  droppedChars: number
  exit?: ProcessSpawnResult
  failure?: string
  finished: Promise<void>
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>
}

const runs = new Map<number, Run>()
let nextRunId = 1

export const shellToolName = (shell: Shell) => (shell === 'powershell' ? 'PowerShell' : 'Bash')

export function appendOutput(run: Pick<Run, 'unread' | 'droppedChars'>, text: string, limit = MAX_BUFFERED_CHARS): void {
  run.unread += text
  const overflow = run.unread.length - limit
  if (overflow <= 0) return
  run.unread = run.unread.slice(overflow)
  run.droppedChars += overflow
}

// 실패 원인은 보통 끝에 찍히므로 꼬리를 더 남긴다.
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const headChars = Math.floor(maxChars * 0.25)
  const tailChars = maxChars - headChars
  return `${text.slice(0, headChars)}\n…[${text.length - maxChars} chars omitted]…\n${text.slice(-tailChars)}`
}

export const isDone = (run: Pick<Run, 'exit' | 'failure'>) => run.exit !== undefined || run.failure !== undefined

export function statusLine(run: Pick<Run, 'id' | 'exit' | 'failure' | 'startedAtMs'>, nowMs: number): string {
  const wall = `wall ${((nowMs - run.startedAtMs) / 1000).toFixed(1)}s`
  if (run.failure !== undefined) return `Process failed: ${run.failure} (${wall})`
  if (run.exit) return `Process exited with ${run.exit.signal ? `signal ${run.exit.signal}` : `code ${run.exit.code}`} (${wall})`
  return `Process running with session_id ${run.id} (${wall}). Call poll with this session_id to read more output, or with terminate: true to stop it.`
}

// 읽은 출력은 비우고, 끝난 실행은 보고와 함께 잊는다.
export function takeReport(run: Run, nowMs: number, maxOutputChars: unknown): string {
  const maxChars = typeof maxOutputChars === 'number' && maxOutputChars > 0 ? maxOutputChars : DEFAULT_MAX_OUTPUT_CHARS
  const dropped = run.droppedChars > 0 ? `[${run.droppedChars} earlier chars dropped from the buffer]\n` : ''
  const output = run.unread
  run.unread = ''
  run.droppedChars = 0
  if (isDone(run)) runs.delete(run.id)
  return `${statusLine(run, nowMs)}\nOutput:\n${dropped}${clip(output, maxChars)}`
}

export function yieldMs(requested: unknown, remainingBudgetMs: number): number {
  const wanted = typeof requested === 'number' && requested >= 0 ? requested : DEFAULT_YIELD_MS
  const budget = Number.isFinite(remainingBudgetMs) ? remainingBudgetMs - BUDGET_RESERVE_MS : MAX_YIELD_MS
  return Math.max(0, Math.min(wanted, MAX_YIELD_MS, budget))
}

// 권한을 통과하면 엔진은 이 도구를 실행할 처리기를 찾다가 이 문구의 오류를 낸다(Claude Code 2.1.316).
// 그 밖의 결과는 거부로 보고 실행하지 않는다. 문구가 바뀌면 exec 가 실행되지 않을 뿐, 권한을 건너뛰지는 않는다.
const UNANSWERED_CALL = 'no tool.call hook answered this call'

export function passedPermission(gate: { deny?: string; isError?: boolean; text?: string }): boolean {
  return gate.deny === undefined && gate.isError === true && (gate.text ?? '').includes(UNANSWERED_CALL)
}

export const EXEC_DESCRIPTION = [
  'Run a shell command and get its output within a few seconds, even while it keeps running.',
  'If it finishes within yield_time_ms you get the exit code and output; otherwise you get the output so far and a session_id, and it keeps running.',
  'Then call poll with that session_id to read new output, or with terminate: true to stop it.',
  'Use it for commands that may take more than ~10 seconds and whose progress you want to see: builds, tests, lint, installs, docker, remote exec, git push.',
  'Each call starts a fresh shell (cwd and env are not carried over) with stdin closed, so interactive prompts do not work.',
  'The same permission rules as the Bash and PowerShell tools apply.',
].join(' ')

export const POLL_DESCRIPTION =
  'Read new output from a command exec left running, waiting up to yield_time_ms for it to finish. terminate: true stops it. Omit session_id to list running commands.'

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

async function argvFor($: EngineInterface, shell: Shell, command: string): Promise<string[] | null> {
  if (shell === 'powershell') {
    const utf8 = '[Console]::OutputEncoding=[Text.Encoding]::UTF8'
    return ['pwsh', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${utf8}; ${command}`]
  }
  const bash = await bashPath($)
  return bash ? [bash, '-c', command] : null
}

async function startRun($: EngineInterface, argv: string[], command: string, cwd: string | undefined): Promise<Run> {
  let markFinished!: () => void
  const finished = new Promise<void>(resolve => (markFinished = resolve))
  const run: Run = {
    id: nextRunId++,
    command,
    startedAtMs: await $.clock.now(),
    unread: '',
    droppedChars: 0,
    finished,
    stream: $.process.spawn({ argv, cwd }),
  }
  runs.set(run.id, run)
  // 훅이 돌아간 뒤에도 이 루프가 자식 프로세스를 살려 둔다. 루프를 떠나면 자식이 죽는다.
  void (async () => {
    try {
      for (;;) {
        const step = await run.stream.next()
        if (step.done) {
          run.exit = step.value
          break
        }
        appendOutput(run, step.value.text)
      }
    } catch (error) {
      run.failure = String((error as { message?: unknown })?.message ?? error)
    } finally {
      markFinished()
    }
  })()
  return run
}

async function waitForExitOrYield($: EngineInterface, run: Run, waitMs: number, signal: AbortSignal): Promise<void> {
  await Promise.race([run.finished, $.clock.sleep(waitMs, { signal }).catch(() => {})])
}

async function stopRun($: EngineInterface, run: Run, signal: AbortSignal): Promise<void> {
  await run.stream.return(undefined as never).catch(() => undefined)
  await waitForExitOrYield($, run, TERMINATE_WAIT_MS, signal)
  if (!isDone(run)) run.failure = 'terminated by poll'
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
      shell: { type: 'string', enum: ['bash', 'powershell'], description: 'bash (Git Bash on Windows, the default) or powershell (pwsh).' },
      cwd: { type: 'string', description: "Working directory; the session's when omitted." },
      yield_time_ms: { type: 'number', description: `How long to wait before returning; default ${DEFAULT_YIELD_MS}, at most ${MAX_YIELD_MS}.` },
      max_output_chars: { type: 'number', description: `Output budget; default ${DEFAULT_MAX_OUTPUT_CHARS}. Head and tail are kept.` },
    },
    required: ['cmd'],
  }
  const pollSchema = {
    type: 'object',
    properties: {
      session_id: { type: 'number', description: 'The session_id exec returned.' },
      yield_time_ms: { type: 'number', description: `How long to wait; default ${DEFAULT_YIELD_MS}, at most ${MAX_YIELD_MS}.` },
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
  on('tool.check', { tool: EXEC_TOOL }, async ($, e, next) => {
    const own = await next(e)
    if (own.decision === 'deny') return own
    const args = (e.input ?? {}) as ExecArgs
    const command = typeof args.cmd === 'string' ? args.cmd : ''
    const shellVerdict = await $.tool.check({ tool: shellToolName(shellOf(args)), input: { command } })
    // 훅이 돌려준 ask 는 사람만 답할 수 있어, auto 분류기의 허용도 "항상 허용" 규칙도 듣지 않고 매번 묻는다.
    // 같은 명령의 셸 판정이 ask 이면 엔진이 exec 에 내린 판정을 받은 그대로 넘겨, 묻는 일을 모드의 결정자에게 맡긴다.
    return shellVerdict.decision === 'ask' ? own : shellVerdict
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
    const argv = await argvFor($, shell, command)
    if (!argv) return { deny: 'Git Bash was not found. Set CLAUDE_CODE_GIT_BASH_PATH, or run this with shell: "powershell" or the Bash tool.' }

    const run = await startRun($, argv, command, typeof args.cwd === 'string' ? args.cwd : undefined)
    await waitForExitOrYield($, run, yieldMs(args.yield_time_ms, next.budget.remainingMs), next.signal)
    return { result: takeReport(run, await $.clock.now(), args.max_output_chars) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'j-cc exec failed before the command started.' }))

  on('tool.call', { tool: POLL_TOOL }, async ($, e, next) => {
    const args = e as unknown as PollArgs
    if (typeof args.session_id !== 'number') {
      const listing = [...runs.values()].map(run => `${run.id}: ${run.command.slice(0, 80)}`)
      return { result: listing.length ? `Running commands:\n${listing.join('\n')}` : 'No running commands.' }
    }
    const run = runs.get(args.session_id)
    if (!run) return { deny: `No session ${args.session_id}: it already finished and was reported, or never existed.` }

    if (args.terminate === true) await stopRun($, run, next.signal)
    else await waitForExitOrYield($, run, yieldMs(args.yield_time_ms, next.budget.remainingMs), next.signal)
    return { result: takeReport(run, await $.clock.now(), args.max_output_chars) }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'j-cc poll failed.' }))
}
