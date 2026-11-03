// 짧은 메모는 판정하지 않는다. 영어 알림과 도구 결과마다 붙는 응답 언어 문장이 그 자리를 맡는다.
const MIN_LATIN_LETTERS = 20
const MIN_LATIN_SHARE = 0.9

// 코드, URL, 경로는 어느 언어로 쓴 글에도 영어로 들어가므로 판정에서 뺀다.
function proseOf(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@-]+)+[\\/]?/g, ' ')
}

// 글자가 거의 모두 ASCII 영문자인 글만 모델에게 묻는다. 한국어처럼 고유 문자를 쓰는 언어의 평소 응답은 여기서 걸러진다.
export function mayBeEnglish(text: string): boolean {
  const letters = proseOf(text).match(/\p{L}/gu) ?? []
  const latin = letters.filter(c => /[A-Za-z]/.test(c)).length
  return latin >= MIN_LATIN_LETTERS && latin / letters.length >= MIN_LATIN_SHARE
}

export const inLanguageLabel = (language: string) => `written in ${language}`
export const OTHER_LANGUAGE_LABEL = 'written in another language'

export const driftWarning = (language: string) =>
  `[j-cc] Your last note to the user was not in ${language}. Write in ${language} from now on, including the short notes between tool calls.`

export const driftToast = (language: string) => `j-cc: Claude wrote a note that was not in ${language}; it was told to switch back.`
