import { expect, test } from 'claude-code/testing'
import {
  capMcpInstructions,
  firstSentence,
  groupDeferredTools,
  parseSkillNames,
  readMoreNote,
  shortenAgentListing,
  shortenSkillListing,
  shouldCapRead,
} from './context'

const SKILLS = `The following skills are available for use with the Skill tool:

- commit-rule: 커밋 규칙입니다. 한국어 메시지를 씁니다.
- claude-api: Reference for the Claude API. Covers model ids and pricing.
TRIGGER — read BEFORE opening the target file.
SKIP only when another provider is used.
- marketing:seo-audit: Run a comprehensive SEO audit.
- anthropic-skills:pdf: Use this skill whenever the user wants to do anything with PDF files.
- apps/web:deploy: Deploy the web app.
- commit-rule: 커밋 규칙입니다.`

test('스킬 목록에서 플러그인과 claude.ai 스킬, 중복, 여러 줄 설명을 뺀다', () => {
  const out = shortenSkillListing(SKILLS)

  expect(out).toBe(`The following skills are available for use with the Skill tool:

- commit-rule: 커밋 규칙입니다.
- claude-api: Reference for the Claude API.
- apps/web:deploy: Deploy the web app.`)
})

test('설정에 적은 claude.ai 스킬만 다시 보인다', () => {
  const out = shortenSkillListing(SKILLS, parseSkillNames(' pdf , docx'))

  expect(out).toContain('- anthropic-skills:pdf: Use this skill whenever the user wants to do anything with PDF files.')
  expect(out).not.toContain('marketing:seo-audit')
})

test('설정이 *이면 claude.ai 스킬을 모두 보이고, 비어 있으면 모두 숨긴다', () => {
  expect(shortenSkillListing(SKILLS, ['*'])).toContain('anthropic-skills:pdf')
  expect(shortenSkillListing(SKILLS, parseSkillNames(''))).not.toContain('anthropic-skills:pdf')
  expect(parseSkillNames(undefined)).toEqual([])
})

test('이름만 있는 스킬 줄과 별칭이 붙은 스킬 줄도 항목으로 남긴다', () => {
  const text = `The following skills are available for use with the Skill tool:

- review
- deploy (ship): Deploy the app. Then verify it.
TRIGGER when the user says ship.
- marketing:seo-audit`

  expect(shortenSkillListing(text)).toBe(`The following skills are available for use with the Skill tool:

- review
- deploy (ship): Deploy the app.`)
})

test('첫 문장은 e.g.나 etc. 같은 약어에서 끊지 않는다', () => {
  expect(firstSentence('Use it for docs, e.g. React. Then more.')).toBe('Use it for docs, e.g. React.')
  expect(firstSentence('Files, tests, etc. and more. Rest.')).toBe('Files, tests, etc. and more.')
})

test('에이전트 목록은 첫 문장만 남기고 도구 목록 꼬리를 뗀다', () => {
  const text = `Available agent types for the Agent tool:
- explorer: Read-only Claude Haiku searcher. Returns verified file:line locations only. (Tools: All tools except Agent, Edit)
- claude: Catch-all for any task. (Tools: *)

When you launch multiple agents, send them in one message.`

  expect(shortenAgentListing(text)).toBe(`Available agent types for the Agent tool:
- explorer: Read-only Claude Haiku searcher.
- claude: Catch-all for any task.

When you launch multiple agents, send them in one message.`)
})

test('첫 문장이 길면 120자에서 자른다', () => {
  const out = firstSentence('a'.repeat(200))

  expect(out.length).toBe(120)
  expect(out.endsWith('…')).toBe(true)
})

test('MCP 안내문은 서버마다 줄 단위로 잘라 길이를 제한한다', () => {
  const longBody = Array.from({ length: 40 }, (_, i) => `line ${i} of the figma instructions`).join('\n')
  const text = `# MCP Server Instructions\n\n## context7\nUse it for docs.\n\n## figma\n${longBody}`

  const out = capMcpInstructions(text, 200)

  expect(out).toContain('## context7\nUse it for docs.')
  expect(out).toContain("[j-cc: shortened; the server's tools describe the rest]")
  expect(out).not.toContain('line 39')
})

test('MCP 안내문을 잘라도 연결 끊김 목록과 맺음말은 남긴다', () => {
  const longBody = Array.from({ length: 40 }, (_, i) => `line ${i} of the figma instructions`).join('\n')
  const trailer = '\n\nThe following MCP servers have disconnected. Their instructions above no longer apply:\nslack\n\nThis is ambient context — do not narrate it.'
  const text = `# MCP Server Instructions\n\n## figma\n${longBody}${trailer}`

  const out = capMcpInstructions(text, 200)

  expect(out.endsWith(trailer)).toBe(true)
  expect(out).not.toContain('line 39')
})

