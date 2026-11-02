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

- Subagents under j-cc still viewed and searched files from the shell 12.7 / 9.4 times per 100 shell calls, about 4-5 times the main session, and were blocked twice as often. Main-session prompt sections do not reach them, so they now get the rules when they start.

## What it does

| Feature | How |
|---|---|
| Turn bash-first off | Sets `CLAUDE_CODE_THRIFTY_SONIC=0` at session start. The engine reads this variable first, so nothing depends on matching prompt wording. Checked in 2.1.301 and still the same in 2.1.316. A value you set yourself is left alone. |
| Tool descriptions | Appends dedicated-tool and `run_in_background` guidance to the Bash and PowerShell descriptions. |
| System prompt | Adds `# User workflow first` (CLAUDE.md wins, check skills first, run the narrowest check before reporting a code change as done or say it was not run) and `# Tool routing` sections. When a needed tool is not loaded, it tells Claude to search with ToolSearch before falling back to the shell. |
| Skill use | The skill listing header and `# User workflow first` both say: before starting a task, compare it with the listed skills and first call the skills whose descriptions cover it; a keyword match alone is not a reason to call one. Listing descriptions are cut to their first sentence and duplicates dropped. |
| Progress-note language | Extends the `language` instruction to cover the short notes between tool calls. Right after English tool output or a harness notice, Claude tends to write its next short note in English, so every main-session tool result and every notice the harness injects mid-conversation (task completions, messages sent while it works, ...) ends with one sentence: reply in your `language`, or without one, in the language you write in. |
| Reply-language drift check | With `language` set, a main-session reply whose letters are almost all ASCII (code, paths and URLs left out, 20 letters or more) goes to the in-CC small model, which says whether it is written in your `language`. The setting is free-form, so the model reads it. When it is not, the next tool result carries a warning that the last note was off-language, and a toast says so. The check runs alongside the tool, so it adds almost no wait; when it fails, no warning. A final answer with no tool calls is flagged at the next turn's first tool result. Off with `modelJudge`. |
| Shell misuse | Denies viewing, searching, writing and editing files from the shell and points to Read, Grep, Glob, Write and Edit. |
| Command chaining | Denies Bash, PowerShell and exec calls that chain commands with `&&`, `\|\|` or `;` outside quotes and asks for one command per call. Pipes (`\|`), background `&` and heredoc bodies are not checked. The Bash and PowerShell descriptions say so up front, because the stock PowerShell description recommends `cmd1 && cmd2`. Turn it off with `blockChaining`. |
| Loops and waits | Denies `tail -f`, endless loops, foreground polling and sleeps, and foreground dev servers, pointing to Monitor, `run_in_background`, `/loop` and `CronCreate`. |
| Long commands to the background | Installs, Docker builds, training/eval scripts, a `timeout` over 120s, and any command that took 45s or more before run with `run_in_background: true`, with a note to keep working instead of waiting. Main session only. A `# Automatic backgrounding (j-cc)` system-prompt section tells Claude about this up front, so it does not run dependent steps before the completion notification. |
| exec / poll tools | Adds `mcp__j-cc__exec`, which starts a command and returns within 5-8 seconds with the output so far and a `session_id` even while it keeps running, and `mcp__j-cc__poll`, which reads new output or stops it (`terminate: true`), the way Codex's `exec_command`/`write_stdin` do. Nothing to configure: exec follows the Bash/PowerShell permission rules for the same command, poll never asks, j-cc's shell-misuse rules apply, and Git Bash is found on its own (`CLAUDE_CODE_GIT_BASH_PATH` first). |
| Subagent context | When a subagent starts, its task prompt ends with j-cc's rules for it: files go through Read, Grep, Glob, Edit and Write (shell file commands are blocked), one shell command per call when `blockChaining` is on, and, since subagents are never auto-backgrounded, run what you need in the foreground and wait with Monitor for anything you background. Forks inherit the parent's context and are left alone; a subagent that did not get the rules at start gets them once on its first shell result. The slow-command note differs for main and subagents too. |
| In-CC model judge | Commands the rules cannot decide are classified by Claude Code's own `$.model` (Haiku), only when the command or the script it runs shows loop, wait or server signals, and cached per command: `quick`, `long_job`, `wait_poll`, `endless`, `server`. |
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
| `blockChaining` | `true` | Deny calls that chain commands with `&&`, `\|\|` or `;` outside quotes. |

## Bypass

Rerun a wrongly blocked command with a reason comment. The old `# use-right-tool:allow:` marker is accepted too.

```
grep -c MAGIC app.exe # j-cc:allow: the Grep tool skips binary files
```

When a rule would block the command, the in-CC model (Haiku) reads the rule, the command and the reason and decides whether the shell is really needed.
- A vague reason, convenience, or a job the suggested tool can do is denied as `Bypass rejected`, with one sentence naming the tool or approach to use instead.
- Reviews are remembered per command.
- A comment on a command no rule blocks (for example to stay in the foreground) passes without a review.
- With `modelJudge` off, or when the model gives no answer, the comment is trusted as before.

j-cc guides the workflow; it is not a security boundary.

## Limits

- Where an organization manages Claude Code, `prompt.attachment` and `prompt.compose` hooks do not run in plugins a person installs; the shell guards, tool descriptions, backgrounding and the environment variable still work.
- `CLAUDE_CODE_THRIFTY_SONIC` is an undocumented experiment switch and may change; the regression toast tells you when it stops working.
- The rules are approximate. Durations are remembered per command key (`npm test`, `cargo build`, `python train.py`, ...).
- Chaining detection only tracks quotes, so `;` inside `for …; do …; done` or a PowerShell `{ …; … }` block is denied too; the guidance points to writing such a script to the scratchpad and running the file.
- exec follows the Bash/PowerShell verdict for the same command. When that verdict is `ask`, exec uses the engine's own verdict for exec, so auto mode's classifier decides and an "always allow" choice in default mode is kept. An allow rule for all of exec also runs commands that Bash would have asked about.
- exec does not go through settings.json PreToolUse hooks matched on `Bash`/`PowerShell`; only the permission rules and j-cc's guards apply. Each call opens a fresh shell with stdin closed, so interactive prompts do not work.

## Development

```
claude plugin validate .
claude plugin test .
```
