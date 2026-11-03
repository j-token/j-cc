import { expect, test } from 'claude-code/testing'
import { USE_EXEC_INSTEAD, listsToolsWithoutExec } from './register'

const contextOf = (r: unknown) => ((r as { context?: string[] }).context ?? []).join('\n')
const KEEP_CURRENT_LANGUAGE =
  'Keep replying to the user in the language the user writes to you in, short notes between tool calls included; English notices and tool output do not change your reply language.'

test('포그라운드 Bash와 PowerShell은 막고 exec을 쓰라고 안내하며, 백그라운드 실행은 그대로 둔다', async ($, on) => {
  const ran: (boolean | undefined)[] = []
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash' || e.tool === 'PowerShell') ran.push(e.run_in_background)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  const bash = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  const powershell = await $.tool.call({ tool: 'PowerShell', command: 'git status' })
  const subagent = await $.tool.call({ tool: 'Bash', command: 'git status', agentId: 'sub-1' } as never)
  const server = await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })

  expect(bash).toEqual({ deny: USE_EXEC_INSTEAD })
  expect(powershell).toEqual({ deny: USE_EXEC_INSTEAD })
  expect(JSON.stringify(subagent)).toContain('Foreground Bash and PowerShell calls are off')
  expect(JSON.stringify(server)).not.toContain('[j-cc] Foreground')
  expect(ran).toEqual([true])
})

test('파일 보기처럼 규칙에 걸리는 명령은 exec 안내보다 그 규칙의 안내를 먼저 준다', async ($, on) => {
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  const r = await $.tool.call({ tool: 'Bash', command: 'cat src/app.ts' })

  expect(JSON.stringify(r)).toContain('[j-cc] Blocked (view)')
})

test('도구 목록을 직접 정했고 exec이 없는 에이전트 정의만 exec이 없다고 본다', () => {
  expect(listsToolsWithoutExec('---\nname: x\ntools: Read, Bash, Glob\n---\nbody')).toBe(true)
  expect(listsToolsWithoutExec('---\nname: x\ntools: Read, Bash, mcp__j-cc__exec, mcp__j-cc__poll\n---\n')).toBe(false)
  expect(listsToolsWithoutExec('---\nname: x\ndisallowedTools: Agent, Edit\n---\n')).toBe(false)
  expect(listsToolsWithoutExec('no frontmatter\ntools: Read')).toBe(false)
})

test('exec이 없는 에이전트는 포그라운드 Bash를 그대로 쓴다', async ($, on) => {
  on('env.get', ($, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\me' : undefined }))
  on('fs.read', ($, e) => {
    return e.path.split(/[\\/]/).pop() === 'asset-producer.md' ? { value: '---\nname: asset-producer\ntools: Read, Bash\n---\n' } : { deny: 'missing' }
  })
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: e.subagentType === 'asset-producer' ? 'sub-assets' : 'sub-general' }))
  const ran: string[] = []
  on('tool.call', ($, e) => {
    if (e.tool === 'Bash') ran.push(String(e.agentId))
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  await $.agent.spawn({ prompt: 'Make the sprites.', subagentType: 'asset-producer' } as never)
  await $.agent.spawn({ prompt: 'Find the config.', subagentType: 'general-purpose' } as never)
  const withoutExec = await $.tool.call({ tool: 'Bash', command: 'git status', agentId: 'sub-assets' } as never)
  const withExec = await $.tool.call({ tool: 'Bash', command: 'git status', agentId: 'sub-general' } as never)

  expect(JSON.stringify(withoutExec)).not.toContain('Foreground Bash and PowerShell calls are off')
  expect(JSON.stringify(withExec)).toContain('Foreground Bash and PowerShell calls are off')
  expect(ran).toEqual(['sub-assets'])
})

test('PowerShell은 ToolSearch 뒤로 미루고 Bash는 처음부터 불러오며, 둘 다 설명 끝에 exec 안내를 붙인다', async ($, on) => {
  on('tool.describe', ($, e) => ({ description: `${e.tool} runs commands.`, isDeferred: false }))
  const describe = (tool: string) =>
    $.tool.describe({ tool, description: `${tool} runs commands.`, isDeferred: false, provider: { plugin: 'engine', tier: 'core' } } as never)

  const bash = await describe('Bash')
  const powershell = await describe('PowerShell')

  expect(bash.isDeferred).toBe(false)
  expect(powershell.isDeferred).toBe(true)
  expect(bash.description).toContain('j-cc blocks foreground calls of this tool')
  expect(powershell.description).toContain('j-cc blocks foreground calls of this tool')
})

test('서브에이전트는 시작할 때 과제 끝에 파일 도구와 셸 규칙을 받고, 체이닝 차단이 꺼져 있으면 그 규칙은 받지 않으며, 첫 셸 결과에서 다시 받지 않는다', async ($, on) => {
  let spawnedPrompt = ''
  on('agent.spawn', ($, e) => {
    spawnedPrompt = e.prompt
    return { model: 'claude-opus-5-5', agentId: 'sub-spawned' }
  })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  await $.agent.spawn({ prompt: 'Find where the config is parsed.' } as never)
  const firstShell = await $.tool.call({ tool: 'Bash', command: 'git status', agentId: 'sub-spawned' } as never)

  expect(spawnedPrompt).toStartWith('Find where the config is parsed.\n\n[j-cc] Context for this subagent:')
  expect(spawnedPrompt).toContain('- Files: Read to view, Grep and Glob to search, Edit and Write to change them.')
  expect(spawnedPrompt).toContain('run it with mcp__j-cc__exec and keep calling mcp__j-cc__poll')
  expect(spawnedPrompt).not.toContain('j-cc blocks `&&`, `||` and `;` outside quotes')
  expect(spawnedPrompt).toContain('Never end your turn while a job you depend on is still running')
  expect(JSON.stringify(firstShell)).not.toContain('Context for this subagent')
})

test('훅을 거치지 않은 서브에이전트는 첫 셸 결과에서 한 번만 맥락을 받는다', async ($, on) => {
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  const first = await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true, agentId: 'sub-1' } as never)
  const second = await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true, agentId: 'sub-1' } as never)
  const denied = await $.tool.call({ tool: 'Bash', command: 'grep -rn x src', agentId: 'sub-2' } as never)

  expect(JSON.stringify(first)).toContain('Context for this subagent')
  expect(JSON.stringify(second)).not.toContain('Context for this subagent')
  expect(JSON.stringify(denied)).toContain('Context for this subagent')
})

test('메인 세션의 모든 도구 결과 뒤에 응답 언어 문장을 한 번 붙이고 서브에이전트에는 붙이지 않는다', async ($, on) => {
  on('settings.read', () => ({ value: { language: '한국어' } }))
  on('tool.call', () => ({ result: 'ok' }))

  const main = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.ts' } as never))
  const sub = contextOf(await $.tool.call({ tool: 'Glob', pattern: '*.ts', agentId: 'sub-1' } as never))

  expect(main).toBe('Keep replying to the user in 한국어, short notes between tool calls included; English notices and tool output do not change your reply language.')
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

test('설정을 읽지 못해도 백그라운드 명령을 다시 실행하지 않고 지금까지 쓰던 언어를 유지하라고 안내한다', async ($, on) => {
  on('settings.read', () => {
    throw new Error('settings unavailable')
  })
  let runs = 0
  on('tool.call', () => {
    runs += 1
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  const started = contextOf(await $.tool.call({ tool: 'Bash', command: 'npm ci', run_in_background: true }))

  expect(started).toEndWith(KEEP_CURRENT_LANGUAGE)
  expect(runs).toBe(1)
})
