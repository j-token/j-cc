import type { EngineInterface } from 'claude-code'
import { fnv1a } from './common'
import { BYPASS_REQUEST, BYPASS_STORE_KEY, bypassPrompt, parseBypassReview, rememberBypassReview, type BypassReview, type BypassReviews } from './judge'
import { bypassReason, bypassRejected, guidance, reason, ruleVerdict, type JudgeOptions, type Verdict } from './rules'
import type { Shell } from './shell'

export type ScreenOptions = JudgeOptions & { useModel: boolean }
export type Screened = { deny: string } | { bypassed: boolean }

async function reviewBypass($: EngineInterface, command: string, verdict: Verdict, statedReason: string): Promise<BypassReview | null> {
  const key = fnv1a(`${verdict.kind}\u0000${command.trim()}`)
  const reviews = ((await $.store.get(BYPASS_STORE_KEY)) ?? {}) as BypassReviews
  if (reviews[key]) return reviews[key]
  const r = await $.model.complete({ ...BYPASS_REQUEST, prompt: bypassPrompt(command, guidance(verdict), statedReason) })
  const review = r.isAnswered ? parseBypassReview(r.text) : null
  if (review) await $.store.set(BYPASS_STORE_KEY, rememberBypassReview(reviews, key, review)).catch(() => {})
  return review
}

// 우회 주석은 규칙에 막힐 명령일 때만 모델이 이유를 검토한다. 막힐 규칙이 없으면(포그라운드 유지 등) 그대로 통과한다.
// 모델을 끄거나 모델이 답하지 못하면 예전처럼 주석을 믿는다. j-cc 는 보안 경계가 아니라 작업 흐름 도구다.
export async function screen($: EngineInterface, command: string, shell: Shell, background: boolean, options: ScreenOptions): Promise<Screened> {
  const verdict = ruleVerdict(command, shell, background, options)
  const statedReason = bypassReason(command, shell)
  if (statedReason === null) return verdict ? { deny: reason(verdict) } : { bypassed: false }
  if (!verdict || !options.useModel) return { bypassed: true }
  const review = await reviewBypass($, command, verdict, statedReason).catch(() => null)
  if (review && !review.allow) return { deny: bypassRejected(verdict, statedReason, review.advice) }
  return { bypassed: true }
}
