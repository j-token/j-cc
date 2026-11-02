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
import { JUDGE_REQUEST, VERDICTS_STORE_KEY, cacheKey, judgePrompt, parseLabel, rememberVerdict, scriptTargets, shouldAsk, type Evidence, type Label, type Verdicts } from './judge'
import { AUTO_BACKGROUND, BASH_FIRST_STILL_ON, FILE_TOOLS, SUBAGENT_NOTE, LANGUAGE_NOTE, ROUTING, SHELL_TOOL_NOTE, WORKFLOW, hasShellFirst, replyLanguageNote, rewriteShellFirst } from './prompt'
import { hasBypass, judge, reason, type Verdict } from './rules'
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

const withNote = (r: ToolCallResult, note: string): ToolCallResult =>
  r.deny === undefined && r.isError !== true ? { ...r, context: [...(r.context ?? []), note] } : r

// 서브에이전트의 시스템 프롬프트에 j-cc 섹션이 들어간다는 보장이 없어, 에이전트마다 첫 셸 결과에 한 번 맥락을 붙인다.
const briefedAgents = new Set<string>()

function briefer(agentId: string | undefined): (r: ToolCallResult) => ToolCallResult {
  return r => {
    if (agentId === undefined || briefedAgents.has(agentId)) return r
    if (r.deny !== undefined) {
      briefedAgents.add(agentId)
      return { deny: `${r.deny}\n\n${SUBAGENT_NOTE}` }
    }
    const noted = withNote(r, SUBAGENT_NOTE)
    if (noted !== r) briefedAgents.add(agentId)
    return noted
  }
}

export const register: Register = (on, options) => {
  const useModel = options.modelJudge !== false

  on('session.start', async ($, e, next) => {
    // 사용자가 직접 정한 값은 존중한다. 실험을 다시 켜 보고 싶은 사람도 있다.
    if ((await $.env.get('CLAUDE_CODE_THRIFTY_SONIC')) === undefined) await $.env.set('CLAUDE_CODE_THRIFTY_SONIC', '0')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    if (e.tool !== 'Bash' && e.tool !== 'PowerShell') return next(e)
    const shell: Shell = e.tool === 'PowerShell' ? 'powershell' : 'bash'
    const brief = briefer(e.agentId)
    if (hasBypass(e.command, shell)) return brief(await next(e))
    const background = e.run_in_background === true
    // 결정적 차단은 어떤 $ 호출보다 먼저 정한다. 저장소나 모델이 실패해도 차단은 그대로 동작한다.
    const verdict = judge(e.command, shell, background)
    if (verdict) return brief({ deny: reason(verdict) })

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
      return withNote(started, `${backgroundNote(decision.background)} ${replyLanguageNote(await configuredLanguage($))}`)
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
    return brief(withNote(r, `${slowNote(seconds, facts.isMain)} ${replyLanguageNote(await configuredLanguage($))}`))
  }).catch(($, e, next) => next(e))

  on('tool.describe', { tool: ['Bash', 'PowerShell'] }, async ($, e, next) => {
    const r = await next(e)
    return { ...r, description: `${r.description}\n\n${SHELL_TOOL_NOTE}` }
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
