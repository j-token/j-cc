import type { EngineInterface } from 'claude-code'
import { fnv1a } from './common'
import { BYPASS_REQUEST, BYPASS_STORE_KEY, bypassPrompt, parseBypassReview, rememberBypassReview, type BypassReview, type BypassReviews } from './judge'
import { bypassReason, bypassRejected, guidance, reason, ruleVerdict, type JudgeOptions, type Verdict } from './rules'
import type { Shell } from './shell'

export type ScreenOptions = JudgeOptions & { useModel: boolean }
// `needlessBypass`: 막을 규칙이 없는 명령에 우회 주석이 붙었다. 주석은 아무것도 풀지 않는다.
export type Screened = { deny: string; verdict: Verdict } | { needlessBypass: boolean }

export const NEEDLESS_BYPASS_NOTE =
  '[j-cc] The `# j-cc:allow:` comment on this command was not needed: no rule blocks it, and the comment does not allow foreground Bash. Leave it off.'

async function reviewBypass($: EngineInterface, command: string, verdict: Verdict, statedReason: string): Promise<BypassReview | null> {
  const key = fnv1a(`${verdict.kind}\u0000${command.trim()}`)
  const reviews = ((await $.store.get(BYPASS_STORE_KEY)) ?? {}) as BypassReviews
  if (reviews[key]) return reviews[key]
  const r = await $.model.complete({ ...BYPASS_REQUEST, prompt: bypassPrompt(command, guidance(verdict), statedReason) })
  const review = r.isAnswered ? parseBypassReview(r.text) : null
  if (review) await $.store.set(BYPASS_STORE_KEY, rememberBypassReview(reviews, key, review)).catch(() => {})
  return review
}

// 우회 주석은 그 명령을 막은 규칙 하나만 푼다. 백그라운드 전환과 모델 판정은 주석과 상관없이 그대로 돈다.
// 주석 하나로 모든 검사를 건너뛸 수 있으면, 모델은 대기 루프를 스크립트에 넣고 주석을 붙여 포그라운드에서 돌린다.
// 모델을 끄거나 모델이 답하지 못하면 예전처럼 주석을 믿는다. j-cc 는 보안 경계가 아니라 작업 흐름 도구다.
export async function screen($: EngineInterface, command: string, shell: Shell, background: boolean, options: ScreenOptions): Promise<Screened> {
  const verdict = ruleVerdict(command, shell, background, options)
  const statedReason = bypassReason(command, shell)
  if (statedReason === null) return verdict ? { deny: reason(verdict), verdict } : { needlessBypass: false }
  if (!verdict) return { needlessBypass: true }
  if (!options.useModel) return { needlessBypass: false }
  const review = await reviewBypass($, command, verdict, statedReason).catch(() => null)
  if (review && !review.allow) return { deny: bypassRejected(verdict, statedReason, review.advice), verdict }
  return { needlessBypass: false }
}
