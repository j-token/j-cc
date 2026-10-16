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
  expect(JSON.stringify(slow)).toContain('blocked the session for 90s')
  expect((store.get(TIMINGS_STORE_KEY) as Timings)['cargo test']).toEqual({ seconds: 200, backgrounded: 1 })
})
