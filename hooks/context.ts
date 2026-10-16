// 엔진이 주입하는 목록과 도구 출력의 기본 크기를 줄인다. pi 처럼 매 요청에 실리는 텍스트를 최소로 둔다.
// 입력 형식은 Claude Code 2.1.301 의 렌더링 결과다. 형식이 바뀌면 패턴이 맞지 않아 원문이 그대로 지나간다.

const ENTRY_DESCRIPTION_CHARS = 120
const MCP_BLOCK_CHARS = 600
const DEFERRED_GROUP_MIN = 8

export const READ_DEFAULT_LIMIT = 500
export const GREP_DEFAULT_HEAD_LIMIT = 100

const ABBREVIATION_BEFORE_DOT = /\b(e\.g|i\.e|vs|etc)$/i

export function firstSentence(text: string, maxChars = ENTRY_DESCRIPTION_CHARS): string {
  const line = text.split('\n')[0].trim()
  let sentence = line
  for (const match of line.matchAll(/[.!?。](?=\s|$)/g)) {
    if (match[0] === '.' && ABBREVIATION_BEFORE_DOT.test(line.slice(0, match.index))) continue
    sentence = line.slice(0, match.index + 1)
    break
  }
  return sentence.length <= maxChars ? sentence : `${sentence.slice(0, maxChars - 1).trimEnd()}…`
}

// "- name: description" 항목을 한 줄로 줄이고, 항목에 이어지는 줄(여러 줄 설명)은 빈 줄이 나올 때까지 버린다.
// 이름만 있는 "- name" 과 별칭이 붙은 "- name (alias): ..." 도 항목이다. 머리말과, 빈 줄로 떨어진 꼬리말은 둔다.
export function shortenListing(text: string, options: { dropSuffix?: RegExp; keep?: (name: string) => boolean } = {}): string {
  const out: string[] = []
  const seen = new Set<string>()
  let inEntry = false
  for (const line of text.split('\n')) {
    const entry = /^- (.+?)(?=: | \(|$)(.*)$/.exec(line)
    if (entry) {
      inEntry = true
      const name = entry[1]
      if (seen.has(name) || (options.keep && !options.keep(name))) continue
      seen.add(name)
      const separator = entry[2].indexOf(': ')
      const label = separator === -1 ? entry[2] : entry[2].slice(0, separator)
      const description = separator === -1 ? '' : entry[2].slice(separator + 2)
      const kept = options.dropSuffix ? description.replace(options.dropSuffix, '') : description
      out.push(separator === -1 ? line : `- ${name}${label}: ${firstSentence(kept)}`)
      continue
    }
    if (inEntry && line.trim() !== '') continue
    inEntry = false
    out.push(line)
  }
  return out.join('\n')
}

// 플러그인 스킬과 claude.ai 스킬은 "<출처>:<이름>" 으로, 사용자(~/.claude/skills)·프로젝트·내장 스킬은 이름만으로 나온다.
// 디렉터리 범위 스킬("apps/web:deploy")은 앞부분에 "/" 가 있어 남긴다.
const CLAUDE_AI_PREFIX = 'anthropic-skills:'

export function skillFilter(enabledClaudeAiSkills: readonly string[]): (name: string) => boolean {
  return name => {
    if (name.startsWith(CLAUDE_AI_PREFIX)) return enabledClaudeAiSkills.includes(name.slice(CLAUDE_AI_PREFIX.length))
    return !/^[^/]+:/.test(name)
  }
}

export const shortenSkillListing = (text: string, enabledClaudeAiSkills: readonly string[] = []) =>
  shortenListing(text, { keep: skillFilter(enabledClaudeAiSkills) })

export const shortenAgentListing = (text: string) => shortenListing(text, { dropSuffix: /\s*\(Tools: [^)]*\)\s*$/ })

// 마지막 서버 블록 뒤에 엔진이 붙이는 연결 끊김 목록과 맺음말은 자르지 않는다.
const MCP_TRAILER = /\n(?=The following MCP servers have disconnected|This is ambient context)/

