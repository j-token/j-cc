export const PYTHON = /^(python[\d.]*|py|pythonw|pypy[\d.]*)$/
export const SCRIPT_RUNNERS = /^(npm|pnpm|yarn|bun)$/

export const operands = (args: readonly string[]) => args.filter(a => !a.startsWith('-'))
export const hasFlag = (args: readonly string[], re: RegExp) => args.some(a => re.test(a))

// 오래된 키부터 지워 $.store 의 4 MiB 한도 안에 머문다. 다시 쓴 키는 가장 최근으로 옮긴다.
export function rememberBounded<T>(map: Record<string, T>, key: string, value: T, max: number): Record<string, T> {
  const next = { ...map }
  delete next[key]
  next[key] = value
  const keys = Object.keys(next)
  for (const old of keys.slice(0, Math.max(0, keys.length - max))) delete next[old]
  return next
}

// 명령 원문(비밀값이 들어 있을 수 있다)을 저장하지 않으려고 FNV-1a 해시를 키로 쓴다.
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
