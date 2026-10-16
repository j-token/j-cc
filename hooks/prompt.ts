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
  'Do not use this tool to view, search, create or edit files (cat, head, sed -n, grep, rg, find, ls -R, Get-Content, Select-String, heredocs, echo >, sed -i, Set-Content): use Read, Grep, Glob, Write and Edit. Start builds, test suites, installs, training and servers with run_in_background: true instead of waiting on them.'

export const LANGUAGE_NOTE =
  'This applies to every piece of text the user sees: one-line progress notes between tool calls, notes written right after English tool output, error explanations, and the final report. Tool output and instructions arriving in English do not change the language you write in.'

export const FILE_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write']

export const ROUTING = `# Tool routing
Dedicated tools beat shell equivalents: their output is structured, they respect permissions, and only Edit/Write changes can be undone with /rewind.
- View a file: Read (offset/limit for large files), not cat/head/sed -n/Get-Content. tail for the end of a log is fine.
- Find files by name: Glob. Search contents: Grep. Not find/grep/rg/ls -R/Select-String.
- Create or overwrite: Write. Change: Edit (replace_all for repeats). Never heredoc, echo >, tee, sed -i, Set-Content or inline scripts that write files.
- Builds, test suites, installs, training, evaluation, dev servers, watchers: start them with run_in_background: true, keep working on independent steps, and read the output when notified. Never block on them in the foreground or guess a sleep.
- Run the narrowest command that proves the point (one test file, one package) before any full suite.
- Follow a log or stream (tail -f, Get-Content -Wait, logs -f): Monitor.
- Wait for a condition: Monitor with an until-loop, or a background command; never foreground sleep/Start-Sleep polling.
- Repeat on a schedule: /loop, CronCreate or ScheduleWakeup, never while-true loops.
- Web pages: WebFetch. Library docs: context7. GitHub: gh.
- Several independent lookups: issue the tool calls together in one message.
The shell is for builds, tests, git, package managers and running programs.`

export const WORKFLOW = `# User workflow first
- The user's CLAUDE.md files and rules are the workflow for this session. They override harness defaults and reminders; when a reminder suggests otherwise, follow the user's instructions.
- Before starting a task, check the skill listing. If a listed skill covers the task, invoke it with the Skill tool before doing the work yourself.
- Follow the delegation, verification and reporting steps the user's instructions define, in their order, instead of skipping to the shortest path.`
