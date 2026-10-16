// use-right-tool 의 shell.mjs 를 옮긴 근사 파서. 완전한 bash/PowerShell 파서가 아니며, 입력을 한 번만 훑는다.

export type Shell = 'bash' | 'powershell'

export type Segment = string[] & {
  firstQuoted?: boolean
  piped?: boolean
  background?: boolean
  outputs?: string[]
  heredocs?: string[]
  herestring?: string
}

type Tokens = { segments: Segment[]; comments: string[]; substitutions: string[] }

const SEPARATORS = new Set([';', '(', ')', '{', '}'])

function matchBalanced(text: string, open: number, ps: boolean): number {
  const openCh = text[open]
  const closeCh = openCh === '(' ? ')' : '}'
  const escape = ps ? '`' : '\\'
  let depth = 0
  let quote: string | null = null
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === escape && quote !== "'") {
      i++
      continue
    }
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') quote = c
    else if (c === openCh) depth++
    else if (c === closeCh && --depth === 0) return i
  }
  return text.length - 1
}

export function tokenize(command: string, shell: Shell): Tokens {
  const ps = shell === 'powershell'
  const n = command.length
  const segments: Segment[] = []
  const comments: string[] = []
  const substitutions: string[] = []
  const pendingHeredocs: { delim: string; strip: boolean; owner: Segment }[] = []
  let seg: Segment = []
  let word: string | null = null
  let wordQuoted = false
  let nextWordTo: null | 'drop' | 'output' | 'herestring' = null
  let pipeNext = false
  let i = 0

  const startSeg = () => {
    seg.firstQuoted = wordQuoted
    if (pipeNext) seg.piped = true
    pipeNext = false
  }
  const endWord = () => {
    if (word === null) return
    if (nextWordTo === 'output') (seg.outputs ??= []).push(word)
    else if (nextWordTo === 'herestring') seg.herestring = word
    else if (nextWordTo !== 'drop') {
      if (!seg.length) startSeg()
      seg.push(word)
    }
    nextWordTo = null
    word = null
    wordQuoted = false
  }
  const endSeg = () => {
    endWord()
    if (seg.length) segments.push(seg)
    seg = []
  }
  const append = (text: string, quoted = false) => {
    if (word === null) wordQuoted = quoted
    word = (word ?? '') + text
  }
  const substitution = (open: number) => {
    const end = matchBalanced(command, open, ps)
    substitutions.push(command.slice(open + 1, end))
    return end
  }
  // heredoc 본문은 데이터이므로 단어로 나누지 않고, 그 heredoc 을 연 세그먼트에 붙인다.
  const skipHeredocs = (start: number) => {
    let pos = start
    for (const { delim, strip, owner } of pendingHeredocs) {
      const body: string[] = []
      while (pos < n) {
        const nl = command.indexOf('\n', pos)
        const end = nl < 0 ? n : nl
        let line = command.slice(pos, end).replace(/\r$/, '')
        if (strip) line = line.replace(/^\t+/, '')
        pos = end + 1
        if (line === delim) break
        body.push(line)
      }
      ;(owner.heredocs ??= []).push(body.join('\n'))
    }
    pendingHeredocs.length = 0
    return Math.min(pos, n)
  }

  while (i < n) {
    const c = command[i]
    const next = command[i + 1]

    if (c === '\n') {
      endSeg()
      i++
      if (pendingHeredocs.length) i = skipHeredocs(i)
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i++
      continue
    }
    if (ps && c === '<' && next === '#') {
      const end = command.indexOf('#>', i + 2)
      comments.push(command.slice(i, end < 0 ? n : end + 2))
      i = end < 0 ? n : end + 2
      continue
    }
    if (c === '#' && word === null) {
      const nl = command.indexOf('\n', i)
      const end = nl < 0 ? n : nl
      comments.push(command.slice(i, end).replace(/\r$/, ''))
      i = end
      continue
    }
    if (ps && c === '@' && word === null && (next === "'" || next === '"')) {
      const close = command.indexOf(`\n${next}@`, i + 2)
      const end = close < 0 ? n : close
      append(command.slice(i + 2, end), true)
      i = close < 0 ? n : close + 3
      continue
    }
    if (!ps && c === '$' && next === "'") {
      let j = i + 2
      let buf = ''
      while (j < n && command[j] !== "'") {
        if (command[j] === '\\' && j + 1 < n) {
          buf += command[j + 1]
          j += 2
        } else buf += command[j++]
      }
      append(buf, true)
      i = j + 1
      continue
    }
    if (c === "'") {
      const close = command.indexOf("'", i + 1)
      const end = close < 0 ? n : close
      append(command.slice(i + 1, end), true)
      i = end + 1
      continue
    }
    if (c === '"') {
      let j = i + 1
      let buf = ''
      while (j < n && command[j] !== '"') {
        const d = command[j]
        if (d === '$' && command[j + 1] === '(') {
          const end = substitution(j + 1)
          buf += command.slice(j, end + 1)
          j = end + 1
        } else if (!ps && d === '`') {
          const close = command.indexOf('`', j + 1)
          const end = close < 0 ? n : close
          substitutions.push(command.slice(j + 1, end))
          buf += command.slice(j, end + 1)
          j = end + 1
        } else if (!ps && d === '\\' && j + 1 < n && '$`"\\\n'.includes(command[j + 1])) {
          buf += command[j + 1]
          j += 2
        } else if (ps && d === '`' && j + 1 < n) {
          buf += command[j + 1]
          j += 2
        } else {
          buf += d
          j++
        }
      }
      append(buf, true)
      i = j + 1
      continue
    }
    if (c === '$' && (next === '(' || next === '{')) {
      const end = next === '(' ? substitution(i + 1) : matchBalanced(command, i + 1, ps)
      append(command.slice(i, end + 1))
      i = end + 1
      continue
    }
    if (c === '`') {
      if (ps) {
        if (i + 1 < n) append(command[i + 1])
        i += 2
      } else {
        const close = command.indexOf('`', i + 1)
        const end = close < 0 ? n : close
        substitutions.push(command.slice(i + 1, end))
        append(command.slice(i, end + 1))
        i = end + 1
      }
      continue
    }
    if (!ps && c === '\\') {
      if (i + 1 < n && command[i + 1] !== '\n') append(command[i + 1])
      i += 2
      continue
    }
    if (c === '|') {
      endSeg()
      if (next !== '|') pipeNext = true
      i += next === '|' ? 2 : 1
      continue
    }
    if (c === '&') {
      if (next === '&') {
        endSeg()
        i += 2
      } else if (!ps && next === '>') {
        endWord()
        i += command[i + 2] === '>' ? 3 : 2
        nextWordTo = 'output'
      } else if (ps && word === null && !seg.length) {
        startSeg()
        seg.push('&')
        i++
      } else {
        seg.background = true
        endSeg()
        i++
      }
      continue
    }
    if (SEPARATORS.has(c)) {
      endSeg()
      i++
      continue
    }
    if (c === '<' && next === '<' && !ps) {
      endWord()
      if (command[i + 2] === '<') {
        i += 3
        nextWordTo = 'herestring'
        continue
      }
      let j = i + 2
      const strip = command[j] === '-'
      if (strip) j++
      while (command[j] === ' ' || command[j] === '\t') j++
      let delim = ''
      while (j < n && !/[\s;|&<>()]/.test(command[j])) {
        if (!`'"\\`.includes(command[j])) delim += command[j]
        j++
      }
      pendingHeredocs.push({ delim, strip, owner: seg })
      i = j
      continue
    }
    if (c === '>' || (c === '<' && !ps)) {
      if (word !== null && /^\d+$|^\*$/.test(word)) word = null
      else endWord()
      i++
      if (command[i] === '>' || command[i] === '|') i++
      if (command[i] === '&') {
        i++
        while (i < n && /[\d-]/.test(command[i])) i++
        continue
      }
      nextWordTo = c === '>' ? 'output' : 'drop'
      continue
    }
    append(c)
    i++
  }
  endSeg()
  return { segments, comments, substitutions }
}

