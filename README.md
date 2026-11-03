# j-cc

Harness tuning for Claude models in Claude Code, especially Opus 5.5: use the dedicated tools, follow the user's instructions and skills, and stop blocking on long commands. Runs entirely inside Claude Code: no external model, no API key.

[한국어](README.ko.md)

## Why

Findings from Claude Code 2.1.301:

- Claude Code **forces the "bash-first" experiment (`thrifty_sonic`) on for Opus 5.5 only.** With it on:
  - the Bash tool description loses its `IMPORTANT` warning to use the dedicated tools instead of find, grep, cat, head and sed;
  - auto mode adds a reminder saying files can be read with cat/head/sed -n, searched with grep/find and edited with sed or heredocs, "The choice is yours".
- GPT models reached through a proxy are unknown to Claude Code, so the experiment stays off for them, which is why they pick the dedicated tools more often under the same harness.
- Transcripts from 2026-09-10 to 11-02 (3,581 files; interactive CLI sessions only) compare Opus main sessions with and without j-cc over the same period (from 10-16, when j-cc started). Tasks differ between sessions, so not every gap is j-cc's. Method, the full tables and the paper the changes rest on ([arXiv:2609.00006](https://arxiv.org/html/2609.00006v1)): [docs/harness-engineering-evidence.md](docs/harness-engineering-evidence.md).

| Metric (Opus, main session) | j-cc (38) | No j-cc, since 10-16 (120) |
|---|---|---|
| File views / searches per 100 shell calls | 3.3 / 1.8 | 8.0 / 9.2 |
| Foreground commands over 60s per 1,000 shell calls | 11.5 | 28.6 |
| Foreground wait per shell call | 4.5s | 8.8s |
| Code-editing turns with no check after the last edit | 6.7% | 14.5% |

- Subagents under j-cc still viewed and searched files from the shell 12.7 / 9.4 times per 100 shell calls, about 4-5 times the main session, and were blocked twice as often. Main-session prompt sections are not guaranteed to reach them, so they now get the rules when they start.

## What it does

| Feature | How |
|---|---|
| Turn bash-first off | Sets `CLAUDE_CODE_THRIFTY_SONIC=0` at session start. The engine reads this variable first, so nothing depends on matching prompt wording. Checked in 2.1.301 and still the same in 2.1.316. A value you set yourself is left alone. |
| Tool descriptions | Appends to the Bash and PowerShell descriptions that foreground calls are blocked in favor of exec, that they are for `run_in_background` jobs only, and that files go through the dedicated tools. PowerShell is deferred behind ToolSearch, since Bash covers background jobs. Monitor is loaded up front instead of behind ToolSearch, so following a log does not turn into re-reading it from the shell. |
| System prompt | Adds `# User workflow first` (CLAUDE.md wins, check skills first, run the narrowest check before reporting a code change as done or say it was not run) and `# Tool routing` sections. When a needed tool is not loaded, it tells Claude to search with ToolSearch before falling back to the shell. |
| Skill use | The skill listing header and `# User workflow first` both say: before starting a task, compare it with the listed skills and first call the skills whose descriptions cover it; a keyword match alone is not a reason to call one. Listing descriptions are cut to their first sentence and duplicates dropped. |
| Progress-note language | Extends the `language` instruction to cover the short notes between tool calls. Right after English tool output or a harness notice, Claude tends to write its next short note in English, so every main-session tool result and every notice the harness injects mid-conversation (task completions, messages sent while it works, ...) ends with one sentence: reply in your `language`, or without one, in the language you write in. |
| Reply-language drift check | With `language` set, a main-session reply whose letters are almost all ASCII (code, paths and URLs left out, 20 letters or more) goes to the in-CC small model, which says whether it is written in your `language`. The setting is free-form, so the model reads it. When it is not, the next tool result carries a warning that the last note was off-language, and a toast says so. The check runs alongside the tool, so it adds almost no wait; when it fails, no warning. A final answer with no tool calls is flagged at the next turn's first tool result. Off with `modelJudge`. |
| Shell misuse | Denies viewing, searching, writing and editing files from the shell and points to Read, Grep, Glob, Write and Edit. |
| Command chaining | Off by default. Chained commands run as one call; file viewing, searching and editing inside a chain are still denied. With `blockChaining` on, j-cc denies Bash, PowerShell and exec calls that chain with `&&`, `\|\|` or `;` outside quotes (pipes, background `&` and heredoc bodies are not checked), and the Bash and PowerShell descriptions say so up front. |
| Loops and waits | Denies `tail -f`, endless loops, foreground polling and sleeps, and foreground dev servers, pointing to Monitor, `run_in_background`, `/loop` and `CronCreate`. |
| Shell commands go through exec | Foreground Bash and PowerShell calls are denied with a pointer to `mcp__j-cc__exec` (`shell: "bash"` or `"powershell"`). A foreground shell call returns nothing until it ends, so a command stuck on an unclosed heredoc or a prompt held Claude until its timeout; exec always comes back within 30 seconds. A command still running then stays in the background, and Claude Code notifies Claude when it exits, so Claude goes on with other work instead of waiting. Bash and PowerShell with `run_in_background: true` still run. A `# Shell commands (j-cc)` system-prompt section says this up front. Applies to subagents too, except one whose definition lists its tools with `tools:` and leaves exec out. |
| exec / poll tools | `mcp__j-cc__exec` hands the command to Claude Code's own Bash or PowerShell tool as a background task, so the sandbox, the task list and the completion notification are the same as Bash's. It returns when the command exits or after `yield_time_ms` (default 10s, at most 30s) with the output so far and a `session_id`. `mcp__j-cc__poll` waits for new output (at most 5 minutes per call) or stops the task (`terminate: true`), the way Codex's `exec_command`/`write_stdin` do. When exec or poll has already reported a task's exit, its completion notification is dropped as a duplicate. A hook has a 10-second budget, and waiting on a task counts against it, so exec and poll wait while reading a small tick process they start themselves, which does not count. Nothing to configure: exec follows the Bash/PowerShell permission rules for the same command, poll never asks, j-cc's shell-misuse rules apply, and Git Bash is found on its own (`CLAUDE_CODE_GIT_BASH_PATH` first). |
| Subagent context | When a subagent starts, its task prompt ends with j-cc's rules for it: files go through Read, Grep, Glob, Edit and Write (shell file commands are blocked), one shell command per call when `blockChaining` is on, run commands with exec and poll until they exit, and wait with Monitor for anything run in the background. Forks inherit the parent's context and are left alone; a subagent that did not get the rules at start gets them once on its first shell result. |
| In-CC model judge | Background commands the rules cannot decide are classified by Claude Code's own `$.model` (Haiku), only when the command or the script it runs shows loop, wait or server signals, and cached per command; one judged `endless` is denied. |
| Regression alert | If the shell-first reminder still shows up despite the variable, a toast says so and the paragraph is rewritten as a fallback. |

