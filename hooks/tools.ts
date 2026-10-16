// 도구 로딩 배치와 설명. 이 세션에 등록되지 않은 도구는 tool.describe 가 불리지 않으므로 목록에 있어도 아무 일도 일어나지 않는다.
import { READ_DEFAULT_LIMIT } from './context'

export const ALWAYS_LOADED = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'PowerShell',
  'Monitor',
  'TaskStop',
  'GetTask',
  'Agent',
  'ListAgents',
  'Skill',
  'AskUserQuestion',
  'ReportFindings',
  'ToolSearch',
]

export const SEARCH_LOADED = [
  'NotebookEdit',
  'LSP',
  'SendMessage',
  'SendFile',
  'Workflow',
  'PushNotification',
  'EndConversation',
  'ExitPlanMode',
  'ScheduleWakeup',
  'CronCreate',
  'CronDelete',
  'CronList',
  'RemoteTrigger',
  'WebFetch',
  'WebSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ReadMcpResourceDirTool',
  'Artifact',
  'ArtifactComments',
  'ArtifactData',
  'DesignSync',
]

// 플러그인은 도구를 목록에서 뺄 수 없어, /j-cc-tools apply 를 입력했을 때만 사용자 settings.json 의 permissions.deny 에 넣는다.
export const REMOVED = [
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'ProposeGoal',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'SendUserMessage',
  'SendUserFile',
  'WaitForMcpServers',
  'SearchMcpRegistry',
  'ArtifactCheck',
  'AppifactRepl',
  'ClaudeDesign',
  'ListPlugins',
  'SearchPlugins',
  'PublishPlugin',
  'SuggestPluginInstall',
  'ListSkills',
  'SearchSkills',
  'SuggestSkills',
  'ListConnectors',
  'SuggestConnectors',
  'FetchInboxMessage',
  'ReadNotifications',
  'Poll',
  'ShareOnboardingGuide',
  'ShowOnboardingRolePicker',
  'OfferChromeSetup',
  'Projects',
  'SendFeedback',
]

type Settings = { permissions?: { deny?: unknown[] } & Record<string, unknown> } & Record<string, unknown>

export function denyList(settings: Settings): string[] {
  const deny = settings.permissions?.deny
  return Array.isArray(deny) ? deny.filter((rule): rule is string => typeof rule === 'string') : []
}

export function withDenyRules(settings: Settings, tools: readonly string[]): { settings: Settings; changed: string[] } {
  const current = denyList(settings)
  const added = tools.filter(tool => !current.includes(tool))
  if (!added.length) return { settings, changed: [] }
  return { settings: { ...settings, permissions: { ...settings.permissions, deny: [...current, ...added] } }, changed: added }
}

export function withoutDenyRules(settings: Settings, tools: readonly string[]): { settings: Settings; changed: string[] } {
  const current = denyList(settings)
  const removed = current.filter(rule => tools.includes(rule))
  if (!removed.length) return { settings, changed: [] }
  const deny = current.filter(rule => !tools.includes(rule))
  const { deny: _, ...rest } = settings.permissions ?? {}
  return { settings: { ...settings, permissions: deny.length ? { ...rest, deny } : rest }, changed: removed }
}

const isDeferredByTool = new Map<string, boolean>([
  ...ALWAYS_LOADED.map(tool => [tool, false] as const),
  ...SEARCH_LOADED.map(tool => [tool, true] as const),
])

export const deferralFor = (tool: string): boolean | undefined => isDeferredByTool.get(tool)

const SHELL_RULES =
  'For files use Read, Grep, Glob, Edit and Write, not shell commands. Start builds, tests, installs and servers with run_in_background: true.'

// 원래 셸 설명에 있던 행동 규칙 중 어기면 되돌리기 어렵거나 셸이 멈추는 것, 엔진이 다른 곳에서 알려 주지 않는 것만 남긴다.
const GIT_RULES = [
  'Git: commit or push only when the user asks; on the default branch, branch first.',
  "End git commit messages and PR bodies with the attribution lines given in the conversation's system-reminder, when one is present.",
  'Use the gh CLI for GitHub operations.',
  'Never use interactive flags (git rebase -i, git add -i).',
  'Prefer a new commit over --amend. Before a destructive operation (reset --hard, push --force, checkout --), look for a safer alternative.',
  'Never skip hooks (--no-verify) or bypass signing unless the user asked.',
].join(' ')

