import { expect, test } from 'claude-code/testing'
import { withDenyRules, withoutDenyRules } from './tools'

const ENGINE = { plugin: 'engine', tier: 'core' } as const

type On = Parameters<Parameters<typeof test>[1]>[1]

const answerAsEngine = (on: On) =>
  on('tool.describe', ($, e) => (e.isDeferred ? { description: e.description, isDeferred: true } : { description: e.description }))

test('지연돼 있던 Monitor를 처음부터 싣는다', async ($, on) => {
  answerAsEngine(on)

  const r = await $.tool.describe({ tool: 'Monitor', description: 'Watch a stream.', isDeferred: true, provider: ENGINE })

  expect(r.isDeferred).toBe(false)
})

test('처음부터 실리던 Artifact를 ToolSearch 뒤로 보낸다', async ($, on) => {
  answerAsEngine(on)

  const r = await $.tool.describe({ tool: 'Artifact', description: 'Publish a page.', provider: ENGINE })

  expect(r.isDeferred).toBe(true)
})

test('Bash 설명을 짧은 설명과 파일 도구 안내로 바꾼다', async ($, on) => {
  answerAsEngine(on)

  const r = await $.tool.describe({ tool: 'Bash', description: 'This tool runs Git Bash (POSIX sh). A very long engine description.', provider: ENGINE })

  expect(r.description.startsWith('Run a command in Git Bash')).toBe(true)
  expect(r.description).toContain('use Read, Grep, Glob, Edit and Write')
  expect(r.description).not.toContain('A very long engine description.')
})

test('원래 설명에 Git Bash가 없으면 Windows 전용 문법 안내를 넣지 않는다', async ($, on) => {
  answerAsEngine(on)

  const r = await $.tool.describe({ tool: 'Bash', description: 'Executes a bash command.', provider: ENGINE })

  expect(r.description.startsWith('Run a bash command')).toBe(true)
  expect(r.description).not.toContain('/dev/null not NUL')
})

test('PowerShell 판은 원래 설명에서 가져온다', async ($, on) => {
  answerAsEngine(on)

  const r = await $.tool.describe({ tool: 'PowerShell', description: 'Runs PowerShell.\n\nPowerShell edition: Windows PowerShell 5.1 (powershell.exe)\n   - No && operator.\n   - No ?: operator.\n\nOther notes.', provider: ENGINE })

  expect(r.description).toContain('PowerShell edition: Windows PowerShell 5.1 (powershell.exe)\n   - No && operator.\n   - No ?: operator.\n')
  expect(r.description).not.toContain('Other notes.')
})

test('샌드박스 안내가 있는 셸 설명은 줄이지 않는다', async ($, on) => {
  answerAsEngine(on)
  const original = 'Runs Git Bash. By default, Bash tool commands run in a sandbox. Do NOT attempt to set `dangerouslyDisableSandbox: true` unless asked.'

  const r = await $.tool.describe({ tool: 'Bash', description: original, provider: ENGINE })

  expect(r.description).toBe(original)
})

test('셸 설명에 커밋 서명 줄과 gh 안내를 남긴다', async ($, on) => {
  answerAsEngine(on)

  const r = await $.tool.describe({ tool: 'Bash', description: 'long', provider: ENGINE })

  expect(r.description).toContain('attribution lines')
  expect(r.description).toContain('gh CLI')
})

test('셸 설명에 git 안전 규칙과 입력 대기 금지 규칙을 남긴다', async ($, on) => {
  answerAsEngine(on)

  const bash = await $.tool.describe({ tool: 'Bash', description: 'long', provider: ENGINE })
  const powershell = await $.tool.describe({ tool: 'PowerShell', description: 'long', provider: ENGINE })

  expect(bash.description).toContain('commit or push only when the user asks')
  expect(powershell.description).toContain('commit or push only when the user asks')
  expect(powershell.description).toContain('no Read-Host')
  expect(powershell.description).toContain('-Confirm:$false')
})

test('짧은 설명이 없는 검색 로딩 도구는 원래 설명을 둔다', async ($, on) => {
  answerAsEngine(on)

  const r = await $.tool.describe({ tool: 'WebFetch', description: 'Fetch a URL.', isDeferred: true, provider: ENGINE })

  expect(r.description).toBe('Fetch a URL.')
  expect(r.isDeferred).toBe(true)
})

