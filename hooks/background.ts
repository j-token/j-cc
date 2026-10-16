// 오래 걸리는 명령을 포그라운드에서 기다리지 않도록 백그라운드로 돌린다.
// 소요 시간은 빌드·테스트·스크립트 실행기의 명령 키(`npm run build`, `cargo test`, `python train.py`)로만 기억한다.
// git, curl 같은 명령은 한 번 느렸다고 늘 느리지 않고, 결과를 바로 써야 하는 경우가 많다.

import { SCRIPT_RUNNERS, operands, rememberBounded } from './common'
import { commandName, stripPrefix, tokenize, type Shell } from './shell'

export const LONG_SECONDS = 45
const DEFAULT_SHELL_TIMEOUT_MS = 120_000
// 기억한 시간으로 이만큼 백그라운드에 보낸 뒤에는 기록을 지우고 다시 잰다.
const REMEASURE_AFTER = 3
const MAX_KEYS = 300
const TRACKED = /^(npm|pnpm|yarn|bun|make|just|task|cargo|go|dotnet|gradle|gradlew|mvn|uv|poetry|pytest|python[\d.]*|py|node|deno|tsx|vitest|jest|playwright|tox|nox)$/
const PASSIVE = new Set(['cd', 'pushd', 'set-location', 'sl', 'export', 'set', 'source', '.'])

export function commandKey(command: string, shell: Shell): string | null {
  for (const seg of tokenize(command, shell).segments) {
    const words = stripPrefix(seg, shell)
    const name = commandName(words[0] ?? '')
    if (!name || PASSIVE.has(name) || /^\$[\w:]+=/.test(words[0])) continue
    if (!TRACKED.test(name)) return null
    const args = operands(words.slice(1))
    const take = SCRIPT_RUNNERS.test(name) && args[0] === 'run' ? 2 : 1
    return [name, ...args.slice(0, take).map(w => w.replace(/\\/g, '/'))].join(' ')
  }
  return null
}

const KNOWN_LONG: RegExp[] = [
  /^(npm|pnpm|yarn|bun) (install|ci|i)\b/,
  /^(pip|pip3) install\b|^uv (sync|pip install)\b|^poetry install\b|^conda (install|create|env create)\b/,
  /^(docker|podman) (build|compose build|buildx build|pull)\b/,
  /^cargo build\b.* --release\b/,
  /^(gradle|gradlew|mvn)\b.*\b(build|assemble|package|install)\b/,
  /^dotnet publish\b/,
  /^unity\b.* -batchmode\b/i,
  /^(python[\d.]*|py|uv run|node|bun|deno)( -\S+)* \S*(train|finetune|fine_tune|eval|sweep|benchmark|bench|simulat|selfplay|self_play|folds|rollout)\w*\.(py|js|mjs|ts)\b/i,
  /^modal run\b/,
]

// 따옴표 안의 문장(`git commit -m "npm install 설명"`)에 걸리지 않도록, 공백이 든 인자는 빼고 세그먼트 단위로 맞춘다.
function knownLong(command: string, shell: Shell): boolean {
  return tokenize(command, shell).segments.some(seg => {
    const words = stripPrefix(seg, shell)
    if (!words.length) return false
    const line = [commandName(words[0]), ...words.slice(1).filter(w => !/\s/.test(w))].join(' ')
    return KNOWN_LONG.some(re => re.test(line))
  })
}

const isDetached = (command: string) => /\bnohup\b|\bStart-Process\b|\bStart-Job\b|&\s*$/.test(command.trim())

export type Timing = { seconds: number; backgrounded: number }
export type Timings = Record<string, Timing>
export const TIMINGS_STORE_KEY = 'timings'

export function rememberTiming(timings: Timings, key: string, seconds: number): Timings {
  return rememberBounded(timings, key, { seconds: Math.round(seconds), backgrounded: 0 }, MAX_KEYS)
}

// 기억한 시간 때문에 백그라운드로 보냈다는 표시. 정해진 횟수가 차면 기록을 지운다.
export function countBackgrounded(timings: Timings, key: string): Timings {
  const timing = timings[key]
  if (!timing) return timings
  if (timing.backgrounded + 1 >= REMEASURE_AFTER) {
    const next = { ...timings }
    delete next[key]
    return next
  }
  return rememberBounded(timings, key, { ...timing, backgrounded: timing.backgrounded + 1 }, MAX_KEYS)
}

export type BackgroundReason = { why: string; fromHistory: boolean }

export function backgroundReason(command: string, shell: Shell, timeoutMs: number | undefined, key: string | null, timings: Timings): BackgroundReason | null {
  if (isDetached(command)) return null
  if (knownLong(command, shell)) return { why: 'known long-running command', fromHistory: false }
  if (timeoutMs !== undefined && timeoutMs > DEFAULT_SHELL_TIMEOUT_MS) return { why: `timeout ${Math.round(timeoutMs / 1000)}s requested`, fromHistory: false }
  const last = key ? timings[key]?.seconds : undefined
  if (last !== undefined && last >= LONG_SECONDS) return { why: `"${key}" took ${last}s last time`, fromHistory: true }
  return null
}

export function backgroundNote(why: string): string {
  return [
    `[j-cc] Moved to the background (${why}): it is still running and you will be notified when it exits.`,
    'Do not run any step that depends on its result or side effects until that notification arrives, and do not sleep or poll for it.',
    'Meanwhile do only independent work (read code, plan, prepare edits); then check its output and exit status before continuing.',
  ].join(' ')
}

export function slowNote(seconds: number): string {
  return `[j-cc] This command blocked the session for ${Math.round(seconds)}s. Next time start commands like this with run_in_background: true and keep working while it runs.`
}