## Install

```
/plugin marketplace add j-token/j-cc
/plugin install j-cc@j-cc
```

Requires Claude Code 2.1.301 or later (hooks module API).

## Options

| Option | Default | Meaning |
|---|---|---|
| `modelJudge` | `true` | Judge ambiguous commands, bypass reasons and reply-language drift with the in-CC model. Off: deterministic rules only, bypass comments pass unreviewed, and no drift check. |
| `blockChaining` | `false` | Deny calls that chain commands with `&&`, `\|\|` or `;` outside quotes. |

## Bypass

Rerun a wrongly blocked command with a reason comment. The old `# use-right-tool:allow:` marker is accepted too.

```
grep -c MAGIC app.exe # j-cc:allow: the Grep tool skips binary files
```

When a rule would block the command, the in-CC model (Haiku) reads the rule, the command and the reason and decides whether the shell is really needed.
- A vague reason, convenience, or a job the suggested tool can do is denied as `Bypass rejected`, with one sentence naming the tool or approach to use instead.
- Reviews are remembered per command.
- A comment on a command no rule blocks is not reviewed; the result says the comment was not needed. It does not allow foreground Bash.
- With `modelJudge` off, or when the model gives no answer, the comment is trusted as before.

j-cc guides the workflow; it is not a security boundary.

## Limits

- Where an organization manages Claude Code, `prompt.attachment` and `prompt.compose` hooks do not run in plugins a person installs; the shell guards, tool descriptions and the environment variable still work.
- `CLAUDE_CODE_THRIFTY_SONIC` is an undocumented experiment switch and may change; the regression toast tells you when it stops working.
- The rules are approximate.
- Whether a subagent has exec is read from its definition file (`.claude/agents/<name>.md` in the project, then `~/.claude/agents/`). A plugin's agent is assumed to have it.
- exec runs commands through the Bash tool, so the sandbox applies when it is on. That has not been checked with the sandbox actually on: on Windows it is behind a feature flag in 2.1.316. In a subagent, and wherever Claude Code limits background time, a task still running at that limit (10 minutes by default) is stopped, as for Bash `run_in_background`.
- Pressing Esc while exec or poll is waiting has not been checked in an interactive session.
- With `blockChaining` on, chaining detection only tracks quotes, so `;` inside `for …; do …; done` or a PowerShell `{ …; … }` block is denied too; the guidance points to writing such a script to the scratchpad and running the file.
- A chain that mixes a file view with another command (`head f && wc -l f`) passes the file-view rule, which only denies a call made entirely of viewing and searching.
- exec follows the Bash/PowerShell verdict for the same command. When that verdict is `ask`, exec uses the engine's own verdict for exec, so auto mode's classifier decides and an "always allow" choice in default mode is kept. An allow rule for all of exec also runs commands that Bash would have asked about.
- The Bash call exec makes is not checked for permission again; exec's own check, which follows the Bash/PowerShell verdict, is the only gate. Other plugins' Bash hooks do run on it; whether settings.json PreToolUse hooks matched on `Bash`/`PowerShell` do has not been checked. Each call runs with stdin closed, so interactive prompts do not work.

## Development

```
claude plugin validate .
claude plugin test .
```