test('apply는 기존 deny 규칙을 두고 없는 도구만 뒤에 붙인다', () => {
  const settings = { model: 'opus', permissions: { allow: ['Read'], deny: ['Bash(rm *)', 'Poll'] } }

  const { settings: next, changed } = withDenyRules(settings, ['Poll', 'TodoWrite'])

  expect(changed).toEqual(['TodoWrite'])
  expect(next).toEqual({ model: 'opus', permissions: { allow: ['Read'], deny: ['Bash(rm *)', 'Poll', 'TodoWrite'] } })
})

test('apply는 이미 다 들어 있으면 아무것도 바꾸지 않는다', () => {
  const settings = { permissions: { deny: ['Poll'] } }

  const { settings: next, changed } = withDenyRules(settings, ['Poll'])

  expect(changed).toEqual([])
  expect(next).toBe(settings)
})

test('revert는 j-cc가 넣은 도구만 빼고 다른 규칙은 남긴다', () => {
  const settings = { permissions: { deny: ['Bash(rm *)', 'Poll', 'TodoWrite'], defaultMode: 'auto' } }

  const { settings: next, changed } = withoutDenyRules(settings, ['Poll', 'TodoWrite'])

  expect(changed).toEqual(['Poll', 'TodoWrite'])
  expect(next).toEqual({ permissions: { deny: ['Bash(rm *)'], defaultMode: 'auto' } })
})

test('revert로 deny가 비면 deny 키를 지운다', () => {
  const settings = { permissions: { deny: ['Poll'], defaultMode: 'auto' } }

  const { settings: next } = withoutDenyRules(settings, ['Poll'])

  expect(next).toEqual({ permissions: { defaultMode: 'auto' } })
})

test('/j-cc-tools apply가 사용자 settings.json의 deny에 도구를 넣는다', async ($, on) => {
  const settingsPath = 'C:\\Users\\me\\.claude\\settings.json'
  const files = new Map<string, string>([[settingsPath, '{\n  "model": "opus"\n}\n']])
  on('env.get', () => ({ value: 'C:\\Users\\me\\.claude' }))
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => ({ value: files.get(e.path) ?? '' }))
  on('fs.write', ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })

  const { text } = await $.command.run({ command: 'j-cc-tools', args: 'apply', origin: { kind: 'composer' } })

  const written = JSON.parse(files.get(settingsPath) ?? '{}')
  expect(text).toContain('Added to permissions.deny')
  expect(written.model).toBe('opus')
  expect(written.permissions.deny).toContain('EnterPlanMode')
  expect(written.permissions.deny).not.toContain('ExitPlanMode')
  expect(written.permissions.deny.length).toBe(33)
})

test('settings.json이 없으면 새로 만든다', async ($, on) => {
  const written = new Map<string, string>()
  on('env.get', () => ({ value: 'C:\\Users\\me\\.claude' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', ($, e) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })

  await $.command.run({ command: 'j-cc-tools', args: 'apply', origin: { kind: 'composer' } })

  expect(JSON.parse(written.get('C:\\Users\\me\\.claude\\settings.json') ?? '{}').permissions.deny.length).toBe(33)
})

test('settings.json을 읽지 못하면 덮어쓰지 않고 실패를 알린다', async ($, on) => {
  const written: string[] = []
  on('env.get', () => ({ value: 'C:\\Users\\me\\.claude' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => {
    throw new Error('file is locked')
  })
  on('fs.write', ($, e) => {
    written.push(e.path)
    return { value: undefined }
  })

  const { text } = await $.command.run({ command: 'j-cc-tools', args: 'apply', origin: { kind: 'composer' } })

  expect(written).toEqual([])
  expect(text).toContain('failed')
})

test('다른 플러그인이 실행한 /j-cc-tools는 settings.json을 건드리지 않는다', async ($, on) => {
  const written: string[] = []
  on('fs.write', ($, e) => {
    written.push(e.path)
    return { value: undefined }
  })

  const { text } = await $.command.run({ command: 'j-cc-tools', args: 'apply', origin: { kind: 'plugin', name: 'other' } })

  expect(written).toEqual([])
  expect(text).toContain('only when you type it')
})

test('배치에 없는 도구는 엔진의 배치와 설명을 그대로 둔다', async ($, on) => {
  answerAsEngine(on)

  const r = await $.tool.describe({ tool: 'mcp__grep_app__searchGitHub', description: 'Search GitHub.', isDeferred: true, provider: { plugin: 'mcp:grep_app', tier: 'user' } })

  expect(r.isDeferred).toBe(true)
  expect(r.description).toBe('Search GitHub.')
})