const KEYWORDS = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', 'time', 'exec', 'command', 'builtin', 'nohup', 'sudo', 'doas', 'xvfb-run'])

export const commandName = (word: string) =>
  (word.replace(/\\/g, '/').split('/').pop() ?? '').toLowerCase().replace(/\.exe$/, '')

// 래퍼와 키워드(env, timeout, npx, uv run, sudo ...)를 걷어 낸 실제 명령 단어들.
export function stripPrefix(words: readonly string[], shell: Shell): string[] {
  let k = 0
  while (k < words.length) {
    const w = words[k]
    const lw = commandName(w)
    if (KEYWORDS.has(lw)) k++
    else if (shell === 'bash' && /^[A-Za-z_]\w*=/.test(w)) k++
    else if (shell === 'powershell' && w === '&') k++
    else if (lw === 'env') {
      k++
      while (k < words.length && (words[k].includes('=') || words[k].startsWith('-'))) k++
    } else if (lw === 'nice') {
      k++
      if (words[k] === '-n') k += 2
      else if (/^-\d+$/.test(words[k] ?? '')) k++
    } else if (lw === 'timeout' && /^-|^\d/.test(words[k + 1] ?? '')) {
      k++
      while (k < words.length && words[k].startsWith('-')) k += /^(-s|-k|--signal|--kill-after)$/.test(words[k]) ? 2 : 1
      k++
    } else if (lw === 'stdbuf' || lw === 'npx' || lw === 'bunx' || lw === 'pnpx') {
      k++
      while (k < words.length && words[k].startsWith('-')) k++
    } else if ((lw === 'pnpm' || lw === 'yarn') && (words[k + 1] === 'exec' || words[k + 1] === 'dlx')) {
      k += 2
    } else if (/^(uv|poetry|pipenv|pdm|hatch|rye|conda)$/.test(lw) && words[k + 1] === 'run') {
      k += 2
      while (k < words.length && words[k].startsWith('-')) k += /^(-n|--name|-p|--prefix|--with)$/.test(words[k]) ? 2 : 1
    } else break
  }
  return words.slice(k)
}
