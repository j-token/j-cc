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

| Area | What it does |
|---|---|
| Turn bash-first off | Sets `CLAUDE_CODE_THRIFTY_SONIC=0` at session start, unless you set a value yourself. If auto mode's shell-first reminder still shows up, a toast says so and the paragraph is rewritten to point at the dedicated tools. |
| Files through the dedicated tools | Denies viewing, searching, writing and editing files from the shell and points to Read, Grep, Glob, Write and Edit. A wrongly blocked command can be rerun with a reason comment ([Bypass](#bypass)). |
| Shell commands go through exec | Foreground Bash and PowerShell calls are denied with a pointer to `mcp__j-cc__exec`. exec hands the command to Bash or PowerShell as a background task and returns when it exits or after `yield_time_ms` (default 10s, at most 30s) with the output so far. A command still running keeps going, and a notification arrives when it exits. `mcp__j-cc__poll` waits for more output (at most 5 minutes) or stops the task (`terminate: true`). A poll sent with nothing else done since the last report is refused, and at most 16 commands run at once. Bash and PowerShell with `run_in_background: true` still run. |
| Commands that never end | Denies following a stream (`tail -f`, `watch`, `logs -f`, ...), endless loops, and loops that sleep a minute or more per iteration, pointing to Monitor, `/loop` and `CronCreate`. A Bash or PowerShell `run_in_background` command the rules cannot decide, with loop, wait or server signals, is classified by the in-CC model (Haiku) and denied when judged `endless` (`modelJudge`). In a subagent without exec, foreground dev servers, polling loops and sleeps of 5 seconds or more are denied too. |
| Command chaining | Off by default. With `blockChaining` on, calls that chain with `&&`, `\|\|` or `;` outside quotes are denied. |
| Prompt additions | Adds three system-prompt sections: `# User workflow first` (CLAUDE.md wins, check skills first, run the narrowest check before reporting done), `# Tool routing` (search with ToolSearch before falling back to the shell) and `# Shell commands (j-cc)` (how to use exec). The skill listing header says to compare the task with the skills and call a matching one first, but not on a keyword match alone. The Bash and PowerShell descriptions list the rules above. PowerShell is deferred behind ToolSearch, and Monitor is loaded up front. |
| Reply language | Extends the `language` instruction to the short notes between tool calls, and repeats the reply language on main-session tool results, mid-conversation notices and prompts that did not come from you. A reply that is almost all ASCII letters (20 or more, code, paths and URLs left out) goes to the in-CC model, which says whether it is in your `language`. If not, a toast says so and the next tool result or prompt carries a warning (`modelJudge`). |
| Subagents | A subagent's task prompt ends with the rules for file tools, exec and Monitor. A subagent that did not get them at start (forks included) gets them once on its first shell result. An agent whose definition lists `tools:` without exec keeps foreground shell calls. |
| Smaller context | Skill and agent listing descriptions are cut to their first sentence (at most 120 characters) and duplicates dropped. MCP server instructions are capped at 600 characters per server, and a server with 8 or more deferred tools is listed on one line. `total_tokens_reminder` is removed and the Claude in Chrome section is replaced with a short one. A text-file Read without `limit` stops at 500 lines and says how to read the rest; a Grep without `head_limit` returns at most 100 entries. |

## Install

```
/plugin marketplace add j-token/j-cc
/plugin install j-cc@j-cc
```

Requires Claude Code 2.1.301 or later (hooks module API).

## Options

| Option | Default | Meaning |
|---|---|---|
| `modelJudge` | `true` | Judge Bash/PowerShell background commands the rules cannot decide, bypass reasons and reply-language drift with the in-CC model. Off: deterministic rules only, bypass comments pass unreviewed, and no drift check. |
| `blockChaining` | `false` | Deny calls that chain commands with `&&`, `\|\|` or `;` outside quotes. |

## Bypass

Rerun a wrongly blocked command with a reason comment. The old `# use-right-tool:allow:` marker is accepted too.

```
grep -c MAGIC app.exe # j-cc:allow: the Grep tool skips binary files
```

When a rule would block the command, the in-CC model (Haiku) reads the rule, the command and the reason and decides whether the shell is really needed.
- A vague reason, convenience, or a job the suggested tool can do is denied as `Bypass rejected`, with one sentence naming the tool or approach to use instead.
- Reviews are remembered per command.
- A comment on a command no rule blocks is not reviewed; on a Bash or PowerShell call, the result says the comment was not needed. It does not allow foreground Bash.
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
- exec follows the Bash/PowerShell verdict for the same command. When that verdict is `ask`, or a denial because auto mode's classifier gave no verdict for the Bash check, exec uses the engine's own verdict for exec, so auto mode's classifier decides and an "always allow" choice in default mode is kept. An allow rule for all of exec also runs commands that Bash would have asked about.
- The Bash call exec makes is not checked for permission again; exec's own check, which follows the Bash/PowerShell verdict, is the only gate. Other plugins' Bash hooks do run on it; whether settings.json PreToolUse hooks matched on `Bash`/`PowerShell` do has not been checked. Each call runs with stdin closed, so interactive prompts do not work.

## Issues

Bug reports and suggestions are welcome as [GitHub issues](https://github.com/j-token/j-cc/issues). Pull requests are not accepted.

## Development

```
claude plugin validate .
claude plugin test .
```