test('더는 쓸 수 없는 지연 도구 섹션은 묶지 않는다', () => {
  const figma = Array.from({ length: 9 }, (_, i) => `mcp__plugin_marketing_figma__tool_${i}`)
  const text = ['The following deferred tools are no longer available. Do not search for them:', ...figma].join('\n')

  expect(groupDeferredTools(text)).toBe(text)
})

test('한 서버의 지연 도구가 8개 이상이면 한 줄로 묶는다', () => {
  const figma = Array.from({ length: 9 }, (_, i) => `mcp__plugin_marketing_figma__tool_${i}`)
  const text = ['The following deferred tools are now available via ToolSearch:', 'WebFetch', ...figma, 'mcp__grep__searchGitHub'].join('\n')

  const out = groupDeferredTools(text)

  expect(out).toBe(
    [
      'The following deferred tools are now available via ToolSearch:',
      'WebFetch',
      'mcp__plugin_marketing_figma__* (9 tools; search with ToolSearch, e.g. "+figma <keyword>")',
      'mcp__grep__searchGitHub',
    ].join('\n'),
  )
})

test('Read는 범위를 직접 준 호출과 이미지, PDF에는 기본 한도를 걸지 않는다', () => {
  expect(shouldCapRead({ file_path: 'C:/a/app.ts' })).toBe(true)
  expect(shouldCapRead({ file_path: 'C:/a/app.ts', limit: 50 })).toBe(false)
  expect(shouldCapRead({ file_path: 'C:/a/app.ts', offset: 10 })).toBe(false)
  expect(shouldCapRead({ file_path: 'C:/a/shot.png' })).toBe(false)
  expect(shouldCapRead({ file_path: 'C:/a/doc.pdf' })).toBe(false)
})

test('파일이 더 남았을 때만 이어 읽기 안내를 붙인다', () => {
  expect(readMoreNote({ startLine: 1, numLines: 500, totalLines: 1200 })).toBe(
    '[j-cc] Showed lines 1-500 of 1200. Read the rest with offset/limit, or Grep for what you need.',
  )
  expect(readMoreNote({ startLine: 1, numLines: 80, totalLines: 80 })).toBe(null)
})

test('Read 호출에 기본 한도 500줄을 걸고 남은 줄 수를 알린다', async ($, on) => {
  const seenLimits: unknown[] = []
  on('tool.call', ($, e) => {
    seenLimits.push((e as { limit?: number }).limit)
    return { result: { type: 'text', file: { filePath: 'C:/a/big.ts', content: 'x', numLines: 500, startLine: 1, totalLines: 900 } } }
  })

  const r = await $.tool.call({ tool: 'Read', file_path: 'C:/a/big.ts' })

  expect(seenLimits).toEqual([500])
  expect(JSON.stringify(r)).toContain('Showed lines 1-500 of 900')
})

test('Grep 호출에 head_limit이 없으면 100을 건다', async ($, on) => {
  const seenLimits: unknown[] = []
  on('tool.call', ($, e) => {
    seenLimits.push((e as { head_limit?: number }).head_limit)
    return { result: { mode: 'files_with_matches', filenames: [], numFiles: 0 } }
  })

  await $.tool.call({ tool: 'Grep', pattern: 'TODO' })
  await $.tool.call({ tool: 'Grep', pattern: 'TODO', head_limit: 20 })

  expect(seenLimits).toEqual([100, 20])
})

test('남은 토큰 안내는 모델에게 보내지 않는다', async ($, on) => {
  on('prompt.attachment', () => ({ text: '<total_tokens>1000 tokens left</total_tokens>' }))

  const r = await $.prompt.attachment({ type: 'total_tokens_reminder', text: '<total_tokens>1000 tokens left</total_tokens>', origin: { kind: 'engine' } })

  expect(r.text).toBe(null)
})

test('시스템 프롬프트의 Chrome 안내 섹션을 짧은 버전으로 바꾸고 다른 섹션은 둔다', async ($, on) => {
  on('prompt.compose', () => ({
    sections: [
      { id: 'intro', text: 'You are Claude Code.', scope: 'shared' },
      { id: 'chrome', text: '# Claude in Chrome browser automation\n\nVery long guidance...', scope: 'session' },
    ],
  }))

  const { sections } = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: ['Read', 'Edit', 'Bash'],
    outputStyle: null,
    traits: [],
  })

  expect(sections[0].text).toBe('You are Claude Code.')
  expect(sections[1].text.startsWith('# Claude in Chrome\n')).toBe(true)
  expect(sections[1].text).not.toContain('Very long guidance')
})

test('스킬 목록 첨부를 줄여서 보낸다', async ($, on) => {
  on('prompt.attachment', ($, e) => ({ text: e.text }))

  const r = await $.prompt.attachment({ type: 'skill_listing', text: SKILLS, origin: { kind: 'engine' } })

  expect(r.text).not.toContain('marketing:seo-audit')
  expect(r.text).toContain('- commit-rule: 커밋 규칙입니다.')
})
