import type { EngineInterface, Register, ToolCallResult } from 'claude-code'
import { EXEC_TOOL, POLL_TOOL, isReportedTaskNotice, noteActivity, registerExec, registerExecTools } from './exec'
import { JUDGE_REQUEST, VERDICTS_STORE_KEY, cacheKey, judgePrompt, parseLabel, rememberVerdict, scriptTargets, shouldAsk, type Evidence, type Label, type Verdicts } from './judge'
import { BASH_FIRST_STILL_ON, CHAIN_NOTE, FILE_TOOLS, LANGUAGE_NOTE, ROUTING, SHELL_COMMANDS, SHELL_TOOL_NOTE, WORKFLOW, hasShellFirst, replyLanguageNote, rewriteShellFirst, subagentNote } from './prompt'
import { NEEDLESS_BYPASS_NOTE, screen } from './bypass'
import { OTHER_LANGUAGE_LABEL, driftToast, driftWarning, inLanguageLabel, mayBeEnglish } from './language'
import { reason, type Verdict } from './rules'
import {
  CHROME_SECTION,
  CHROME_SECTION_HEADING,
  GREP_DEFAULT_HEAD_LIMIT,
  READ_DEFAULT_LIMIT,
  capMcpInstructions,
  groupDeferredTools,
  readMoreNote,
  shortenAgentListing,
  shortenSkillListing,
  shouldCapRead,
} from './context'
import type { Shell } from './shell'

let warnedBashFirst = false

async function gatherEvidence($: EngineInterface, command: string, shell: Shell): Promise<Evidence> {
  const sources: Evidence['sources'] = []
  for (const target of scriptTargets(command, shell)) {
    try {
      if (target.kind === 'file') sources.push({ label: target.path, code: await $.fs.read(target.path) })
      else {
        const scripts = JSON.parse(await $.fs.read('package.json')).scripts ?? {}
        if (typeof scripts[target.name] === 'string') sources.push({ label: `package.json script "${target.name}"`, code: scripts[target.name] })
      }
    } catch {}
  }
  return { command, sources }
}

async function modelLabel($: EngineInterface, evidence: Evidence): Promise<Label | null> {
  const key = cacheKey(evidence)
  const verdicts = ((await $.store.get(VERDICTS_STORE_KEY)) ?? {}) as Verdicts
  if (verdicts[key]) return verdicts[key]
  const r = await $.model.complete({ ...JUDGE_REQUEST, prompt: judgePrompt(evidence) })
  const label = r.isAnswered ? parseLabel(r.text) : null
  if (label) await $.store.set(VERDICTS_STORE_KEY, rememberVerdict(verdicts, key, label)).catch(() => {})
  return label
}

function labelVerdict(label: Label | null, background: boolean): Verdict | null {
  const detail = `judged ${label}`
  if (label === 'endless') return { kind: 'forever', detail }
  if (background) return null
  if (label === 'wait_poll') return { kind: 'poll', detail }
  if (label === 'server') return { kind: 'watch', detail }
  return null
}

// 결정적 규칙이 정하지 못한 스크립트를 모델에게 보여 주고, 끝나지 않거나 기다리기만 하는 명령이면 막는다.
async function judgeScript($: EngineInterface, command: string, shell: Shell, background: boolean, useModel: boolean): Promise<Verdict | null> {
  if (!useModel) return null
  const evidence = await gatherEvidence($, command, shell)
  if (!shouldAsk(evidence)) return null
  return labelVerdict(await modelLabel($, evidence).catch(() => null), background)
}

export const USE_EXEC_INSTEAD = `[j-cc] Foreground Bash and PowerShell calls are off: run this command with ${EXEC_TOOL} (cmd, and shell: "bash" or "powershell"). It returns within 30s with the output; a command still running then moves to the background and you are notified when it exits.`

// `tools:` 로 도구를 직접 고른 에이전트는 exec 이 없을 수 있다. 그 정의에 exec 이 없으면 셸을 막지 않는다.
const agentsWithoutExec = new Set<string>()

// $ 를 받는 함수는 엔진이 따라갈 수 있게 최상위 function 선언으로 둔다. 화살표 함수에서는 $.env 가 비어 있었다.
async function agentDefinitionDirs($: EngineInterface): Promise<string[]> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return ['.claude/agents', ...(home ? [`${home.replace(/\\/g, '/')}/.claude/agents`] : [])]
}

