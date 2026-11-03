// 명령의 모양만 보고 정하는 결정적 규칙. 외부 모델을 부르지 않는다.
// 근사 판단이므로 잘못 막히면 `# j-cc:allow: <이유>` 주석을 붙여 다시 실행한다.

import { PYTHON, SCRIPT_RUNNERS, hasFlag, operands } from './common'
import { commandName, stripPrefix, tokenize, type Segment, type Shell } from './shell'

type Kind = 'write' | 'edit' | 'search' | 'view' | 'follow' | 'forever' | 'schedule' | 'poll' | 'wait' | 'watch' | 'chain'
export type Verdict = { kind: Kind; detail?: string }
export type JudgeOptions = { blockChaining?: boolean }

const NULL_TARGET = /^(\/dev\/(null|stdout|stderr|tty)|\$null|nul|con)$/i
const SPECIAL_PATH = /^\/(proc|sys|dev)\//
const realOutputs = (seg: Segment) => (seg.outputs ?? []).filter(t => !NULL_TARGET.test(t))

const INLINE_FLAGS: Record<string, string[]> = {
  python: ['-c'],
  node: ['-e', '--eval', '-p', '--print'],
  bun: ['-e', '--eval', '-p', '--print'],
  deno: ['eval'],
  ruby: ['-e'],
  perl: ['-e', '-E'],
  php: ['-r'],
}
const WRITE_APIS: RegExp[] = [
  /\bopen\s*\([^)]*?,\s*(?:mode\s*=\s*)?["'][rbt]*[wax+]/,
  /\.write_(?:text|bytes)\s*\(/,
  /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|writeTextFile|writeTextFileSync)\s*\(/,
  /\bBun\.write\s*\(/,
  /\bFile\.(?:write|open\s*\([^)]*["'][wa])/,
  /\bfile_put_contents\s*\(/,
  /\b(?:Set|Add)-Content\b|\bOut-File\b/i,
  /::(?:Write|Append)All(?:Text|Lines|Bytes)\b/i,
]
const writesFiles = (code: string) => WRITE_APIS.some(re => re.test(code))
const PS_FILE_API = /^\[(?:System\.)?IO\.File\]::(?:Write|Append)All/i
const SED_IN_PLACE = /^(-[a-zA-Z]*i|--in-place)/
const BYPASS = /^#\s*(?:j-cc|use-right-tool):allow:\s*(\S.*)$/
const MAX_NESTING = 3

function interpreterKind(name: string): string | null {
  if (PYTHON.test(name)) return 'python'
  if (name === 'nodejs') return 'node'
  return name in INLINE_FLAGS ? name : null
}

function literalText(seg: Segment, shell: Shell): string | null {
  const words = stripPrefix(seg, shell)
  const name = commandName(words[0] ?? '')
  if (shell === 'powershell' && seg.firstQuoted) return seg.join(' ')
  if (name === 'echo' || name === 'printf' || name === 'write-output') return words.slice(1).join(' ')
  if (name === 'cat' && (seg.heredocs || seg.herestring !== undefined)) return [...(seg.heredocs ?? []), seg.herestring ?? ''].join('\n')
  return null
}

// 인터프리터가 명령 안에서 바로 받는 코드(-c, heredoc, 파이프로 받은 문자열). 스크립트 파일을 실행하면 null.
function inlineCode(seg: Segment, words: string[], kind: string, prev: Segment | null, shell: Shell): string | null {
  const args = words.slice(1)
  const flags = INLINE_FLAGS[kind]
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (flags.includes(a)) return args[i + 1] ?? ''
    if (a === '-') break
    if (!a.startsWith('-')) return null
  }
  const stdin = [...(seg.heredocs ?? []), seg.herestring ?? '']
  if (seg.piped && prev) stdin.push(literalText(prev, shell) ?? '')
  return stdin.join('\n')
}

function nestedShell(words: string[]): { code: string; shell: Shell } | null {
  const name = commandName(words[0] ?? '')
  if (/^(bash|sh|zsh)$/.test(name) && words[1] === '-c' && words[2]) return { code: words[2], shell: 'bash' }
  if (name === 'pwsh' || name === 'powershell') {
    const i = words.findIndex(w => /^-(c|command)$/i.test(w))
    if (i > 0 && words[i + 1]) return { code: words.slice(i + 1).join(' '), shell: 'powershell' }
  }
  return null
}

function writeKind(seg: Segment, prev: Segment | null, shell: Shell, nesting: number): 'write' | 'edit' | null {
  const words = stripPrefix(seg, shell)
  if (!words.length) return null
  // sudo tee /etc/hosts 처럼 권한이 필요한 쓰기는 Write 도구로 할 수 없다.
  if (/^(sudo|doas)$/.test(commandName(seg[0]))) return null
  const name = commandName(words[0])
  const args = words.slice(1)
  const outputs = realOutputs(seg)
  const fromLiteral = seg.piped && prev !== null && literalText(prev, shell) !== null

  if (shell === 'powershell') {
    if (seg.firstQuoted && outputs.length) return 'write'
    // `... | ConvertTo-Json | Set-Content a.json` 처럼 계산한 값을 저장하는 것은 Write 로 대신하기 어렵다.
    if (/^(set-content|sc|add-content|ac)$/.test(name) && (!seg.piped || fromLiteral)) return 'write'
    if (name === 'out-file' && fromLiteral) return 'write'
    if ((name === 'new-item' || name === 'ni') && hasFlag(args, /^-value$/i)) return 'write'
    if (PS_FILE_API.test(words[0])) return 'write'
  }
  // `echo $! > pid` 처럼 변수 값만 저장하는 것은 파일 작성이 아니다.
  if ((name === 'echo' || name === 'printf' || name === 'write-output') && outputs.length && !args.every(a => a.startsWith('$'))) return 'write'
  if (name === 'cat' && outputs.length && (seg.heredocs || seg.herestring !== undefined)) return 'write'
  if (name === 'tee' && operands(args).some(a => !NULL_TARGET.test(a))) {
    if (seg.heredocs || seg.herestring !== undefined || fromLiteral) return 'write'
  }
  if (name === 'sed' && hasFlag(args, SED_IN_PLACE)) return 'edit'
  if (name === 'perl' && hasFlag(args, /^-[lnpaesw0-9]*i/)) return 'edit'
  const kind = interpreterKind(name)
  if (kind) {
    const code = inlineCode(seg, words, kind, prev, shell)
    if (code && writesFiles(code)) return 'edit'
  }
  const nested = nesting < MAX_NESTING ? nestedShell(words) : null
  if (nested) {
    const inner = dedicatedToolVerdict(nested.code, nested.shell, nesting + 1)?.kind
    return inner === 'write' || inner === 'edit' ? inner : null
  }
  return null
}

const VIEW_FILTERS = new Set(['head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'sort', 'uniq', 'cut', 'wc', 'findstr', 'select-object', 'select', 'select-string', 'sls', 'measure-object', 'measure'])
const SEARCHERS = /^(grep|egrep|fgrep|rg|ag|ack|findstr|select-string|sls)$/
const COUNTERS = /^(wc|measure-object|measure)$/
const NEUTRAL = new Set(['cd', 'pushd', 'popd', 'set-location', 'sl', 'ls', 'dir', 'pwd', 'get-location', 'echo', 'printf', 'write-output', 'write-host'])

// tail -f, -fn 50, -F, --follow=name. 대소문자를 구분해야 PowerShell 의 -First, -Force 와 섞이지 않는다.
const tailFollows = (args: readonly string[]) => hasFlag(args, /^(-[a-zA-Z0-9]*f[a-zA-Z0-9]*|-F|--follow(=.*)?)$/)
// PowerShell 은 매개변수 이름을 줄여 쓸 수 있다(-Wai, -Wait:$true).
const psWaits = (args: readonly string[]) => hasFlag(args, /^-wa(i(t)?)?(:.*)?$/i)

type ReadKind = 'view' | 'search' | 'filter' | 'neutral' | 'other'

function readKind(seg: Segment, shell: Shell): ReadKind {
  const words = stripPrefix(seg, shell)
  if (!words.length) return 'other'
  const name = commandName(words[0])
  const args = words.slice(1)
  const ps = shell === 'powershell'
  if (NEUTRAL.has(name) && !realOutputs(seg).length) {
    const recursive = ps ? /^-(recurse|r)$/i : /^-[a-zA-Z]*R[a-zA-Z]*$/
    if ((name === 'ls' || name === 'dir') && hasFlag(args, recursive)) return 'search'
    return 'neutral'
  }
  if (realOutputs(seg).length || seg.heredocs || seg.herestring !== undefined) return 'other'
  const files = operands(args)

  if (seg.piped) {
    // 줄 수 세기는 Read 로 대신할 수 없다.
    if (!VIEW_FILTERS.has(name) || COUNTERS.test(name) || (name === 'tail' && tailFollows(args))) return 'other'
    return SEARCHERS.test(name) ? 'search' : 'filter'
  }
  if (files.some(f => SPECIAL_PATH.test(f))) return 'other'
  if (/^(cat|nl|tac|bat|less|more)$/.test(name) && files.length) return 'view'
  if (name === 'head' && files.length) return 'view'
  if (name === 'sed' && hasFlag(args, /^-[a-zA-Z]*n/) && !hasFlag(args, SED_IN_PLACE) && files.length >= 2) return 'view'
  // 로그 끝부분은 Read 로 보기 어려우므로 tail 과 Get-Content -Tail 은 허용한다.
  if (ps && /^(get-content|gc|type)$/.test(name) && files.length && !psWaits(args) && !hasFlag(args, /^-tail$/i)) return 'view'
  if (SEARCHERS.test(name) && files.length) return 'search'
  if (name === 'find' && !hasFlag(args, /^-(exec|execdir|ok|okdir|delete|fprint)/)) return 'search'
  if ((name === 'fd' || name === 'fdfind') && !hasFlag(args, /^(-x|-X|--exec|--exec-batch)$/)) return 'search'
  if (ps && /^(get-childitem|gci|ls|dir)$/.test(name)) return hasFlag(args, /^-(recurse|r|filter|include)$/i) ? 'search' : 'neutral'
  return 'other'
}

// 파이프 뒤의 필터·검색은 파일 보기에 이어질 때만 파일 작업이다. `echo $PATH | grep node` 같은 출력 거르기는 막지 않는다.
function pipedKind(kind: ReadKind, before: ReadKind | undefined): ReadKind {
  if (kind !== 'search' && kind !== 'filter') return kind
  if (before === 'view') return kind === 'filter' ? 'view' : 'search'
  if (before === 'search' || before === 'filter') return kind
  return 'other'
}

// 전용 파일 도구(Write/Edit/Read/Grep/Glob)로 할 일을 셸로 하는지 본다.
function dedicatedToolVerdict(command: string, shell: Shell, nesting = 0): Verdict | null {
  const { segments, substitutions } = tokenize(command, shell)
  let prev: Segment | null = null
  for (const seg of segments) {
    const kind = writeKind(seg, prev, shell, nesting)
    if (kind) return { kind }
    prev = seg
  }
  // 명령 전체가 파일 보기·검색뿐일 때만 막는다.
  if (substitutions.length || !segments.length) return null
  // 파이프라인 하나는 마지막 단계의 판정으로 합친다. `cat a | grep x` 는 보기가 아니라 검색이다.
  const kinds: ReadKind[] = []
  for (const seg of segments) {
    const kind = readKind(seg, shell)
    if (seg.piped && kinds.length) kinds[kinds.length - 1] = pipedKind(kind, kinds.at(-1))
    else kinds.push(seg.piped ? pipedKind(kind, undefined) : kind)
  }
  if (kinds.includes('other')) return null
  const searches = kinds.includes('search')
  const views = kinds.includes('view')
  if (searches && views) return { kind: 'search', detail: ALSO_VIEWS }
  if (searches) return { kind: 'search' }
  if (views) return { kind: 'view' }
  return null
}

const ALSO_VIEWS = 'also views'

const DURATION_UNIT: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }

function bashSleep(args: readonly string[]): number {
  return args.reduce((sum, a) => {
    const m = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(a)
    return m ? sum + Number(m[1]) * DURATION_UNIT[m[2]] : sum
  }, 0)
}

function psSleep(args: readonly string[]): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const value = Number(args[i + 1])
    if (/^-(m|milliseconds?)$/i.test(a) && Number.isFinite(value)) return value / 1000
    if (/^-(s|seconds?)$/i.test(a) && Number.isFinite(value)) return value
    if (/^\d+(\.\d+)?$/.test(a) && (i === 0 || !args[i - 1].startsWith('-'))) return Number(a)
  }
  return 0
}

const INLINE_SLEEPS: [RegExp, number][] = [
  [/time\.sleep\(\s*(\d+(?:\.\d+)?)\s*\)/, 1],
  [/setTimeout\([^,]*,\s*(\d+)\s*\)/, 1 / 1000],
  [/\bsleep\(\s*(\d+(?:\.\d+)?)\s*\)/, 1],
]

function waitSeconds(words: string[], shell: Shell): number {
  const name = commandName(words[0] ?? '')
  const args = words.slice(1)
  if (name === 'sleep' && shell === 'bash') return bashSleep(args)
  if (name === 'start-sleep' || (name === 'sleep' && shell === 'powershell')) return psSleep(args)
  if (name === 'timeout' || name === 'waitfor') {
    const i = args.findIndex(a => /^\/t$/i.test(a))
    return i >= 0 ? Number(args[i + 1]) || 0 : 0
  }
  if (name === 'ping') {
    const i = args.findIndex(a => /^[-/][nc]$/i.test(a))
    return i >= 0 ? Math.max(0, (Number(args[i + 1]) || 0) - 1) : 0
  }
  const kind = interpreterKind(name)
  if (kind) {
    const code = args.join(' ')
    for (const [re, scale] of INLINE_SLEEPS) {
      const m = re.exec(code)
      if (m) return Number(m[1]) * scale
    }
  }
  return 0
}

function isFollow(words: string[], shell: Shell): boolean {
  const name = commandName(words[0] ?? '')
  const args = words.slice(1)
  const sub = operands(args)[0]
  if ((name === 'tail' || name === 'cat') && tailFollows(args)) return true
  if (shell === 'powershell' && /^(get-content|gc|type)$/.test(name) && psWaits(args)) return true
  if (name === 'watch' || name === 'stern') return true
  if (name === 'inotifywait' && hasFlag(args, /^-[a-zA-Z]*m$/)) return true
  if (name === 'ping' && hasFlag(args, /^[-/]t$/i)) return true
  if (name === 'journalctl' && hasFlag(args, /^(-[a-zA-Z]*f|--follow)$/)) return true
  // docker/kubectl 의 -f 는 대개 파일·강제 옵션이므로 스트리밍 하위 명령에서만 본다.
  if (/^(docker|podman|kubectl|oc)$/.test(name) && sub === 'logs' && hasFlag(args, /^(-[a-zA-Z]*f|--follow)$/)) return true
  if (/^(kubectl|oc)$/.test(name) && sub === 'get' && hasFlag(args, /^(-w|--watch|--watch-only)$/)) return true
  if ((name === 'docker' || name === 'podman') && sub === 'events') return true
  return name === 'gh' && args[0] === 'run' && args[1] === 'watch'
}

const SERVE_SCRIPTS = /^(dev|start|serve|watch|preview)(:.*)?$/
const SERVERS = new Set(['nodemon', 'uvicorn', 'gunicorn', 'live-server', 'http-server', 'browser-sync', 'serve'])

function isWatchMode(words: string[]): boolean {
  const name = commandName(words[0] ?? '')
  const args = words.slice(1)
  if (hasFlag(args, /^--watch(All)?$/) || hasFlag(args, /^--reload$/)) return true
  if (SERVERS.has(name)) return true
  if (SCRIPT_RUNNERS.test(name)) {
    const script = args[0] === 'run' ? args[1] : args[0]
    return script !== undefined && SERVE_SCRIPTS.test(script)
  }
  if (name === 'tsc' && hasFlag(args, /^-w$/)) return true
  if (/^(vite|next|nuxt|astro|remix)$/.test(name)) return args.length === 0 || /^(dev|serve|preview|start)$/.test(args[0])
  if ((name === 'cargo' || name === 'dotnet') && args[0] === 'watch') return true
  if (PYTHON.test(name) && args[0] === '-m' && /^(http\.server|uvicorn)$/.test(args[1] ?? '')) return true
  if (PYTHON.test(name) && args.includes('runserver')) return true
  if (name === 'flask' && args[0] === 'run') return true
  if (name === 'rails' && /^(s|server)$/.test(args[0] ?? '')) return true
  if ((name === 'ng' && args[0] === 'serve') || (name === 'hugo' && args[0] === 'server') || (name === 'mkdocs' && args[0] === 'serve')) return true
  if (name === 'php' && args[0] === 'artisan' && args[1] === 'serve') return true
  if (name === 'kubectl' && args[0] === 'port-forward') return true
  const composeUp = ((name === 'docker' || name === 'podman') && args[0] === 'compose' && args[1] === 'up') || (name === 'docker-compose' && args[0] === 'up')
  return composeUp && !hasFlag(args, /^(-d|--detach|--wait)$/)
}

const LOOP_HEADS = new Set(['while', 'until', 'for', 'foreach', 'foreach-object', '%', 'do'])
const INFINITE = /\bwhile\s*(?:true\b|:(?=\s*;|\s*do\b)|\[\s*1\s*\]|\(\s*(?:\$true|1)\s*\))|\bfor\s*\(\s*;\s*;\s*\)|\bloop\s*\{/i
const FOREGROUND_WAIT_LIMIT = 5
const SCHEDULE_LIMIT = 60

// 셸로 루프·폴링·감시·대기를 흉내 내는지 본다(Monitor, run_in_background, /loop, CronCreate 로 할 일).
function timingVerdict(command: string, shell: Shell, background: boolean, nesting = 0): Verdict | null {
  const { segments, substitutions } = tokenize(command, shell)
  let hasLoop = false
  let longestWait = 0
  let totalWait = 0
  for (const seg of segments) {
    if (LOOP_HEADS.has(commandName(seg[0]))) hasLoop = true
    const words = stripPrefix(seg, shell)
    if (isFollow(words, shell)) return { kind: 'follow' }
    if (seg.background) continue
    if (!background && isWatchMode(words)) return { kind: 'watch' }
    const wait = waitSeconds(words, shell)
    longestWait = Math.max(longestWait, wait)
    totalWait += wait
    const nested = nesting < MAX_NESTING ? nestedShell(words) : null
    if (nested) {
      const inner = timingVerdict(nested.code, nested.shell, background, nesting + 1)
      if (inner) return inner
    }
  }
  if (nesting < MAX_NESTING) {
    for (const inner of substitutions) {
      const verdict = timingVerdict(inner, shell, background, nesting + 1)
      if (verdict) return verdict
    }
  }
  if (hasLoop && longestWait > 0) {
    if (INFINITE.test(command)) return { kind: 'forever' }
    if (longestWait >= SCHEDULE_LIMIT) return { kind: 'schedule', detail: `${longestWait}s per iteration` }
    return background ? null : { kind: 'poll' }
  }
  if (!background && totalWait >= FOREGROUND_WAIT_LIMIT) return { kind: 'wait', detail: `${totalWait}s` }
  return null
}

// heredoc 본문은 셸 문법이 아니라 데이터이므로 연결자 검사에서 뺀다.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g

// 따옴표 밖의 &&, ||, ; 를 찾는다. 파이프(|)와 백그라운드(&)는 연결자로 보지 않는다.
// 반복문의 `; do` 와 PowerShell 블록 안의 `;` 도 막히지만, 판별을 단순하게 두고 나눠 실행하게 한다.
function chainOperator(command: string, shell: Shell): string | null {
  const text = command.replace(HEREDOC, '')
  const escape = shell === 'powershell' ? '`' : '\\'
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === escape && quote === '"') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === escape) {
      i++
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      continue
    }
    if (c === ';') return ';'
    const pair = text.slice(i, i + 2)
    if (pair === '&&' || pair === '||') return pair
  }
  return null
}

export function bypassReason(command: string, shell: Shell): string | null {
  for (const comment of tokenize(command, shell).comments) {
    const m = BYPASS.exec(comment.trim())
    if (m) return m[1].trim()
  }
  return null
}

export const hasBypass = (command: string, shell: Shell) => bypassReason(command, shell) !== null

export function judge(command: string, shell: Shell, background: boolean, options: JudgeOptions = {}): Verdict | null {
  if (hasBypass(command, shell)) return null
  return ruleVerdict(command, shell, background, options)
}

// 우회 주석과 상관없이 규칙이 무엇을 막는지 본다. 파일 작업과 대기 판정이 더 구체적인 안내를 주므로 체이닝은 마지막에 본다.
export function ruleVerdict(command: string, shell: Shell, background: boolean, { blockChaining = true }: JudgeOptions = {}): Verdict | null {
  if (!command.trim()) return null
  const verdict = dedicatedToolVerdict(command, shell) ?? timingVerdict(command, shell, background)
  if (verdict || !blockChaining) return verdict
  const op = chainOperator(command, shell)
  return op ? { kind: 'chain', detail: op } : null
}

const GUIDANCE: Record<Kind, string[]> = {
  write: [
    'This command writes file contents from the shell (heredoc, echo/printf redirect, tee, Set-Content, ...).',
    '- Use `Write` to create or overwrite a file and `Edit` to change one; for a throwaway script, `Write` it to the scratchpad and run that file.',
  ],
  edit: [
    'This command edits files from the shell (sed -i, perl -i, or an inline script that writes files).',
    '- Use `Edit` for each change (`replace_all` for repeated text) or `Write` to replace a whole file. Only Edit/Write changes can be undone with /rewind.',
  ],
  search: [
    'This command only searches files (grep, rg, find, Select-String, recursive listing, ...).',
    '- Use `Grep` for content (`output_mode`, `-n`, `-C`, `glob`, `type`, `head_limit`) and `Glob` to find files by name. For a broad multi-file hunt, delegate to an Explore/explorer agent.',
  ],
  view: [
    'This command only prints file contents (cat, head, sed -n, Get-Content, ...).',
    '- Use `Read` (with `offset`/`limit` for a slice of a large file); it also reads images, PDFs and notebooks. Read several files in parallel in one message.',
  ],
  follow: [
    'This command follows a stream forever (tail -f, Get-Content -Wait, watch, logs -f, ...).',
    '- Run that same command with the `Monitor` tool, which streams new lines to you as notifications, optionally filtered by grep.',
  ],
  forever: [
    'This command never ends on its own (an endless loop or a repeating job).',
    '- To watch for an event, use `Monitor`. To repeat a task on an interval, use `/loop`, `CronCreate`, or `ScheduleWakeup`.',
  ],
  schedule: [
    'This shell loop sleeps a minute or more per iteration, which makes it a scheduler or a long watch.',
    '- To wait for a condition, run the until-loop with the `Monitor` tool. To repeat work on an interval, use `/loop`, `CronCreate`, or `ScheduleWakeup`.',
  ],
  poll: [
    'This command polls in the foreground (a loop with sleeps), blocking the session.',
    '- Wait on the condition with the `Monitor` tool (an until-loop is fine there), or rerun this with `run_in_background: true`; you are notified when it exits.',
  ],
  wait: [
    'This command sleeps in the foreground before doing its work.',
    '- Do not guess durations. Run the long job with `run_in_background: true` (you are notified when it exits), or use `Monitor` with an until-loop on the real condition.',
  ],
  watch: [
    'This command starts a long-running process (dev server, --watch, --reload) in the foreground, which never returns.',
    '- Rerun it with `run_in_background: true`, then use `Monitor` on its output (or read the output file) to see when it is ready.',
  ],
  chain: [
    'This command chains commands with `&&`, `||` or `;` outside quotes.',
    '- Run each command in its own tool call, and send independent ones in parallel in one message. Instead of `cd dir && cmd`, use absolute paths, `git -C <dir>`, or the `cwd` of mcp__j-cc__exec. Make file changes with Edit/Write, then run the command in the next call. For a loop or a multi-step script, `Write` it to the scratchpad and run that file.',
  ],
}

const verdictTag = (verdict: Verdict) => (verdict.detail ? `${verdict.kind}, ${verdict.detail}` : verdict.kind)

const SEARCH_AND_VIEW_GUIDANCE = [
  'This command only searches and prints files (grep, find, ... together with cat, head, sed -n, Get-Content, ...).',
  GUIDANCE.search[1],
  GUIDANCE.view[1],
]

export function guidance(verdict: Verdict): string {
  const lines = verdict.kind === 'search' && verdict.detail === ALSO_VIEWS ? SEARCH_AND_VIEW_GUIDANCE : GUIDANCE[verdict.kind]
  return lines.join('\n')
}

const BYPASS_HINT =
  'Use the shell only for what dedicated tools cannot do. If the shell really is required here, rerun it with a trailing comment `# j-cc:allow: <reason>` that says concretely why the dedicated tool cannot do it; a small model checks that reason before the command runs.'

export function reason(verdict: Verdict): string {
  return [`[j-cc] Blocked (${verdictTag(verdict)}): this command was not run.`, guidance(verdict), BYPASS_HINT].join('\n')
}

export function bypassRejected(verdict: Verdict, statedReason: string, advice: string): string {
  return [
    `[j-cc] Bypass rejected (${verdictTag(verdict)}): this command was not run.`,
    `Your reason "${statedReason}" does not show that the shell is needed here.`,
    advice ? `- ${advice}` : guidance(verdict),
    'If the dedicated tool truly cannot do this, rerun with a `# j-cc:allow:` reason that names what it cannot do.',
  ].join('\n')
}
