import { expect, test } from 'claude-code/testing'
import { parseLabel, scriptTargets, shouldAsk } from './judge'

test('finds the local code a command runs', () => {
  expect(scriptTargets('cd tools && .venv/Scripts/python.exe -u check.py --once', 'bash')).toEqual([{ kind: 'file', path: 'check.py' }])
  expect(scriptTargets('./runner.sh', 'bash')).toEqual([{ kind: 'file', path: './runner.sh' }])
  expect(scriptTargets('pnpm run db:prep', 'bash')).toEqual([{ kind: 'package-script', name: 'db:prep' }])
  expect(scriptTargets('git status', 'bash')).toEqual([])
})

test('asks only when a loop, wait or server shows up', () => {
  expect(shouldAsk({ command: 'python check.py', sources: [{ label: 'check.py', code: 'while not done():\n    time.sleep(5)' }] })).toBe(true)
  expect(shouldAsk({ command: 'python report.py', sources: [{ label: 'report.py', code: 'print(sum(range(10)))' }] })).toBe(false)
  expect(shouldAsk({ command: 'npm test', sources: [] })).toBe(false)
})

test('parses the label the model answers', () => {
  expect(parseLabel('wait_poll')).toBe('wait_poll')
  expect(parseLabel(' Endless.\n')).toBe('endless')
  expect(parseLabel('maybe')).toBe(null)
})

const SCRIPTS: Record<string, string> = {
  'check.py': 'import time\nwhile not ready():\n    time.sleep(10)\n',
  'monitor.py': 'import time\nwhile True:\n    report()\n    time.sleep(30)\n',
  'report.py': 'print("hi")\n',
}

test('백그라운드 스크립트는 모델이 끝나지 않는다고 판정할 때만 막고, 판정은 저장해 다시 묻지 않는다', async ($, on) => {
  const asked: string[] = []
  const seen: string[] = []
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: 0 }))
  on('fs.read', ($, e) => {
    const name = e.path.split(/[\\/]/).pop() ?? ''
    return name in SCRIPTS ? { value: SCRIPTS[name] } : { deny: 'missing' }
  })
  on('model.complete', ($, e) => {
    asked.push(String(e.prompt))
    const text = String(e.prompt).includes('while True') ? 'endless' : 'wait_poll'
    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash') seen.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  const waitLoop = await $.tool.call({ tool: 'Bash', command: 'python check.py', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'python check.py', run_in_background: true })
  const endless = await $.tool.call({ tool: 'Bash', command: 'python monitor.py', run_in_background: true })
  await $.tool.call({ tool: 'Bash', command: 'python report.py', run_in_background: true })

  expect(JSON.stringify(waitLoop)).not.toContain('[j-cc] Blocked')
  expect(JSON.stringify(endless)).toContain('Blocked (forever, judged endless)')
  expect(seen).toEqual(['python check.py', 'python check.py', 'python report.py'])
  expect(asked.length).toBe(2)
})