export function listsToolsWithoutExec(definition: string): boolean {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(definition)?.[1] ?? ''
  const tools = /^tools:\s*(.+)$/m.exec(frontmatter)?.[1]
  return tools !== undefined && !tools.includes(EXEC_TOOL) && !tools.includes('mcp__j-cc__*')
}

async function hasNoExec($: EngineInterface, subagentType: string): Promise<boolean> {
  if (subagentType.includes(':')) return false
  for (const dir of await agentDefinitionDirs($)) {
    const definition = await $.fs.read(`${dir}/${subagentType}.md`).catch(() => null)
    if (definition !== null) return listsToolsWithoutExec(definition)
  }
  return false
}

const ATTACHMENT_REWRITES = [
  ['skill_listing', shortenSkillListing],
  ['agent_listing_delta', shortenAgentListing],
  ['mcp_instructions_delta', capMcpInstructions],
  ['deferred_tools_delta', groupDeferredTools],
] as const

// 명령이 이미 실행된 뒤에 부르므로, 설정을 읽지 못해도 던지지 않는다. 던지면 훅의 catch 가 명령을 한 번 더 실행한다.
async function configuredLanguage($: EngineInterface): Promise<unknown> {
  try {
    return (await $.settings.read()).language
  } catch {
    return undefined
  }
}

// 직전 응답 중 설정 언어가 아닐 수 있어 모델에게 물어볼 텍스트. 다음 메인 루프 도구 호출이 가져간다.
let suspectAnswer: string | null = null
// 턴을 끝낸 답변 뒤에는 도구 결과가 없어, 판정한 언어를 다음 프롬프트의 맥락으로 넘긴다.
let driftAtTurnEnd: string | null = null

// language 설정은 자유 형식이라 해석을 모델에 맡긴다. 실패가 밖으로 새면 훅의 catch 가 도구를 한 번 더 실행하므로 삼킨다.
async function driftedFrom($: EngineInterface, answer: string): Promise<string | null> {
  const language = await configuredLanguage($)
  if (typeof language !== 'string' || !language.trim()) return null
  const target = language.trim()
  const label = await $.model.classify(answer, [inLanguageLabel(target), OTHER_LANGUAGE_LABEL]).catch(() => undefined)
  return label === OTHER_LANGUAGE_LABEL ? target : null
}

function toastDrift($: EngineInterface): (language: string | null) => string | null {
  return language => {
    if (language) $.ui.toast(driftToast(language))
    return language
  }
}

// 대화 맨 앞에 한 번 실리는 목록과 맥락은 사용자에게 쓰는 응답 바로 앞에 오지 않으므로 언어 문장을 붙이지 않는다.
const UPFRONT_ATTACHMENTS = new Set([
  'language',
  'skill_listing',
  'agent_listing_delta',
  'mcp_instructions_delta',
  'deferred_tools_delta',
  'deferred_tools_record',
  'nested_memory',
  'total_tokens_reminder',
])

// 사용자가 직접 보낸 프롬프트는 그 자체가 사용자의 언어다. 쉬는 중에 들어온 영어 알림·예약·다른 세션의 메시지에만 응답 언어를 다시 알린다.
const USER_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

function isMidConversationNotice(e: { type: string; origin: { kind: string } }): boolean {
  return e.origin.kind !== 'plugin' && !UPFRONT_ATTACHMENTS.has(e.type)
}

const withNote = (r: ToolCallResult, note: string): ToolCallResult =>
  r.deny === undefined && r.isError !== true ? { ...r, context: [...(r.context ?? []), note] } : r

// 서브에이전트의 시스템 프롬프트에 j-cc 섹션이 들어간다는 보장이 없어, 시작할 때 과제 끝에 맥락을 붙인다.
// 그 훅을 거치지 않은 서브에이전트(fork 등)는 첫 셸 결과에 한 번 붙인다.
const briefedAgents = new Set<string>()

function briefer(agentId: string | undefined, note: string): (r: ToolCallResult) => ToolCallResult {
  return r => {
    if (agentId === undefined || briefedAgents.has(agentId)) return r
    if (r.deny !== undefined) {
      briefedAgents.add(agentId)
      return { deny: `${r.deny}\n\n${note}` }
    }
    const noted = withNote(r, note)
    if (noted !== r) briefedAgents.add(agentId)
    return noted
  }
}

