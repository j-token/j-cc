# j-cc

Harness tuning for Claude models in Claude Code, especially Opus 5.5: use the dedicated tools, follow the user's instructions and skills, and stop blocking on long commands. Runs entirely inside Claude Code: no external model, no API key.

[한국어](README.ko.md)

## Why

Findings from Claude Code 2.1.301:

- Claude Code **forces the "bash-first" experiment (`thrifty_sonic`) on for Opus 5.5 only.** With it on:
  - the Bash tool description loses its `IMPORTANT` warning to use the dedicated tools instead of find, grep, cat, head and sed;
  - auto mode adds a reminder saying files can be read with cat/head/sed -n, searched with grep/find and edited with sed or heredocs, "The choice is yours".
- GPT models reached through a proxy are unknown to Claude Code, so the experiment stays off for them, which is why they pick the dedicated tools more often under the same harness.
- 60 days of real transcripts (2,558 files). The GPT sample is small (40 sessions) and its tasks differ, so not every gap is the model's.

| Metric | Opus 5.5 (main) | GPT (main) |
|---|---|---|
| File views / searches per 100 shell calls | 25.9 / 28.9 | 0 / 0.8 |
| Foreground commands over 60s | 434 | 0 |
| Hours blocked in the foreground | 34 | 0.3 |
| Sessions using a Skill | 35.5% | 63.6% |

## What it does

| Feature | How |
|---|---|
| Turn bash-first off | Sets `CLAUDE_CODE_THRIFTY_SONIC=0` at session start. The engine reads this variable first, so nothing depends on matching prompt wording. A value you set yourself is left alone. |
| Tool descriptions | Appends dedicated-tool and `run_in_background` guidance to the Bash and PowerShell descriptions. |
| System prompt | Adds `# User workflow first` (CLAUDE.md wins, check skills first) and `# Tool routing` sections. |
| Progress-note language | Extends the `language` instruction to cover the short notes between tool calls. |
| Shell misuse | Denies viewing, searching, writing and editing files from the shell and points to Read, Grep, Glob, Write and Edit. |
| Loops and waits | Denies `tail -f`, endless loops, foreground polling and sleeps, and foreground dev servers, pointing to Monitor, `run_in_background`, `/loop` and `CronCreate`. |
| Long commands to the background | Installs, Docker builds, training/eval scripts, a `timeout` over 120s, and any command that took 45s or more before run with `run_in_background: true`, with a note to keep working instead of waiting. The note ends by telling Claude to keep replying in your `language` setting. Main session only. A `# Automatic backgrounding (j-cc)` system-prompt section tells Claude about this up front, so it does not run dependent steps before the completion notification. |
| Subagent context | Subagents are never auto-backgrounded, so each subagent's first shell result carries a one-time note: run what you need in the foreground, and if you background something, wait for it with Monitor before you finish. The slow-command note differs for main and subagents too. |
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
| `modelJudge` | `true` | Judge ambiguous commands with the in-CC model. Off: deterministic rules only. |

## Bypass

Rerun a wrongly blocked command with a reason comment. The old `# use-right-tool:allow:` marker is accepted too.

```
grep -rn TODO src # j-cc:allow: need raw byte offsets
```

j-cc guides the workflow; it is not a security boundary.

## Limits

- Where an organization manages Claude Code, `prompt.attachment` and `prompt.compose` hooks do not run in plugins a person installs; the shell guards, tool descriptions, backgrounding and the environment variable still work.
- `CLAUDE_CODE_THRIFTY_SONIC` is an undocumented experiment switch and may change; the regression toast tells you when it stops working.
- The rules are approximate. Durations are remembered per command key (`npm test`, `cargo build`, `python train.py`, ...).

## Development

```
claude plugin validate .
claude plugin test .
```
