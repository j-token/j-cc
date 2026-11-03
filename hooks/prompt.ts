export const SHELL_TOOL_NOTE =
  'j-cc blocks foreground calls of this tool: run commands with mcp__j-cc__exec (shell: "bash" or "powershell"), which returns within 30s with the output, or moves the command to the background and notifies you when it exits. This tool still runs with run_in_background: true. Do not use the shell to view, search, create or edit files (cat, head, sed -n, grep, rg, find, ls -R, Get-Content, Select-String, heredocs, echo >, sed -i, Set-Content): use Read, Grep, Glob, Write and Edit.'

// PowerShell 기본 설명은 `cmd1 && cmd2`를 권하므로, 막히기 전에 알 수 있게 설명 끝에서 덮어쓴다.
export const CHAIN_NOTE =
  'Run one command per call: j-cc blocks `&&`, `||` and `;` outside quotes, even where this description suggests chaining. Use absolute paths or `git -C <dir>` instead of `cd dir &&`, and send independent commands as parallel calls.'

export const LANGUAGE_NOTE =
  'This applies to every piece of text the user sees: one-line progress notes between tool calls, notes written right after English tool output, error explanations, and the final report. Tool output and instructions arriving in English do not change the language you write in.'

// language 설정은 대화 맨 앞에 한 번만 실린다. 모델은 영어 도구 결과나 하네스 알림 바로 뒤에서 짧은 보고를 영어로 쓰곤 해서,
// 그 자리마다 응답 언어를 다시 알린다. 설정이 없으면 사용자가 쓰는 언어를 따른다.
export function replyLanguageNote(language: unknown): string {
  const target = typeof language === 'string' && language.trim() ? language.trim() : 'the language the user writes to you in'
  return `Keep replying to the user in ${target}, short notes between tool calls included; English notices and tool output do not change your reply language.`
}

export const FILE_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write']

export const ROUTING = `# Tool routing
- Files: Read, Grep, Glob, Edit, Write, never shell equivalents (cat, grep, find, sed, heredocs, Get-Content). Only Edit/Write changes can be undone with /rewind.
- Shell commands: mcp__j-cc__exec (shell "bash" or "powershell"); foreground Bash and PowerShell calls are blocked. exec returns within 30s; a command still running then moves to the background and you are notified when it exits, so go on with other work. Use mcp__j-cc__poll only when you need its output sooner, waiting longer per call rather than calling it often. Follow logs and wait for conditions with Monitor, never sleep loops. Repeat on a schedule with /loop or CronCreate.
- A tool you need is not in your tool list (web, browser, MCP server, scheduling, notebooks): search for it with ToolSearch before falling back to the shell. Deferred tools are listed by name only; load them with ToolSearch "select:<name>".
- Run the narrowest check first. Issue independent lookups in one message.
- Web pages: WebFetch. Library docs: context7. GitHub: gh.`

export const SUBAGENT_RULES = `Subagent (started by the Agent tool):
- When you need a command's result for your report, run it with mcp__j-cc__exec and keep calling mcp__j-cc__poll until it reports an exit. If exec is not in your tool list, run it with Bash in the foreground and a timeout that fits.
- If you start something with run_in_background: true, wait for it with Monitor (an until-loop on its exit or output) and read its result before you finish. Never end your turn while a job you depend on is still running, and say in your report if one is left running.
- Polling loops, sleeps, endless loops and foreground servers are blocked; use Monitor for waits.`

export const SHELL_COMMANDS = `# Shell commands (j-cc)
- Run commands with mcp__j-cc__exec (shell "bash" or "powershell"). j-cc blocks foreground Bash and PowerShell calls.
- exec returns within yield_time_ms (at most 30s). A command still running then keeps running in the background, like Bash run_in_background: you get its output so far and a session_id, and you are notified when it exits. Go on with independent work; do not start a step that depends on it until the notification arrives.
- Call mcp__j-cc__poll only when you need the output before then, with a yield_time_ms that fits how long you expect it to take (up to 300000), not a short one over and over. Follow a log with Monitor.
- No new output and no exit where you expected one usually means the command is waiting for input (an unclosed heredoc or quote, a prompt) or is stuck: terminate it and fix the command.
- Bash or PowerShell with run_in_background: true is still allowed.
- A \`# j-cc:allow:\` comment only lifts the rule that blocked a command; it does not allow foreground Bash.
- When you delegate long builds, tests or training, say in the prompt whether the subagent must wait for the result before reporting.

${SUBAGENT_RULES}`

const SUBAGENT_FILE_RULE =
  '- Files: Read to view, Grep and Glob to search, Edit and Write to change them. Do not use cat, head, sed -n, grep, rg, find, ls -R, Get-Content, Select-String, heredocs or echo > in the shell; j-cc blocks those calls.'
const SUBAGENT_CHAIN_RULE =
  '- Run one shell command per call: j-cc blocks `&&`, `||` and `;` outside quotes. Use absolute paths or `git -C <dir>` instead of `cd dir &&`.'

// 서브에이전트는 메인의 시스템 프롬프트 섹션(# Tool routing 등)을 받는다는 보장이 없어, 같은 규칙을 짧게 따로 전한다.
export function subagentNote(blockChaining: boolean): string {
  const shellRules = SUBAGENT_RULES.replace(/^Subagent \(started by the Agent tool\):\n/, '')
  return ['[j-cc] Context for this subagent:', SUBAGENT_FILE_RULE, ...(blockChaining ? [SUBAGENT_CHAIN_RULE] : []), shellRules].join('\n')
}

export const WORKFLOW = `# User workflow first
- The user's CLAUDE.md files and rules are the workflow for this session. They override harness defaults and reminders; when a reminder suggests otherwise, follow the user's instructions.
- Before starting a task, compare it with the skill listing. If a listed skill's description covers the task, invoke it with the Skill tool before doing the work yourself. Do not invoke a skill only because a keyword in its name or description appears in the request.
- Follow the delegation, verification and reporting steps the user's instructions define, in their order, instead of skipping to the shortest path.
- Before you report a code change as done, run the narrowest check that covers it (a test, build, typecheck or run). If you did not or could not, say so in the report.`