export const register: Register = (on, options) => {
  const useModel = options.modelJudge !== false
  // 체이닝은 켰을 때만 막는다. 막으면 해가 없는 `node -v; npm -v` 같은 조회도 호출 여러 번으로 쪼개진다.
  const screenOptions = { blockChaining: options.blockChaining === true, useModel }
  const subagentContext = subagentNote(screenOptions.blockChaining)

  // fork 는 부모의 맥락을 그대로 이어받으므로 건드리지 않는다.
  on('agent.spawn', async ($, e, next) => {
    if (e.fork) return next(e)
    const r = await next({ ...e, prompt: `${e.prompt}\n\n${subagentContext}` })
    if (r.agentId) briefedAgents.add(r.agentId)
    if (r.agentId && (await hasNoExec($, e.subagentType).catch(() => false))) agentsWithoutExec.add(r.agentId)
    return r
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    // 사용자가 직접 정한 값은 존중한다. 실험을 다시 켜 보고 싶은 사람도 있다.
    if ((await $.env.get('CLAUDE_CODE_THRIFTY_SONIC')) === undefined) await $.env.set('CLAUDE_CODE_THRIFTY_SONIC', '0')
    await registerExecTools($, screenOptions)
    return next(e)
  }).catch(($, e, next) => next(e))

  // 서브에이전트의 출력은 사용자보다 부모 에이전트가 읽으므로 메인 루프에만 붙인다.
  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    if (useModel && e.agentId === undefined && mayBeEnglish(r.answer)) suspectAnswer = r.answer
    return r
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (e.tool !== POLL_TOOL) noteActivity()
    // 병렬 도구 호출 중 하나에만 경고가 붙도록 먼저 꺼내 비운다. 판정은 도구 실행과 겹쳐 돌린다.
    const suspect = suspectAnswer
    suspectAnswer = null
    // 모델은 이 스텝의 도구 결과가 모두 돌아온 뒤에야 경고를 읽지만, 사용자에게는 판정이 나오는 대로 알린다.
    const drift = suspect === null ? Promise.resolve(null) : driftedFrom($, suspect).then(toastDrift($))
    const r = await next(e)
    const language = await drift
    if (r.deny !== undefined) return language ? { deny: `${r.deny}\n\n${driftWarning(language)}` } : r
    const notes = [replyLanguageNote(await configuredLanguage($)), ...(language ? [driftWarning(language)] : [])]
    return { ...r, context: [...(r.context ?? []), ...notes] }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined) return r
    suspectAnswer = null
    if (useModel && mayBeEnglish(e.answer)) driftAtTurnEnd = await driftedFrom($, e.answer).then(toastDrift($))
    return r
  }).catch(($, e, next) => next(e))

  // exec 이 이미 보고한 작업의 알림도 여기서 버린다. matcher 없는 prompt.submit 훅은 모듈에 하나만 둘 수 있다.
  on('prompt.submit', async ($, e, next) => {
    noteActivity()
    if (e.origin?.kind === 'task-notification' && isReportedTaskNotice(e.text)) return { drop: '[j-cc] duplicate notice' }
    const language = driftAtTurnEnd
    driftAtTurnEnd = null
    const notes = [
      ...(USER_ORIGINS.has(e.origin?.kind ?? '') ? [] : [replyLanguageNote(await configuredLanguage($))]),
      ...(language ? [driftWarning(language)] : []),
    ]
    return next(notes.length ? { ...e, context: [...(e.context ?? []), ...notes] } : e)
  }).catch(($, e, next) => next(e))

  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    // exec 이나 poll 이 이미 종료까지 보고한 작업의 완료 알림은 같은 내용이라 지운다. 아직 보고하지 않은 작업의 알림은 그대로 둔다.
    if (r.text && isReportedTaskNotice(r.text)) return { text: null }
    if (!r.text || !isMidConversationNotice(e)) return r
    return { ...r, text: `${r.text}\n${replyLanguageNote(await configuredLanguage($))}` }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    if (e.tool !== 'Bash' && e.tool !== 'PowerShell') return next(e)
    const shell: Shell = e.tool === 'PowerShell' ? 'powershell' : 'bash'
    const background = e.run_in_background === true
    // 우회 주석이 없으면 결정적 차단은 저장소나 모델이 실패해도 그대로 동작한다.
    const screened = await screen($, e.command, shell, background, screenOptions)
    const subagentBrief = briefer(e.agentId, subagentContext)
    const needlessBypass = 'needlessBypass' in screened && screened.needlessBypass
    const brief = (r: ToolCallResult) => subagentBrief(needlessBypass ? withNote(r, NEEDLESS_BYPASS_NOTE) : r)
    if ('deny' in screened) return brief({ deny: screened.deny })
    // 포그라운드 셸은 끝날 때까지 아무것도 돌려주지 않아, 멈춘 명령을 모델이 타임아웃까지 기다린다. exec 은 30초 안에 돌아온다.
    const hasExec = e.agentId === undefined || !agentsWithoutExec.has(e.agentId)
    if (!background && hasExec) return brief({ deny: needlessBypass ? `${USE_EXEC_INSTEAD}\n${NEEDLESS_BYPASS_NOTE}` : USE_EXEC_INSTEAD })

    const verdict = await judgeScript($, e.command, shell, background, useModel)
    if (verdict) return brief({ deny: reason(verdict) })
    return brief(await next(e))
  }).catch(($, e, next) => next(e))

  registerExec(on, screenOptions)

  const shellNotes = screenOptions.blockChaining ? `${SHELL_TOOL_NOTE} ${CHAIN_NOTE}` : SHELL_TOOL_NOTE
  // 포그라운드 셸을 막으므로 PowerShell 은 백그라운드 작업에만 쓰인다. 그 일은 Bash 로 충분해 ToolSearch 뒤로 미룬다.
  on('tool.describe', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const r = await next(e)
    return { ...r, description: `${r.description}\n\n${shellNotes}`, ...(e.tool === 'PowerShell' ? { isDeferred: true } : {}) }
  }).catch(($, e, next) => next(e))

  // 로그를 따라가야 할 때(학습, 서버) 모델은 ToolSearch 뒤에 있는 Monitor 대신 손에 있는 셸로 같은 로그를 몇십 초마다 다시 읽는다.
  on('tool.describe', { tool: 'Monitor' }, async ($, e, next) => ({ ...(await next(e)), isDeferred: false })).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (e.tool !== 'Read' || !shouldCapRead(e)) return next(e)
    const r = await next({ ...e, limit: READ_DEFAULT_LIMIT })
    if (r.deny !== undefined || r.isError === true || r.result?.type !== 'text') return r
    const note = readMoreNote(r.result.file)
    return note ? withNote(r, note) : r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Grep' }, async ($, e, next) => {
    if (String(e.tool) !== 'Grep' || (e as { head_limit?: number }).head_limit !== undefined) return next(e)
    return next({ ...e, head_limit: GREP_DEFAULT_HEAD_LIMIT })
  }).catch(($, e, next) => next(e))

  for (const [type, rewrite] of ATTACHMENT_REWRITES) {
    on('prompt.attachment', { type }, async ($, e, next) => {
      const r = await next(e)
      return r.text ? { ...r, text: rewrite(r.text) } : r
    }).catch(($, e, next) => next(e))
  }

  on('prompt.attachment', { type: 'total_tokens_reminder' }, () => ({ text: null })).catch(($, e, next) => next(e))

  on('prompt.attachment', { type: 'auto_mode' }, async ($, e, next) => {
    const r = await next(e)
    if (!r.text || !hasShellFirst(r.text)) return r
    if (!warnedBashFirst) {
      warnedBashFirst = true
      $.ui.toast(BASH_FIRST_STILL_ON)
    }
    return { ...r, text: rewriteShellFirst(r.text) }
  }).catch(($, e, next) => next(e))

  on('prompt.attachment', { type: 'language' }, async ($, e, next) => {
    const r = await next(e)
    return r.text ? { ...r, text: `${r.text}\n${LANGUAGE_NOTE}` } : r
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!FILE_TOOLS.some(t => e.tools.includes(t))) return r
    const sections = r.sections.map(s => (s.text.startsWith(CHROME_SECTION_HEADING) ? { ...s, text: CHROME_SECTION } : s))
    return {
      sections: [
        ...sections,
        { id: 'j-cc:workflow', text: WORKFLOW, scope: 'session' as const },
        { id: 'j-cc:routing', text: ROUTING, scope: 'session' as const },
        { id: 'j-cc:shell-commands', text: SHELL_COMMANDS, scope: 'session' as const },
      ],
    }
  }).catch(($, e, next) => next(e))
}