const BASH_RULES = 'Use Unix syntax: /dev/null not NUL, forward slashes, $VAR. For multi-line strings use a heredoc.'

const POWERSHELL_RULES = [
  'Never wait for input: no Read-Host, Get-Credential, Out-GridView, $Host.UI.PromptForChoice or pause.',
  'Add -Confirm:$false to destructive cmdlets you intend to run (Remove-Item, Stop-Process, Clear-Content).',
  "For multi-line strings use a single-quoted here-string (@'...'@) with the closing '@ at column 0.",
].join(' ')

const SHELL_COMMON = 'timeout is in ms (default 120000, max 600000). run_in_background: true detaches it and notifies you when it exits.'

// 셸 종류와 PowerShell 판은 환경마다 달라 엔진의 원래 설명에서 가져온다.
function bashDescription(original: string): string {
  const shell = /Git Bash/.test(original)
    ? `Run a command in Git Bash (POSIX sh, not cmd or PowerShell) and return stdout and stderr. ${SHELL_COMMON} ${SHELL_RULES} ${BASH_RULES}`
    : `Run a bash command and return stdout and stderr. ${SHELL_COMMON} ${SHELL_RULES}`
  return `${shell} ${GIT_RULES}`
}

// 판 이름 아래 "   - " 목록은 그 판에서만 맞는 문법(5.1 의 && 금지 등)이라 그대로 옮긴다.
function powerShellDescription(original: string): string {
  const edition = /PowerShell edition: ([^\n]+)((?:\n[ \t]+- [^\n]*)*)/.exec(original)
  const intro = 'Run a PowerShell command and return its output.'
  const editionRules = edition ? `\nPowerShell edition: ${edition[1].trim()}${edition[2]}\n` : ' '
  return `${intro}${editionRules}${SHELL_COMMON} ${SHELL_RULES} ${POWERSHELL_RULES} ${GIT_RULES}`
}

// 샌드박스 안내는 설정마다 내용이 달라지고 우회 조건이 들어 있어, 있으면 원래 설명을 그대로 둔다.
export function simpleDescription(tool: string, original: string): string {
  if ((tool === 'Bash' || tool === 'PowerShell') && /sandbox/i.test(original)) return original
  if (tool === 'Bash') return bashDescription(original)
  if (tool === 'PowerShell') return powerShellDescription(original)
  return SIMPLE_DESCRIPTIONS[tool] ?? original
}

// pi 의 도구 설명처럼 무엇을 하는지와 꼭 필요한 제약만 남긴다. 사용 사례 설명이 필요한 도구(Artifact, Workflow 등)는 검색으로 로딩하므로 원래 설명을 둔다.
const SIMPLE_DESCRIPTIONS: Record<string, string> = {
  Read: `Read a file by absolute path. Text is returned with line numbers; without offset/limit only the first ${READ_DEFAULT_LIMIT} lines are shown, so use offset/limit for the rest. Also reads images, PDFs (pages, at most 20 per call) and notebooks.`,
  Write: 'Write content to a file by absolute path, creating or overwriting it. Read an existing file before overwriting it.',
  Edit: 'Replace exact text in a file. old_string must match exactly once unless replace_all is true. Read the file in this conversation before editing it.',
  Glob: 'Find files by glob pattern, such as "**/*.ts". Returns paths sorted by modification time.',
  Grep: 'Search file contents with a ripgrep regex. output_mode is files_with_matches (default), content or count. Narrow with glob or type.',
  Monitor: 'Watch a command (each stdout line is an event; exit ends it) or a WebSocket, and get notified per event. Use it to follow logs or wait for a condition instead of sleeping.',
  TaskStop: 'Stop a background task or a named background agent by task_id.',
  GetTask: 'Get the status and output of a command that was moved to the background, by taskId.',
  Agent: 'Start a subagent with a prompt. subagent_type picks a type from the list in the conversation; "fork" inherits your context.',
  ListAgents: 'List the agents and sessions you can message with SendMessage.',
  Skill: 'Invoke a skill from the skill listing by name, with optional args.',
  AskUserQuestion: 'Ask the user 1-4 multiple-choice questions when a decision is theirs to make. The user can always answer with free text.',
  ReportFindings: 'Report code review findings as a list, most severe first. Use only when review instructions ask for it.',
  ToolSearch: 'Load the schemas of deferred tools so you can call them. Use "select:A,B" to load tools by name, or keywords to search.',
}
