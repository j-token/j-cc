import { expect, test } from 'claude-code/testing'
import { SKILL_CATALOG_STORE_KEY, SKILL_MODES_STORE_KEY, claudeAiSkillName, claudeAiSkillsIn, enabledSkills, mergeCatalog, modeOf } from './skills'

const LISTING = `The following skills are available for use with the Skill tool:

- commit-rule: 커밋 규칙입니다.
- anthropic-skills:pdf: Use this skill for PDF files. It reads and writes them.
- anthropic-skills:docx
- anthropic-skills:pdf: duplicate.`

test('목록에서 claude.ai 스킬 이름과 첫 문장만 모은다', () => {
  expect(claudeAiSkillsIn(LISTING)).toEqual([
    { name: 'pdf', description: 'Use this skill for PDF files.' },
    { name: 'docx', description: '' },
  ])
})

test('정하지 않은 스킬은 비활성화로 본다', () => {
  expect(modeOf({ pdf: 'enabled' }, 'docx')).toBe('disabled')
  expect(enabledSkills({ pdf: 'enabled', docx: 'user', xlsx: 'disabled' })).toEqual(['pdf'])
})

test('Skill 입력에서 접두사나 별칭으로 부른 claude.ai 스킬 이름을 꺼낸다', () => {
  const catalog = claudeAiSkillsIn(LISTING)

  expect(claudeAiSkillName('anthropic-skills:pdf', catalog)).toBe('pdf')
  expect(claudeAiSkillName('/claude-ai:pdf', catalog)).toBe('pdf')
  expect(claudeAiSkillName('pdf', catalog)).toBe('pdf')
  expect(claudeAiSkillName('commit-rule', catalog)).toBe(null)
})

test('같은 이름의 다른 스킬이 있으면 접두사 없는 이름은 그 스킬로 본다', () => {
  const catalog = claudeAiSkillsIn('- pdf: My own pdf skill.\n- anthropic-skills:pdf: claude.ai pdf.')

  expect(claudeAiSkillName('pdf', catalog)).toBe(null)
  expect(claudeAiSkillName('anthropic-skills:pdf', catalog)).toBe('pdf')
})

test('나중에 새 스킬만 실려 오면 기억한 목록에 합친다', () => {
  const known = [{ name: 'pdf', description: 'old.' }, { name: 'docx', description: '' }]

  expect(mergeCatalog(known, [{ name: 'pdf', description: 'new.' }, { name: 'xlsx', description: '' }])).toEqual([
    { name: 'pdf', description: 'new.' },
    { name: 'docx', description: '' },
    { name: 'xlsx', description: '' },
  ])
})

type On = Parameters<Parameters<typeof test>[1]>[1]

const storeWith = (on: On, modes: Record<string, string>) =>
  on('store.get', ($, e) => ({ value: e.key === SKILL_MODES_STORE_KEY ? modes : e.key === SKILL_CATALOG_STORE_KEY ? claudeAiSkillsIn(LISTING) : undefined }))

test('활성화하지 않은 claude.ai 스킬은 모델이 Skill로 부를 수 없다', async ($, on) => {
  storeWith(on, { pdf: 'user', docx: 'enabled' })
  const ran: string[] = []
  on('tool.call', ($, e) => {
    ran.push(String((e as { skill?: string }).skill))
    return { result: { success: true } }
  })

  const blocked = await $.tool.call({ tool: 'Skill', skill: 'anthropic-skills:pdf' })
  const blockedByAlias = await $.tool.call({ tool: 'Skill', skill: 'pdf' })
  await $.tool.call({ tool: 'Skill', skill: 'anthropic-skills:docx' })
  await $.tool.call({ tool: 'Skill', skill: 'commit-rule' })

  expect(blocked.deny).toContain('not available to the model')
  expect(blockedByAlias.deny).toContain('not available to the model')
  expect(ran).toEqual(['anthropic-skills:docx', 'commit-rule'])
})

test('저장소를 읽지 못하면 claude.ai 스킬 호출을 막고 다른 스킬은 둔다', async ($, on) => {
  on('store.get', () => {
    throw new Error('store is down')
  })
  const ran: string[] = []
  on('tool.call', ($, e) => {
    ran.push(String((e as { skill?: string }).skill))
    return { result: { success: true } }
  })
  on('command.run', () => ({ text: 'ran' }))

  const blocked = await $.tool.call({ tool: 'Skill', skill: 'anthropic-skills:pdf' })
  await $.tool.call({ tool: 'Skill', skill: 'commit-rule' })
  const command = await $.command.run({ command: 'anthropic-skills:pdf', args: '', origin: { kind: 'composer' } })

  expect(blocked.deny).toContain('stays unavailable')
  expect(ran).toEqual(['commit-rule'])
  expect(command.text).toContain('stays disabled')
})

test('비활성화한 스킬은 사용자의 슬래시 명령도 막고, 유저 호출 스킬은 둔다', async ($, on) => {
  storeWith(on, { docx: 'user' })
  on('command.run', () => ({ text: 'ran' }))

  const disabled = await $.command.run({ command: 'anthropic-skills:pdf', args: '', origin: { kind: 'composer' } })
  const userOnly = await $.command.run({ command: 'anthropic-skills:docx', args: '', origin: { kind: 'composer' } })

  expect(disabled.text).toContain('pdf is disabled')
  expect(userOnly.text).toBe('ran')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: 스킬 설정 창에서 고른 모드를 저장한다`, async ($, on) => {
    const stored = new Map<string, unknown>([['claudeAiSkillCatalog', claudeAiSkillsIn(LISTING)]])
    on('store.get', ($, e) => ({ value: stored.get(e.key) }))
    on('store.set', ($, e) => {
      stored.set(e.key, e.value)
      return { value: undefined }
    })
    on('ui.render', ($, e, next) => next(e))

    const ui = await $.ui.mount({ plugin: 'j-cc', surface, component: 'Pane', requestId: 'j-cc-skills', props: { title: 'claude.ai skills' } as never })
    await ui.select({ key: 'docx', value: 'user' })

    expect(stored.get(SKILL_MODES_STORE_KEY)).toEqual({ docx: 'user' })
    expect(await ui.find({ key: 'pdf' })).toBeDefined()
  })
}

test('스킬 목록 첨부에서 활성화한 claude.ai 스킬만 남기고 목록을 기억한다', async ($, on) => {
  const stored = new Map<string, unknown>([[SKILL_MODES_STORE_KEY, { pdf: 'enabled' }]])
  on('store.get', ($, e) => ({ value: stored.get(e.key) }))
  on('store.set', ($, e) => {
    stored.set(e.key, e.value)
    return { value: undefined }
  })
  on('prompt.attachment', ($, e) => ({ text: e.text }))

  const r = await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } })

  expect(r.text).toContain('anthropic-skills:pdf')
  expect(r.text).not.toContain('anthropic-skills:docx')
  expect(stored.get('claudeAiSkillCatalog')).toEqual(claudeAiSkillsIn(LISTING))
})
