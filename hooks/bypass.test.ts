import { expect, test } from 'claude-code/testing'
import { parseBypassReview } from './judge'

test('parses the bypass review the model answers', () => {
  expect(parseBypassReview('allow')).toEqual({ allow: true })
  expect(parseBypassReview('Deny: use Grep with output_mode "content".\nextra')).toEqual({ allow: false, advice: 'use Grep with output_mode "content".' })
  expect(parseBypassReview('not sure')).toBe(null)
})

test('the model reviews a bypass only when a rule would block the command', async ($, on) => {
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
  expect(JSON.stringify(binary)).not.toContain('[j-cc]')
  expect(JSON.stringify(foreground)).not.toContain('[j-cc]')
  expect(asked.length).toBe(2)
})

test('a bypass passes when the model gives no answer', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('model.complete', () => ({ value: { isAnswered: false, text: '', usage: { input_tokens: 0, output_tokens: 0 } } }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  const r = await $.tool.call({ tool: 'Bash', command: 'git status && git diff # j-cc:allow: need both in one result' })

  expect(JSON.stringify(r)).not.toContain('[j-cc]')
})
