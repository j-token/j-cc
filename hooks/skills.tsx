import type { EngineInterface, Register } from 'claude-code'
import { firstSentence } from './context'

// claude.ai 에서 동기화된 스킬은 목록에 "anthropic-skills:<이름>" 으로 나온다.
// 비활성화: 모델 목록에서 빼고 모델과 사용자 호출을 모두 막는다. 유저 호출: 목록에서 빼고 모델 호출만 막는다. 활성화: 목록에 둔다.
export type SkillMode = 'disabled' | 'user' | 'enabled'
export type SkillModes = Record<string, SkillMode>
export type SkillCatalog = { name: string; description: string; hasPlainTwin?: true }[]

export const SKILL_MODES_STORE_KEY = 'claudeAiSkillModes'
export const SKILL_CATALOG_STORE_KEY = 'claudeAiSkillCatalog'
export const SKILLS_COMMAND = 'j-cc-skills'
const PANE = 'j-cc-skills'

export const SKILL_MODE_OPTIONS = [
  { value: 'disabled', label: '비활성화' },
  { value: 'user', label: '유저 호출' },
  { value: 'enabled', label: '활성화' },
] as const

const CLAUDE_AI_PREFIX = /^(?:anthropic-skills|claude-ai):/

export const prefixedClaudeAiSkill = (skillOrCommand: string): string | null => {
  const name = skillOrCommand.trim().replace(/^\//, '')
  return CLAUDE_AI_PREFIX.test(name) ? name.replace(CLAUDE_AI_PREFIX, '') : null
}

// 엔진은 이름이 겹치지 않는 claude.ai 스킬을 접두사 없는 이름("pdf")으로도 찾는다. 같은 이름의 다른 스킬이 있으면 그쪽이 불린다.
export function claudeAiSkillName(skillOrCommand: string, catalog: SkillCatalog): string | null {
  const prefixed = prefixedClaudeAiSkill(skillOrCommand)
  if (prefixed) return prefixed
  const plain = skillOrCommand.trim().replace(/^\//, '')
  return catalog.some(skill => skill.name === plain && !skill.hasPlainTwin) ? plain : null
}

export const modeOf = (modes: SkillModes, name: string): SkillMode => modes[name] ?? 'disabled'

export const enabledSkills = (modes: SkillModes): string[] => Object.keys(modes).filter(name => modes[name] === 'enabled')

export function claudeAiSkillsIn(listing: string): SkillCatalog {
  const lines = listing.split('\n')
  const plainNames = new Set(lines.map(line => /^- ([^\s:(]+)/.exec(line)?.[1]).filter(name => name && !name.includes(':')))
  const catalog: SkillCatalog = []
  for (const line of lines) {
    const entry = /^- anthropic-skills:([^\s:(]+)[^:]*?(?:: (.*))?$/.exec(line)
    if (!entry || catalog.some(skill => skill.name === entry[1])) continue
    const skill = { name: entry[1], description: firstSentence(entry[2] ?? '') }
    catalog.push(plainNames.has(entry[1]) ? { ...skill, hasPlainTwin: true } : skill)
  }
  return catalog
}

// 첫 목록 뒤로는 새로 생긴 스킬만 실려 오므로, 기억한 목록에 합친다.
export function mergeCatalog(known: SkillCatalog, seen: SkillCatalog): SkillCatalog {
  const merged = known.map(skill => seen.find(next => next.name === skill.name) ?? skill)
  return [...merged, ...seen.filter(next => !known.some(skill => skill.name === next.name))]
}

// $ 를 받는 함수는 엔진이 import 너머로 따라갈 수 있게 function 선언으로 둔다.
async function readModes($: EngineInterface): Promise<SkillModes> {
  return ((await $.store.get(SKILL_MODES_STORE_KEY)) ?? {}) as SkillModes
}

async function readCatalog($: EngineInterface): Promise<SkillCatalog> {
  return ((await $.store.get(SKILL_CATALOG_STORE_KEY)) ?? []) as SkillCatalog
}

export async function rememberCatalog($: EngineInterface, listing: string): Promise<void> {
  const seen = claudeAiSkillsIn(listing)
  if (!seen.length) return
  const known = await readCatalog($)
  const merged = mergeCatalog(known, seen)
  if (JSON.stringify(merged) !== JSON.stringify(known)) await $.store.set(SKILL_CATALOG_STORE_KEY, merged)
}

export async function enabledClaudeAiSkills($: EngineInterface): Promise<string[]> {
  return enabledSkills(await readModes($))
}

type On = Parameters<Register>[0]

// 스킬 목록은 세션 첫 요청에 한 번 실려, 목록 변경은 다음 세션(또는 /clear) 부터 반영된다. 호출 차단은 바로 반영된다.
export function registerSkills(on: On): void {
  on('command.run', { command: SKILLS_COMMAND }, async $ => {
    if (!(await readCatalog($)).length) return { text: 'j-cc: no claude.ai skills seen yet. Send a message first so j-cc can read the skill list, then run this again.' }
    await $.ui.open({ id: PANE, title: 'claude.ai skills', focus: true, closeOnEscape: true })
    return { text: 'j-cc: pick a mode per skill. List changes apply from the next session; call blocking applies now.' }
  }).catch(($, e, next) => next(e))

  // 사용자 명령의 e.command 는 엔진이 별칭을 푼 정식 이름("anthropic-skills:pdf")이다.
  // 저장소를 읽지 못하면 기본값(비활성화)대로 막는다. 이미 실행으로 넘어간 뒤의 실패는 그대로 둔다.
  on('command.run', async ($, e, next) => {
    const name = prefixedClaudeAiSkill(e.command)
    if (!name || modeOf(await readModes($), name) !== 'disabled') return next(e)
    return { text: `j-cc: ${name} is disabled. Change it with /${SKILLS_COMMAND}.` }
  }).catch(($, e, next) => {
    const name = prefixedClaudeAiSkill(e.command)
    return next.called || !name ? next(e) : { text: `j-cc: could not read the mode of ${name}, so it stays disabled.` }
  })

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const skill = String((e as { skill?: unknown }).skill ?? '')
    const name = claudeAiSkillName(skill, await readCatalog($))
    if (!name || modeOf(await readModes($), name) === 'enabled') return next(e)
    return { deny: `The ${name} skill is not available to the model. The user can enable it with /${SKILLS_COMMAND}.` }
  }).catch(($, e, next) => {
    const name = prefixedClaudeAiSkill(String((e as { skill?: unknown }).skill ?? ''))
    return next.called || !name ? next(e) : { deny: `j-cc could not read the mode of the ${name} skill, so it stays unavailable.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Select } = $.ui.resolve(e)
    const [catalog, modes] = await Promise.all([readCatalog($), readModes($)])
    const choose = (name: string) => async (value: string) => {
      await $.store.set(SKILL_MODES_STORE_KEY, { ...(await readModes($)), [name]: value as SkillMode })
      $.ui.invalidate('ui.render')
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>비활성화: 숨기고 호출 차단 · 유저 호출: 숨기고 /명령으로만 · 활성화: 모델 목록에 표시</Text>
        {catalog.map((skill, i) => (
          <Box key={`${skill.name}-row`} flexDirection="column">
            <Select
              key={skill.name}
              label={skill.name}
              options={SKILL_MODE_OPTIONS}
              value={modeOf(modes, skill.name)}
              autoFocus={i === 0 ? true : undefined}
              onSelect={choose(skill.name)}
            />
            {skill.description && <Text dimColor>  {skill.description}</Text>}
          </Box>
        ))}
      </Box>
    )
  }).catch(($, e, next) => next(e))
}
