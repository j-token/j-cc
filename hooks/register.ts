import type { EngineInterface, Register, ToolCallResult } from 'claude-code'
import {
  LONG_SECONDS,
  TIMINGS_STORE_KEY,
  backgroundNote,
  backgroundReason,
  commandKey,
  countBackgrounded,
  rememberTiming,
  slowNote,
  type Timings,
} from './background'
import { registerExec, registerExecTools } from './exec'
import { JUDGE_REQUEST, VERDICTS_STORE_KEY, cacheKey, judgePrompt, parseLabel, rememberVerdict, scriptTargets, shouldAsk, type Evidence, type Label, type Verdicts } from './judge'
import { AUTO_BACKGROUND, BASH_FIRST_STILL_ON, CHAIN_NOTE, FILE_TOOLS, LANGUAGE_NOTE, ROUTING, SHELL_TOOL_NOTE, WORKFLOW, hasShellFirst, replyLanguageNote, rewriteShellFirst, subagentNote } from './prompt'
import { screen } from './bypass'
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

type Decision = { deny: Verdict } | { background: string; fromHistory: boolean } | null

function labelDecision(label: Label | null, background: boolean, isMain: boolean): Decision {
  const detail = `judged ${label}`
  if (label === 'endless') return { deny: { kind: 'forever', detail } }
  if (background) return null
  if (label === 'wait_poll') return { deny: { kind: 'poll', detail } }
  if (label === 'server') return isMain ? { background: 'judged a long-lived server', fromHistory: false } : { deny: { kind: 'watch', detail } }
  if (label === 'long_job' && isMain) return { background: 'judged a multi-minute job', fromHistory: false }
  return null
}

type CallFacts = { command: string; shell: Shell; background: boolean; isMain: boolean; timeoutMs: number | undefined; key: string | null; timings: Timings }

// 결정적 규칙을 통과한 명령에 대해: 백그라운드로 돌릴지, 모델 판정으로 막을지 정한다.
async function decide($: EngineInterface, facts: CallFacts, useModel: boolean): Promise<Decision> {
  // 서브에이전트는 백그라운드 결과를 받기 전에 끝날 수 있으므로 메인 루프에서만 돌린다.
  const history = facts.background || !facts.isMain ? null : backgroundReason(facts.command, facts.shell, facts.timeoutMs, facts.key, facts.timings)
  if (history) return { background: history.why, fromHistory: history.fromHistory }
  if (!useModel) return null
  const evidence = await gatherEvidence($, facts.command, facts.shell)
  if (!shouldAsk(evidence)) return null
  return labelDecision(await modelLabel($, evidence).catch(() => null), facts.background, facts.isMain)
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

// language 설정은 자유 형식이라 해석을 모델에 맡긴다. 실패가 밖으로 새면 훅의 catch 가 도구를 한 번 더 실행하므로 삼킨다.
async function driftedFrom($: EngineInterface, answer: string): Promise<string | null> {
  const language = await configuredLanguage($)
  if (typeof language !== 'string' || !language.trim()) return null
  const target = language.trim()
  const label = await $.model.classify(answer, [inLanguageLabel(target), OTHER_LANGUAGE_LABEL]).catch(() => undefined)
  return label === OTHER_LANGUAGE_LABEL ? target : null
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
    // 병렬 도구 호출 중 하나에만 경고가 붙도록 먼저 꺼내 비운다. 판정은 도구 실행과 겹쳐 돌린다.
    const suspect = suspectAnswer
    suspectAnswer = null
    const drift = suspect === null ? Promise.resolve(null) : driftedFrom($, suspect)
    const r = await next(e)
    const language = await drift
    if (language) $.ui.toast(driftToast(language))
    if (r.deny !== undefined) return language ? { deny: `${r.deny}\n\n${driftWarning(language)}` } : r
    const notes = [replyLanguageNote(await configuredLanguage($)), ...(language ? [driftWarning(language)] : [])]
    return { ...r, context: [...(r.context ?? []), ...notes] }
  }).catch(($, e, next) => next(e))

  on('prompt.attachment', async ($, e, next) => {
    const r = await next(e)
    if (!r.text || !isMidConversationNotice(e)) return r
    return { ...r, text: `${r.text}\n${replyLanguageNote(await configuredLanguage($))}` }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    if (e.tool !== 'Bash' && e.tool !== 'PowerShell') return next(e)
    const shell: Shell = e.tool === 'PowerShell' ? 'powershell' : 'bash'
    const brief = briefer(e.agentId, subagentContext)
    const background = e.run_in_background === true
    // 우회 주석이 없으면 결정적 차단은 저장소나 모델이 실패해도 그대로 동작한다.
    const screened = await screen($, e.command, shell, background, screenOptions)
    if ('deny' in screened) return brief({ deny: screened.deny })
    if (screened.bypassed) return brief(await next(e))

    const key = commandKey(e.command, shell)
    const timings = ((await $.store.get(TIMINGS_STORE_KEY)) ?? {}) as Timings
    const facts: CallFacts = {
      command: e.command,
      shell,
      background,
      isMain: e.agentId === undefined,
      timeoutMs: e.timeout,
      key,
      timings,
    }
    const decision = await decide($, facts, useModel)
    if (decision && 'deny' in decision) return brief({ deny: reason(decision.deny) })
    if (decision) {
      if (decision.fromHistory && key) await $.store.set(TIMINGS_STORE_KEY, countBackgrounded(timings, key)).catch(() => {})
      const started = await next({ ...e, run_in_background: true })
      return withNote(started, backgroundNote(decision.background))
    }
    if (facts.background) return brief(await next(e))

    // 권한 확인 대화상자를 기다린 시간도 포함되므로, 느리다고 기록해도 몇 번 뒤에는 다시 잰다(countBackgrounded).
    const startedAt = await $.clock.now()
    const r = await next(e)
    const seconds = ((await $.clock.now()) - startedAt) / 1000
    if (!key || r.deny !== undefined) return brief(r)
    const isSlow = seconds >= LONG_SECONDS
    // 이미 기록된 키는 빨라진 결과도 남겨, 예전의 느린 기록이 계속 백그라운드 전환을 일으키지 않게 한다.
    if (isSlow || timings[key] !== undefined) await $.store.set(TIMINGS_STORE_KEY, rememberTiming(timings, key, seconds)).catch(() => {})
    if (!isSlow) return brief(r)
    return brief(withNote(r, slowNote(seconds, facts.isMain)))
  }).catch(($, e, next) => next(e))

  registerExec(on, screenOptions)

  const shellNotes = screenOptions.blockChaining ? `${SHELL_TOOL_NOTE} ${CHAIN_NOTE}` : SHELL_TOOL_NOTE
  on('tool.describe', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const r = await next(e)
    return { ...r, description: `${r.description}\n\n${shellNotes}` }
  }).catch(($, e, next) => next(e))

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
        { id: 'j-cc:auto-background', text: AUTO_BACKGROUND, scope: 'session' as const },
      ],
    }
  }).catch(($, e, next) => next(e))
}
