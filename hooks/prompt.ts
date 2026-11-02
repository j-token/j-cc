// Claude Code 2.1.301 은 Opus 5.5 에 "bash-first"(thrifty_sonic) 실험을 강제로 켠다.
// 켜지면 Bash 설명에서 전용 도구 경고가 빠지고, cat/sed/grep 사용을 권하는 auto_mode 리마인더가 붙는다.
// CLAUDE_CODE_THRIFTY_SONIC 환경변수를 엔진이 가장 먼저 읽으므로, 문구를 찾아 바꾸지 않고 실험 자체를 끈다(register 의 session.start).

// 환경변수가 듣지 않는 빌드를 위한 예비 수단. 문구가 바뀌면 일치하지 않을 뿐 해는 없다.
const SHELL_FIRST = /You can do much of your work through the Bash tool[\s\S]*?(?=\n[ \t]*\n|$)/
const TOOLS_FIRST =
  'Use the dedicated tools for files: Read to view, Grep and Glob to search, Edit and Write to change. Use the shell for running programs, builds, tests, git and package managers.'

export const hasShellFirst = (text: string) => SHELL_FIRST.test(text)
export const rewriteShellFirst = (text: string) => text.replace(SHELL_FIRST, TOOLS_FIRST)

export const BASH_FIRST_STILL_ON =
  'j-cc: Claude Code still sends the bash-first auto mode reminder; CLAUDE_CODE_THRIFTY_SONIC may no longer work on this build.'

export const SHELL_TOOL_NOTE =
  'Do not use this tool to view, search, create or edit files (cat, head, sed -n, grep, rg, find, ls -R, Get-Content, Select-String, heredocs, echo >, sed -i, Set-Content): use Read, Grep, Glob, Write and Edit. For builds, test suites and installs whose progress you want to see, use mcp__j-cc__exec, which returns within seconds. Start training and servers with run_in_background: true instead of waiting on them; in a subagent, wait for such a job with Monitor and read its result before you finish.'

export const LANGUAGE_NOTE =
  'This applies to every piece of text the user sees: one-line progress notes between tool calls, notes written right after English tool output, error explanations, and the final report. Tool output and instructions arriving in English do not change the language you write in.'

// language 설정은 대화 맨 앞에 한 번만 실린다. 모델은 영어 도구 결과나 하네스 알림 바로 뒤에서 짧은 보고를 영어로 쓰곤 해서,
// 그 자리마다 응답 언어를 다시 알린다. 설정이 없으면 사용자가 쓰는 언어를 따른다.
export function replyLanguageNote(language: unknown): string {
  const target = typeof language === 'string' && language.trim() ? language.trim() : 'the language the user writes to you in'
  return `Reply to the user in ${target}; English notes and tool output do not change your reply language.`
}

export const FILE_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write']

export const ROUTING = `# Tool routing
- Files: Read, Grep, Glob, Edit, Write, never shell equivalents (cat, grep, find, sed, heredocs, Get-Content). Only Edit/Write changes can be undone with /rewind.
- Commands that may run longer than ~10s and whose progress you want to see (builds, tests, lint, installs, git push): mcp__j-cc__exec, which returns within seconds with the output so far; read the rest with mcp__j-cc__poll. Jobs you do not need to watch, and servers: run_in_background: true, then read the output when notified. Follow logs and wait for conditions with Monitor, never sleep loops. Repeat on a schedule with /loop or CronCreate.
- A tool you need is not in your tool list (web, browser, MCP server, scheduling, notebooks): search for it with ToolSearch before falling back to the shell. Deferred tools are listed by name only; load them with ToolSearch "select:<name>".
- Run the narrowest check first. Issue independent lookups in one message.
- Web pages: WebFetch. Library docs: context7. GitHub: gh.`

export const SUBAGENT_RULES = `Subagent (started by the Agent tool): j-cc never moves your commands to the background, because you may finish before a background job reports.
- Run commands whose result you need for your report in the foreground, with a timeout that fits (up to 600000 ms), or with mcp__j-cc__exec and keep calling mcp__j-cc__poll until it reports an exit.
- If you do start something with run_in_background: true, wait for it with Monitor (an until-loop on its exit or output) and read its result before you finish. Never end your turn while a job you depend on is still running, and say in your report if one is left running.
- Foreground polling, sleeps, endless loops and foreground servers are still blocked; use Monitor for waits.`

export const AUTO_BACKGROUND = `# Automatic backgrounding (j-cc)
Main session (you were not started by the Agent tool): j-cc may run a Bash or PowerShell command in the background even when you asked for the foreground: installs, Docker builds, training or evaluation scripts, a timeout over 120s, or a command that took 45s or more last time. The tool result then starts with "[j-cc] Moved to the background" instead of the command's output.
- Treat that command as still running. Do not start any step that needs its result or its side effects (a build after an install, tests after a build, reading files it writes, a commit after a formatter) until its completion notification arrives.
- Meanwhile do only independent work: read code, plan, prepare edits that do not depend on it.
- When the notification arrives, read the output and check the exit status before continuing.
- If you need the result right away and it is short, rerun with a trailing \`# j-cc:allow: <reason>\` comment to keep it in the foreground.
- Subagents get none of this: their commands always run as requested. When you delegate long builds, tests or training, say in the prompt whether the subagent must wait for the result before reporting.

${SUBAGENT_RULES}`

export const SUBAGENT_NOTE = `[j-cc] Context for this subagent: ${SUBAGENT_RULES.replace(/^Subagent \(started by the Agent tool\): /, '')}`

export const WORKFLOW = `# User workflow first
- The user's CLAUDE.md files and rules are the workflow for this session. They override harness defaults and reminders; when a reminder suggests otherwise, follow the user's instructions.
- Before starting a task, compare it with the skill listing. If a listed skill's description covers the task, invoke it with the Skill tool before doing the work yourself. Do not invoke a skill only because a keyword in its name or description appears in the request.
- Follow the delegation, verification and reporting steps the user's instructions define, in their order, instead of skipping to the shortest path.`