export function capMcpInstructions(text: string, maxChars = MCP_BLOCK_CHARS): string {
  const trailerAt = text.search(MCP_TRAILER)
  const body = trailerAt === -1 ? text : text.slice(0, trailerAt)
  const trailer = trailerAt === -1 ? '' : text.slice(trailerAt)
  const bodyEnding = /\s*$/.exec(body)?.[0] ?? ''
  return `${capMcpBlocks(body.trimEnd(), maxChars)}${bodyEnding}${trailer}`
}

function capMcpBlocks(text: string, maxChars: number): string {
  return text
    .split(/\n(?=## )/)
    .map(block => {
      if (!block.startsWith('## ') || block.length <= maxChars) return block
      const cut = block.lastIndexOf('\n', maxChars)
      return `${block.slice(0, cut > 0 ? cut : maxChars).trimEnd()}\n[j-cc: shortened; the server's tools describe the rest]`
    })
    .join('\n')
}

// 한 MCP 서버의 도구가 많으면 이름을 다 늘어놓지 않고 한 줄로 묶는다. ToolSearch 키워드 검색으로 찾을 수 있다.
// "no longer available" 처럼 다른 뜻의 섹션은 이름을 그대로 둔다. 섹션은 "The following ..." 머리말로 시작한다.
export function groupDeferredTools(text: string, minGroup = DEFERRED_GROUP_MIN): string {
  return text
    .split(/\n(?=The following )/)
    .map(section => (/^The following deferred tools are now available via ToolSearch/.test(section) ? groupSection(section, minGroup) : section))
    .join('\n')
}

function groupSection(text: string, minGroup: number): string {
  const lines = text.split('\n')
  const countByServer = new Map<string, number>()
  for (const line of lines) {
    const server = /^mcp__(.+?)__\S+$/.exec(line.trim())?.[1]
    if (server) countByServer.set(server, (countByServer.get(server) ?? 0) + 1)
  }
  const grouped = new Set([...countByServer].filter(([, count]) => count >= minGroup).map(([server]) => server))
  if (!grouped.size) return text

  const emitted = new Set<string>()
  const out: string[] = []
  for (const line of lines) {
    const server = /^mcp__(.+?)__\S+$/.exec(line.trim())?.[1]
    if (!server || !grouped.has(server)) {
      out.push(line)
      continue
    }
    if (emitted.has(server)) continue
    emitted.add(server)
    const keyword = server.split('_').pop()
    out.push(`mcp__${server}__* (${countByServer.get(server)} tools; search with ToolSearch, e.g. "+${keyword} <keyword>")`)
  }
  return out.join('\n')
}

const NON_TEXT_FILE = /\.(png|jpe?g|gif|webp|bmp|pdf|ipynb)$/i

export function shouldCapRead(input: { file_path: string; offset?: number; limit?: number; pages?: string; allow_large?: boolean }): boolean {
  if (input.offset !== undefined || input.limit !== undefined || input.pages !== undefined || input.allow_large) return false
  return !NON_TEXT_FILE.test(input.file_path)
}

export function readMoreNote(file: { startLine: number; numLines: number; totalLines: number }): string | null {
  const lastLine = file.startLine + file.numLines - 1
  if (lastLine >= file.totalLines) return null
  return `[j-cc] Showed lines ${file.startLine}-${lastLine} of ${file.totalLines}. Read the rest with offset/limit, or Grep for what you need.`
}

export const CHROME_SECTION_HEADING = '# Claude in Chrome browser automation'

export const CHROME_SECTION = `# Claude in Chrome
- Load every mcp__claude-in-chrome__* tool you need in one ToolSearch call, call tabs_context_mcp first, and work in a new tab unless the user names one.
- Never trigger alert, confirm or prompt dialogs; they block the extension.
- Record multi-step interactions the user may want to review with gif_creator.
- If browser calls fail 2-3 times or the page stops responding, stop and ask the user.`
