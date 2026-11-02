import { expect, test } from 'claude-code/testing'
import { TIMINGS_STORE_KEY, backgroundReason, commandKey, countBackgrounded, rememberTiming, type Timings } from './background'

test('keys only build, test and script runners', () => {
  expect(commandKey('cd app && npm run build -- --prod', 'bash')).toBe('npm run build')
  expect(commandKey('npm test', 'bash')).toBe('npm test')
  expect(commandKey('.venv/Scripts/python.exe train.py --epochs 3', 'bash')).toBe('python train.py')
  expect(commandKey('Set-Location app; cargo test -p core', 'powershell')).toBe('cargo test')
  expect(commandKey('git status', 'bash')).toBe(null)
  expect(commandKey('curl -s localhost:3000/health', 'bash')).toBe(null)
  expect(commandKey('$env:X=1; git log -1', 'powershell')).toBe(null)
})

const reasonOf = (command: string, timeoutMs?: number, timings: Timings = {}) =>
  backgroundReason(command, 'bash', timeoutMs, commandKey(command, 'bash'), timings)?.why ?? null

test('decides when to go to the background', () => {
  expect(reasonOf('npm ci')).toBe('known long-running command')
  expect(reasonOf('docker build -t app .')).toBe('known long-running command')
  expect(reasonOf('.venv/Scripts/python.exe -u scripts/train_ppo.py --steps 1e6')).toBe('known long-running command')
  expect(reasonOf('python parallel_eval.py --workers 4')).toBe('known long-running command')
  expect(backgroundReason('& "C:\\Program Files\\Unity\\Editor\\Unity.exe" -batchmode -quit', 'powershell', undefined, null, {})?.why).toBe('known long-running command')
  expect(reasonOf('npm test', 300_000)).toBe('timeout 300s requested')
  expect(reasonOf('npm test', undefined, { 'npm test': { seconds: 120, backgrounded: 0 } })).toBe('"npm test" took 120s last time')
  expect(reasonOf('npm test', undefined, { 'npm test': { seconds: 8, backgrounded: 0 } })).toBe(null)
  expect(reasonOf('npm test', 120_000)).toBe(null)
  expect(reasonOf('python report.py')).toBe(null)
  expect(reasonOf('nohup npm ci')).toBe(null)
  expect(reasonOf('git commit -m "docs: explain npm install step"')).toBe(null)
  expect(reasonOf('gh pr create --title x --body "run pip install -r req.txt then train.py"')).toBe(null)
})

test('remeasures a remembered key after a few background runs', () => {
  let timings = rememberTiming({}, 'npm test', 90)
  timings = countBackgrounded(timings, 'npm test')
  timings = countBackgrounded(timings, 'npm test')
  expect(timings['npm test']).toEqual({ seconds: 90, backgrounded: 2 })
  timings = countBackgrounded(timings, 'npm test')
  expect(timings['npm test']).toBe(undefined)
})

test('briefs each subagent once and never backgrounds its commands', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  const seen: (boolean | undefined)[] = []
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash') seen.push(e.run_in_background)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  const first = await $.tool.call({ tool: 'Bash', command: 'npm ci', agentId: 'sub-1' } as never)
  const second = await $.tool.call({ tool: 'Bash', command: 'git status', agentId: 'sub-1' } as never)
  const denied = await $.tool.call({ tool: 'Bash', command: 'grep -rn x src', agentId: 'sub-2' } as never)
  const main = await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(seen).toEqual([undefined, undefined, undefined])
  expect(JSON.stringify(first)).toContain('Context for this subagent')
  expect(JSON.stringify(second)).not.toContain('Context for this subagent')
  expect(JSON.stringify(denied)).toContain('Context for this subagent')
  expect(JSON.stringify(main)).not.toContain('[j-cc]')
})

