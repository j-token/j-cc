import { expect, test } from 'claude-code/testing'
import { hasShellFirst, rewriteShellFirst } from './prompt'
import { judge } from './rules'

type Case = [tool: 'Bash' | 'PowerShell', command: string, background: boolean, expected: string | null]

const CASES: Case[] = [
  ['Bash', 'grep -rn TODO src', false, 'search'],
  ['Bash', 'find . -name "*.ts"', false, 'search'],
  ['Bash', 'cat src/app.ts', false, 'view'],
  ['Bash', 'head -50 README.md', false, 'view'],
  ['Bash', "sed -n '10,40p' src/app.ts", false, 'view'],
  ['Bash', 'cat src/app.ts | grep def', false, 'search'],
  ['Bash', "cat > out.py <<'EOF'\nprint(1)\nEOF", false, 'write'],
  ['Bash', 'echo hello > notes.txt', false, 'write'],
  ['Bash', "sed -i 's/a/b/' x.ts", false, 'edit'],
  ['Bash', 'python -c "open(\'f.txt\',\'w\').write(\'x\')"', false, 'edit'],
  ['Bash', "bash -c \"sed -i 's/a/b/' x\"", false, 'edit'],
  ['PowerShell', 'Get-Content .\\src\\app.ts', false, 'view'],
  ['PowerShell', 'Select-String -Path *.cs -Pattern Foo', false, 'search'],
  ['PowerShell', 'Get-ChildItem -Recurse -Filter *.json', false, 'search'],
  ['PowerShell', 'Set-Content out.txt "hi"', false, 'write'],
  ['Bash', 'tail -f logs/app.log', true, 'follow'],
  ['PowerShell', 'Get-Content .\\server.log -Wait -Tail 20', false, 'follow'],
  ['Bash', 'watch -n 5 kubectl get pods', false, 'follow'],
  ['Bash', 'kubectl logs -f pod/api', false, 'follow'],
  ['Bash', 'while true; do curl -s localhost:8080/status; sleep 30; done', true, 'forever'],
  ['PowerShell', 'while ($true) { Get-Process node; Start-Sleep -Seconds 10 }', false, 'forever'],
  ['Bash', 'until curl -sf localhost:3000/health; do sleep 1; done', false, 'poll'],
  ['PowerShell', 'do { Start-Sleep 2 } until (Test-Path .\\dist\\index.js)', false, 'poll'],
  ['Bash', 'for i in $(seq 1 100); do git pull; sleep 300; done', true, 'schedule'],
  ['PowerShell', '1..288 | ForEach-Object { Invoke-RestMethod http://localhost/status; Start-Sleep 300 }', false, 'schedule'],
  ['Bash', 'sleep 90 && cat build.log', false, 'wait'],
  ['PowerShell', 'Start-Sleep -Seconds 60; Get-Content .\\out.log', false, 'wait'],
  ['PowerShell', 'ping -n 61 127.0.0.1 > $null; Get-Content out.log', false, 'wait'],
  ['Bash', 'python -c "import time; time.sleep(60)" && cat build.log', false, 'wait'],
  ['Bash', 'npm run dev', false, 'watch'],
  ['Bash', 'npx tsc --watch', false, 'watch'],
  ['Bash', 'uvicorn app:app --reload', false, 'watch'],

  ['Bash', 'until curl -sf localhost:3000/health; do sleep 1; done', true, null],
  ['Bash', 'npm run dev', true, null],
  ['Bash', 'sleep 90 && cat build.log', true, null],
  ['Bash', 'sleep 2 && curl localhost:3000', false, null],
  ['Bash', 'git status && git diff --stat', false, null],
  ['Bash', 'npm test', false, null],
  ['Bash', 'ls -la', false, null],
  ['Bash', 'tail -n 50 logs/app.log', false, null],
  ['PowerShell', 'Get-Content .\\app.log -Tail 50', false, null],
  ['Bash', 'echo $PATH | grep node', false, null],
  ['Bash', 'git log --oneline | head -5', false, null],
  ['Bash', 'cat package.json | jq .scripts', false, null],
  ['Bash', 'for f in *.png; do convert "$f" "${f%.png}.jpg"; done', false, null],
  ['Bash', 'echo $! > server.pid', false, null],
  ['Bash', 'sudo tee /etc/hosts <<< "127.0.0.1 x"', false, null],
  ['Bash', 'grep -rn TODO src # j-cc:allow: need raw byte offsets', false, null],
  ['Bash', 'tail -f app.log # use-right-tool:allow: legacy marker', false, null],
  ['PowerShell', 'Get-Process node | Select-Object Id', false, null],
  ['Bash', 'docker logs -f api', false, 'follow'],
  ['Bash', 'kubectl get pods -w', false, 'follow'],
  ['Bash', 'cat data.tsv | cut -f1', false, 'view'],
  ['PowerShell', 'Get-Content .\\a.txt | Select-Object -First 10', false, 'view'],

  ['Bash', 'kubectl apply -f deploy.yaml', false, null],
  ['Bash', 'kubectl delete -f k8s/', false, null],
  ['Bash', 'docker build -f Dockerfile .', true, null],
  ['Bash', 'docker rm -f api', false, null],
  ['Bash', 'docker system prune -af', false, null],
  ['Bash', 'docker compose -f compose.dev.yml up -d', false, null],
  ['Bash', 'docker exec -w /app api npm test', false, null],
  ['Bash', 'docker compose up --wait', false, null],
  ['PowerShell', 'Get-Content a.json -First 5 | ConvertFrom-Json', false, null],
  ['PowerShell', 'Get-Content -Force a.txt | Measure-Object -Line', false, null],
  ['PowerShell', 'Get-Process | ConvertTo-Json | Set-Content procs.json', false, null],
  ['Bash', 'sleep 10 & echo started', false, null],
  ['Bash', 'git log -p --follow src/a.ts', false, null],
]

