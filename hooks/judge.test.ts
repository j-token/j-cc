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
  'serve.py': 'from http.server import HTTPServer\nHTTPServer(("", 8000), H).serve_forever()\n',
  'report.py': 'print("hi")\n',
}

test('acts on the model judge for scripts the rules cannot decide', async ($, on) => {
  const asked: string[] = []
  const seen: (boolean | undefined)[] = []
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
    const text = String(e.prompt).includes('serve_forever') ? 'server' : 'wait_poll'
    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } }
  })
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash') seen.push(e.run_in_background)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  const poll = await $.tool.call({ tool: 'Bash', command: 'python check.py' })
  expect(JSON.stringify(poll)).toContain('Blocked (poll, judged wait_poll)')
  await $.tool.call({ tool: 'Bash', command: 'python check.py' })
  expect(asked.length).toBe(1)

  const server = await $.tool.call({ tool: 'Bash', command: 'python serve.py' })
  expect(JSON.stringify(server)).toContain('judged a long-lived server')
  await $.tool.call({ tool: 'Bash', command: 'python report.py' })
  expect(asked.length).toBe(2)
  const bypassed = await $.tool.call({ tool: 'Bash', command: 'python check.py # j-cc:allow: the flag appears in a second' })
  expect(JSON.stringify(bypassed)).not.toContain('[j-cc]')
  expect(asked.length).toBe(2)
  expect(seen).toEqual([true, undefined, undefined])
})