test('moves long and remembered-slow commands to the background', async ($, on) => {
  const store = new Map<string, unknown>([[TIMINGS_STORE_KEY, { 'cargo test': { seconds: 200, backgrounded: 0 } }]])
  let now = 0
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: now }))
  const seen: (boolean | undefined)[] = []
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash') {
      seen.push(e.run_in_background)
      if (e.command === 'make e2e') now += 90_000
    }
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  const timed = await $.tool.call({ tool: 'Bash', command: 'npm test', timeout: 300_000 })
  await $.tool.call({ tool: 'Bash', command: 'cargo test' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  const slow = await $.tool.call({ tool: 'Bash', command: 'make e2e' })
  await $.tool.call({ tool: 'Bash', command: 'make e2e' })
  expect(seen).toEqual([true, true, undefined, undefined, true])
  expect(JSON.stringify(timed)).toContain('Moved to the background')
  expect(JSON.stringify(slow)).toContain('took 90s in the foreground. Next time')
  expect((store.get(TIMINGS_STORE_KEY) as Timings)['cargo test']).toEqual({ seconds: 200, backgrounded: 1 })
})

const contextOf = (r: unknown) => ((r as { context?: string[] }).context ?? []).join('\n')

test('백그라운드 전환 안내와 느린 명령 안내는 설정한 응답 언어를 유지하라는 문장으로 끝난다', async ($, on) => {
  let now = 0
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('settings.read', () => ({ value: { language: '한국어' } }))
  on('clock.now', () => ({ value: now }))
  on('tool.call', ($, e) => {
    if (e.tool === 'PowerShell' && e.command === 'make e2e') now += 90_000
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  const moved = contextOf(await $.tool.call({ tool: 'PowerShell', command: 'npm run build', timeout: 600_000 }))
  const slow = contextOf(await $.tool.call({ tool: 'PowerShell', command: 'make e2e' }))

  expect(moved).toStartWith('[j-cc] Moved to the background (timeout 600s requested)')
  expect(moved).toEndWith('Reply to the user in 한국어; English notes and tool output do not change your reply language.')
  expect(slow).toEndWith('Reply to the user in 한국어; English notes and tool output do not change your reply language.')
})

test('메인 세션의 모든 도구 결과 뒤에 응답 언어 문장을 한 번 붙이고 서브에이전트에는 붙이지 않는다', async ($, on) => {
  on('settings.read', () => ({ value: { language: '한국어' } }))
  on('tool.call', () => ({ result: 'ok' }))

  const main = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.ts' } as never))
  const sub = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.ts', agentId: 'sub-1' } as never))

  expect(main).toBe('Reply to the user in 한국어; English notes and tool output do not change your reply language.')
  expect(sub).toBe('')
})

test('하네스가 대화 중간에 끼워 넣는 알림에는 응답 언어 문장을 붙이고 처음 실리는 목록에는 붙이지 않는다', async ($, on) => {
  on('settings.read', () => ({ value: {} }))
  on('prompt.attachment', ($, e) => ({ text: e.text }))

  const notice = await $.prompt.attachment({ type: 'queued_command', text: 'The user sent a new message.', origin: { kind: 'engine' } } as never)
  const listing = await $.prompt.attachment({ type: 'nested_memory', text: 'Contents of CLAUDE.md', origin: { kind: 'engine' } } as never)

  expect(notice.text).toBe(`The user sent a new message.\n${KEEP_CURRENT_LANGUAGE}`)
  expect(listing.text).toBe('Contents of CLAUDE.md')
})

const KEEP_CURRENT_LANGUAGE = 'Reply to the user in the language the user writes to you in; English notes and tool output do not change your reply language.'

test('응답 언어 설정이 없으면 지금까지 쓰던 언어를 유지하라고 안내한다', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('settings.read', () => ({ value: {} }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  const moved = contextOf(await $.tool.call({ tool: 'Bash', command: 'npm ci' }))

  expect(moved).toEndWith(KEEP_CURRENT_LANGUAGE)
})

test('설정을 읽지 못해도 백그라운드 명령을 다시 실행하지 않고 지금까지 쓰던 언어를 유지하라고 안내한다', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('settings.read', () => {
    throw new Error('settings unavailable')
  })
  let runs = 0
  on('tool.call', () => {
    runs += 1
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  const moved = contextOf(await $.tool.call({ tool: 'Bash', command: 'npm ci' }))

  expect(moved).toEndWith(KEEP_CURRENT_LANGUAGE)
  expect(runs).toBe(1)
})