for (const [tool, command, background, expected] of CASES) {
  test(`${tool}${background ? ' (bg)' : ''}: ${command.slice(0, 60)} -> ${expected ?? 'allow'}`, () => {
    const verdict = judge(command, tool === 'PowerShell' ? 'powershell' : 'bash', background, { blockChaining: false })
    expect(verdict?.kind ?? null).toBe(expected)
  })
}

const CHAIN_CASES: Case[] = [
  ['Bash', 'git status && git diff --stat', false, 'chain'],
  ['Bash', 'cd web; npm test', false, 'chain'],
  ['Bash', 'npm test || echo failed', false, 'chain'],
  ['PowerShell', 'Write-Output a; Write-Output b', false, 'chain'],
  ['Bash', 'for f in *.png; do convert "$f" out.jpg; done', false, 'chain'],
  ['Bash', 'cat a.ts && cat b.ts', false, 'view'],
  ['Bash', 'until curl -sf localhost:3000/health; do sleep 1; done', false, 'poll'],

  ['Bash', 'git log --oneline | head -5', false, null],
  ['Bash', 'echo "a; b && c"', false, null],
  ['Bash', "git commit -F - <<'EOF'\nfix: a; b && c\nEOF", false, null],
  ['Bash', 'sleep 10 & echo started', false, null],
  ['Bash', 'echo a\\;b', false, null],
  ['PowerShell', 'Write-Output "a;b"', false, null],
  ['Bash', 'git status && git diff # j-cc:allow: need both in one result', false, null],
]

for (const [tool, command, background, expected] of CHAIN_CASES) {
  test(`chaining on, ${tool}: ${command.slice(0, 60)} -> ${expected ?? 'allow'}`, () => {
    const verdict = judge(command, tool === 'PowerShell' ? 'powershell' : 'bash', background)
    expect(verdict?.kind ?? null).toBe(expected)
  })
}

test('chaining off allows chained commands', () => {
  const verdict = judge('git status && git diff --stat', 'bash', false, { blockChaining: false })

  expect(verdict).toBe(null)
})

const AUTO_MODE = `While auto mode is active:

You can do much of your work through the Bash tool when it is the simpler route: read files with cat, head, or sed -n, search with grep and find, and make small, mechanical file changes with sed, heredocs, or short scripts instead of the dedicated Read, Edit, or Write tools. The choice is yours: prefer Edit or Write when a shell edit would be fragile.

Keep going.`

test('rewrites the shell-first auto mode paragraph only', () => {
  expect(hasShellFirst(AUTO_MODE)).toBe(true)
  const out = rewriteShellFirst(AUTO_MODE)
  expect(out.includes('through the Bash tool')).toBe(false)
  expect(out.includes('Read to view')).toBe(true)
  expect(out.startsWith('While auto mode is active:')).toBe(true)
  expect(out.endsWith('Keep going.')).toBe(true)
  expect(hasShellFirst(out)).toBe(false)
})

test('denies a misused Bash call through the hook', async ($, on) => {
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  const denied = await $.tool.call({ tool: 'Bash', command: 'grep -rn TODO src' })
  expect(JSON.stringify(denied)).toContain('[j-cc] Blocked (search)')
  const allowed = await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(JSON.stringify(allowed)).not.toContain('[j-cc]')
})

test('denies a chained Bash call through the hook', async ($, on) => {
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  const denied = await $.tool.call({ tool: 'Bash', command: 'git status && git diff' })

  expect(JSON.stringify(denied)).toContain('[j-cc] Blocked (chain, &&)')
})

test('appends the routing section to the system prompt', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hello', scope: 'shared' }] }))
  const { sections } = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: ['Bash', 'Read', 'Edit'],
    outputStyle: null,
    traits: [],
  })
  expect(sections.map(s => s.id)).toContain('j-cc:routing')
  expect(sections.map(s => s.id)).toContain('j-cc:auto-background')
})
