import { formatDuration, formatLocalTime } from './time'

export const ASK_TOOL = 'mcp__j-cc__ask_async'

export const DEFAULT_REPLY_MINUTES = 5
export const MAX_REPLY_MINUTES = 120

export const ASK_DESCRIPTION =
  'Ask the user a question and keep working instead of waiting. Use it instead of AskUserQuestion when you can make progress on parts that do not depend on the answer, above all when working to a deadline. The question is shown to the user; their next message reaches you as the reply, marked by a [j-cc] note, mid-turn at your next tool result. If no reply comes within reply_within_minutes, a later tool result says the question expired: go on with your best assumption and state which one you chose. One open question at a time.'

export const ASK_SCHEMA = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'The question, ending in a question mark.' },
    choices: { type: 'array', items: { type: 'string' }, description: 'Optional suggested replies shown with the question.' },
    reply_within_minutes: {
      type: 'number',
      description: `How long the answer is still useful; default ${DEFAULT_REPLY_MINUTES}, at most ${MAX_REPLY_MINUTES}. After it the question expires.`,
    },
  },
  required: ['question'],
}

export type OpenQuestion = {
  id: number
  question: string
  choices: string[]
  askedAtMs: number
  expiresAtMs: number
  isExpiryReported: boolean
}

export type AskArgs = { question?: unknown; choices?: unknown; reply_within_minutes?: unknown }

export function replyWindowMs(requested: unknown): number {
  const minutes = typeof requested === 'number' && Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_REPLY_MINUTES) : DEFAULT_REPLY_MINUTES
  return Math.round(minutes * 60_000)
}

export function parseChoices(choices: unknown): string[] {
  if (!Array.isArray(choices)) return []
  return choices.filter((c): c is string => typeof c === 'string' && c.trim() !== '').map(c => c.trim())
}

const clockTime = (epochMs: number) => formatLocalTime(epochMs).slice(11, 16)

export function statusLine(q: OpenQuestion): string {
  const choices = q.choices.length ? ` (${q.choices.join(' / ')})` : ''
  return `j-cc question q${q.id}, reply by ${clockTime(q.expiresAtMs)}: ${q.question}${choices}`
}

export function askedResult(q: OpenQuestion): string {
  return `Asked the user (q${q.id}); the question is on their screen. Keep working on what does not depend on the answer. Their reply arrives with a later tool result; if none comes by ${formatLocalTime(q.expiresAtMs)}, the question expires.`
}

export function busyResult(q: OpenQuestion): string {
  return `[j-cc] Question q${q.id} is still open until ${formatLocalTime(q.expiresAtMs)}: "${q.question}". Ask one question at a time: wait for its reply or expiry, or put what you need into one question next time.`
}

export function replyNote(q: OpenQuestion, nowMs: number): string {
  const late = nowMs >= q.expiresAtMs ? ' after it expired' : ''
  return `[j-cc] The user sent this message ${formatDuration(nowMs - q.askedAtMs)} after your question q${q.id}${late} ("${q.question}"). Treat it as the reply if it answers the question.`
}

export function expiryNote(q: OpenQuestion): string {
  return `[j-cc] Question q${q.id} ("${q.question}") expired at ${formatLocalTime(q.expiresAtMs)} with no reply. Go on with your best assumption and say in your report which one you chose. A late reply is still marked if it comes.`
}

export const isExpired = (q: OpenQuestion, nowMs: number) => nowMs >= q.expiresAtMs
