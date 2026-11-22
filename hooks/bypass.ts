import type { EngineInterface } from 'claude-code'
import { fnv1a } from './common'
import { BYPASS_REQUEST, BYPASS_STORE_KEY, bypassPrompt, parseBypassReview, rememberBypassReview, type BypassReview, type BypassReviews } from './judge'
import { bypassReason, bypassRejected, guidance, reason, ruleVerdict, type JudgeOptions, type Verdict } from './rules'
import type { Shell } from './shell'

export type ScreenOptions = JudgeOptions & { useModel: boolean }
export type Refusal = { deny: string; isNeedlessBypass?: true }

export const NEEDLESS_BYPASS_NOTE =
  '[j-cc] The `# j-cc:allow:` comment on this command was not needed: no rule blocks it, and the comment does not allow foreground Bash. Leave it off.'

// auto 모드 분류기는 j-cc 를 모르므로, 막히지도 않은 명령에 붙은 "allow" 주석을 감독을 피하려는 시도로 보고 막는다.
// 주석을 떼고 다시 내게 하려고 실행 전에 거절한다. 입력에서 주석을 지우면 분류기의 판정이 무효가 된다.
export const NEEDLESS_BYPASS_REFUSAL = `${NEEDLESS_BYPASS_NOTE} This call was not run: send the same command again without the comment. Add the comment only to a command j-cc has just blocked.`

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
export async function screen($: EngineInterface, command: string, shell: Shell, background: boolean, options: ScreenOptions): Promise<Refusal | null> {
  const verdict = ruleVerdict(command, shell, background, options)
  const statedReason = bypassReason(command, shell)
  if (statedReason === null) return verdict ? { deny: reason(verdict) } : null
  if (!verdict) return { deny: NEEDLESS_BYPASS_REFUSAL, isNeedlessBypass: true }
  if (!options.useModel) return null
  const review = await reviewBypass($, command, verdict, statedReason).catch(() => null)
  if (review && !review.allow) return { deny: bypassRejected(verdict, statedReason, review.advice) }
  return null
}
