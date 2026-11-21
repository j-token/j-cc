export const TIME_NOTE_INTERVAL_MS = 60_000

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// 엔진에는 시간대 API가 없어 mod 런타임의 Date가 아는 오프셋을 쓴다. 런타임이 UTC로 돌면 +00:00으로 찍히지만 절대 시각은 맞다.
export function formatLocalTime(epochMs: number, offsetMinutes = -new Date(epochMs).getTimezoneOffset()): string {
  const local = new Date(epochMs + offsetMinutes * 60_000)
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absMinutes = Math.abs(offsetMinutes)
  const offset = `${sign}${String(Math.floor(absMinutes / 60)).padStart(2, '0')}:${String(absMinutes % 60).padStart(2, '0')}`
  return `${local.toISOString().slice(0, 19)}${offset} (${WEEKDAYS[local.getUTCDay()]})`
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

export const promptTimeNote = (nowMs: number, offsetMinutes?: number) => `[j-cc] Current time: ${formatLocalTime(nowMs, offsetMinutes)}.`

export function toolTimeNote(nowMs: number, userMessageAtMs: number | null, offsetMinutes?: number): string {
  const since = userMessageAtMs !== null && nowMs >= userMessageAtMs ? `; ${formatDuration(nowMs - userMessageAtMs)} since the user's last message` : ''
  return `[j-cc] Current time: ${formatLocalTime(nowMs, offsetMinutes)}${since}.`
}

// 테스트마다 모의 시계가 0 근처에서 다시 시작하므로, 지난 기록보다 이른 시각도 새로 알릴 때로 본다.
export function isTimeNoteDue(nowMs: number, lastNoteAtMs: number | null): boolean {
  return lastNoteAtMs === null || nowMs < lastNoteAtMs || nowMs - lastNoteAtMs >= TIME_NOTE_INTERVAL_MS
}

export const TIME_SECTION = `# Time (j-cc)
- User messages and, about once a minute, tool results carry a "[j-cc] Current time" note with the local time and UTC offset. The date at the start of the conversation goes stale; trust the latest note.
- Turn relative deadlines from the user ("in 15 minutes", "before the meeting", "by tonight") into absolute times against the note on their message, and say the absolute time back when you plan around it.
- Check later notes against the deadline. When little time is left, stop starting new work, finish and deliver what you have, and state what you did not get to.`
