import { expect, test } from 'claude-code/testing'
import { parseBypassReview } from './judge'

test('parses the bypass review the model answers', () => {
  expect(parseBypassReview('allow')).toEqual({ allow: true })
  expect(parseBypassReview('Deny: use Grep with output_mode "content".\nextra')).toEqual({ allow: false, advice: 'use Grep with output_mode "content".' })
  expect(parseBypassReview('not sure')).toBe(null)
})

test('모델은 규칙에 막힐 명령의 우회 이유만 검토하고, 막을 규칙이 없는 명령의 주석에는 필요 없다고 알린다', async ($, on) => {
  const asked: string[] = []
  const store = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: 0 }))
  on('model.complete', ($, e) => {
    const prompt = String(e.prompt)
    asked.push(prompt)
    const text = prompt.includes('binary') ? 'allow' : 'deny: Use Grep with output_mode "content" for this search.'
    return { value: { isAnswered: true, text, usage: { input_tokens: 1, output_tokens: 1 } } }
  })
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  const lazy = await $.tool.call({ tool: 'Bash', command: 'grep -rn TODO src # j-cc:allow: quicker this way' })
  const again = await $.tool.call({ tool: 'Bash', command: 'grep -rn TODO src # j-cc:allow: quicker this way' })
  const binary = await $.tool.call({ tool: 'Bash', command: 'grep -c MAGIC app.exe # j-cc:allow: Grep skips binary files' })
  const foreground = await $.tool.call({ tool: 'Bash', command: 'npm test # j-cc:allow: need the result now' })

  expect(JSON.stringify(lazy)).toContain('[j-cc] Bypass rejected (search)')
  expect(JSON.stringify(lazy)).toContain('Use Grep with output_mode')
  expect(JSON.stringify(again)).toContain('Bypass rejected')
  expect(JSON.stringify(binary)).not.toContain('Bypass rejected')
  expect(JSON.stringify(binary)).toContain('Foreground Bash and PowerShell calls are off')
  expect(JSON.stringify(foreground)).toContain('comment on this command was not needed')
  expect(asked.length).toBe(2)
})

test('a bypass passes when the model gives no answer', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('model.complete', () => ({ value: { isAnswered: false, text: '', usage: { input_tokens: 0, output_tokens: 0 } } }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  const r = await $.tool.call({ tool: 'Bash', command: 'grep -c MAGIC app.exe # j-cc:allow: Grep skips binary files', run_in_background: true })

  expect(JSON.stringify(r)).not.toContain('[j-cc]')
})
