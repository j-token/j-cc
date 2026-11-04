# j-cc

A Claude Code plugin that stops Claude from **digging through files with the shell, sitting on long commands, and skipping your instructions**. Runs entirely inside Claude Code: no external model, no API key.

[한국어](README.ko.md)

## Problems it solves

### 1. Shell file reads flood the context

- **Situation:** Claude views and searches files with `cat`, `grep -r` and `find`. Long output pours in, and shell edits cannot be undone with `/rewind`.
- **j-cc:** Denies viewing, searching, writing and editing files from the shell and points to Read, Grep, Glob, Write and Edit. A Read without a range stops at 500 lines; a Grep returns at most 100 entries.
- **Result:** file views per 100 shell calls **8.0 → 3.3**, searches **9.2 → 1.8**

### 2. The session freezes until a test or build finishes

- **Situation:** `npm test` takes 5 minutes, so Claude waits 5 minutes doing nothing.
- **j-cc:** Shell commands run through the `exec` tool. exec returns the output so far within 30 seconds at most while the command keeps running in the background, and a notification arrives when it exits. Claude works on other things meanwhile.
- **Result:** commands holding the session over 60s per 1,000 shell calls **28.6 → 11.5**, wait per shell call **8.8s → 4.5s**

### 3. Commands that never end trap the session

- **Situation:** Claude runs `tail -f` to watch a log, or a loop like `while true; do ...; sleep 60; done`. The command never ends, so neither does the turn.
- **j-cc:** Denies these and points to Monitor for watching logs, and `/loop` or `CronCreate` for repeating work.

### 4. CLAUDE.md and skills are skipped, and "done" comes without a check

- **Situation:** Your CLAUDE.md says "run the tests before committing", yet Claude edits code and reports done without testing. A skill fits the task exactly, but Claude does it by hand.
- **j-cc:** Adds system-prompt rules: your instructions win over defaults, check the skill listing before starting, run the narrowest check before reporting done.
- **Result:** code-editing turns with no check after the last edit **14.5% → 6.7%**

### 5. Short notes slip out of your language

- **Situation:** `language` is set to Korean, but the note right after reading English tool output comes out in English.
- **j-cc:** Repeats the reply language on tool results and mid-conversation notices. When a reply is almost all English, it checks whether that is your `language`; if not, a toast says so and the next turn carries a warning.

> Subagents get the same rules when they start. Long skill and MCP descriptions are cut to save context.

## exec and poll: a shell that doesn't wait

These are j-cc's core tools. Foreground Bash and PowerShell calls are denied, and Claude runs shell commands through these two instead.

| Tool | What it does |
|---|---|
| `exec` | Runs the command in the background and returns within **30 seconds at most** (10 by default). If the command finished, you get the exit code and output; if not, the output so far and a `session_id`. A notification arrives when it exits. |
| `poll` | Waits up to **5 minutes** for more output from a running command and returns as soon as it exits. `terminate: true` stops it; without `session_id` it lists running commands. |

**Example: a test run that takes 3 minutes**

```
exec  "npm test"          → after 10s: output so far + session_id 3   (tests keep running)
Read / Edit ...           → meanwhile, read and edit other files
(notice) session 3 exited → read the result, move on
```

- Claude polls only when it needs the result. A poll repeated with nothing else done in between is refused, so it cannot just sit and wait.
- Up to 16 commands run at once, and output is cut to 20,000 characters by default, keeping the head and tail.
- Each call starts a fresh shell with stdin closed, so commands that wait for input do not work.

## Install

```
/plugin marketplace add j-token/j-cc
/plugin install j-cc@j-cc
```

Requires Claude Code 2.1.301 or later (hooks module API).

j-cc guides the workflow; it is **not a security boundary**.

**If your organization manages Claude Code**, a plugin you install yourself cannot change the system prompt, so only part of j-cc works.

- Works: 1-3 (shell guards, exec, blocking commands that never end), the Read and Grep output caps, the reply-language reminder and drift warning on tool results
- Does not work: the rules in 4 (your instructions first, skills first, check before done), the addition to the `language` instruction, shortening the skill, agent and MCP listings

## Evidence

The numbers above come from 3,581 interactive CLI transcripts from 2026-09-10 to 11-02, comparing Opus main sessions with j-cc (38) and without (120) since 10-16, when j-cc started. Tasks differ between sessions, so not every gap is j-cc's. Method, the full tables and the paper the changes rest on ([arXiv:2609.00006](https://arxiv.org/html/2609.00006v1)): [docs/harness-engineering-evidence.md](docs/harness-engineering-evidence.md).

## Options

| Option | Default | Meaning |
|---|---|---|
| `modelJudge` | `true` | Judge background commands the rules cannot decide, bypass reasons and reply-language drift with the in-CC model (Haiku). Off: deterministic rules only. |
| `blockChaining` | `false` | On: deny calls that chain commands with `&&`, `\|\|` or `;` outside quotes. |

## Bypass

Rerun a wrongly blocked command with a reason comment.

```
grep -c MAGIC app.exe # j-cc:allow: the Grep tool skips binary files
```

<details>
<summary>How bypasses are judged</summary>

- When a rule would block the command, the in-CC model (Haiku) reads the rule, the command and the reason and decides whether the shell is really needed.
- A vague reason, convenience, or a job the suggested tool can do is denied as `Bypass rejected`, with one sentence naming the tool or approach to use instead.
- Reviews are remembered per command.
- A comment on a command no rule blocks is not reviewed; on a Bash or PowerShell call, the result says the comment was not needed. It does not allow foreground Bash.
- With `modelJudge` off, or when the model gives no answer, the comment is trusted.
- The old `# use-right-tool:allow:` marker is accepted too.

</details>

## Details

<details>
<summary>Everything it does, by area</summary>

| Area | What it does |
|---|---|
| Files through the dedicated tools | Denies viewing, searching, writing and editing files from the shell and points to Read, Grep, Glob, Write and Edit. |
| Shell commands go through exec | Foreground Bash and PowerShell calls are denied with a pointer to `mcp__j-cc__exec`. exec hands the command to Bash or PowerShell as a background task and returns when it exits or after `yield_time_ms` (default 10s, at most 30s) with the output so far. A command still running keeps going, and a notification arrives when it exits. `mcp__j-cc__poll` waits for more output (at most 5 minutes) or stops the task (`terminate: true`). A poll sent with nothing else done since the last report is refused, and at most 16 commands run at once. Bash and PowerShell with `run_in_background: true` still run. |
| Commands that never end | Denies following a stream (`tail -f`, `watch`, `logs -f`, ...), endless loops, and loops that sleep a minute or more per iteration, pointing to Monitor, `/loop` and `CronCreate`. A Bash or PowerShell `run_in_background` command the rules cannot decide, with loop, wait or server signals, is classified by the in-CC model (Haiku) and denied when judged `endless` (`modelJudge`). In a subagent without exec, foreground dev servers, polling loops and sleeps of 5 seconds or more are denied too. |
| Command chaining | Off by default. With `blockChaining` on, calls that chain with `&&`, `\|\|` or `;` outside quotes are denied. |
| Prompt additions | Adds three system-prompt sections: `# User workflow first` (CLAUDE.md wins, check skills first, run the narrowest check before reporting done), `# Tool routing` (search with ToolSearch before falling back to the shell) and `# Shell commands (j-cc)` (how to use exec). The skill listing header says to compare the task with the skills and call a matching one first, but not on a keyword match alone. The Bash and PowerShell descriptions list the rules above. PowerShell is deferred behind ToolSearch, and Monitor is loaded up front. |
| Reply language | Extends the `language` instruction to the short notes between tool calls, and repeats the reply language on main-session tool results, mid-conversation notices and prompts that did not come from you. A reply that is almost all ASCII letters (20 or more, code, paths and URLs left out) goes to the in-CC model, which says whether it is in your `language`. If not, a toast says so and the next tool result or prompt carries a warning (`modelJudge`). |
| Subagents | A subagent's task prompt ends with the rules for file tools, exec and Monitor. A subagent that did not get them at start (forks included) gets them once on its first shell result. An agent whose definition lists `tools:` without exec keeps foreground shell calls. Subagents under j-cc still viewed and searched files from the shell 12.7 / 9.4 times per 100 shell calls, 4-5 times the main session; main-session prompt sections are not guaranteed to reach them, hence the separate delivery. |
| Smaller context | Skill and agent listing descriptions are cut to their first sentence (at most 120 characters) and duplicates dropped. MCP server instructions are capped at 600 characters per server, and a server with 8 or more deferred tools is listed on one line. `total_tokens_reminder` is removed and the Claude in Chrome section is replaced with a short one. A text-file Read without `limit` stops at 500 lines and says how to read the rest; a Grep without `head_limit` returns at most 100 entries. |

</details>

## Limits

<details>
<summary>All known limits</summary>

- The rules are approximate.
- Whether a subagent has exec is read from its definition file (`.claude/agents/<name>.md` in the project, then `~/.claude/agents/`). A plugin's agent is assumed to have it.
- exec runs commands through the Bash tool, so the sandbox applies when it is on. That has not been checked with the sandbox actually on: on Windows it is behind a feature flag in 2.1.316. In a subagent, and wherever Claude Code limits background time, a task still running at that limit (10 minutes by default) is stopped, as for Bash `run_in_background`.
- Pressing Esc while exec or poll is waiting has not been checked in an interactive session.
- With `blockChaining` on, chaining detection only tracks quotes, so `;` inside `for …; do …; done` or a PowerShell `{ …; … }` block is denied too; the guidance points to writing such a script to the scratchpad and running the file.
- A chain that mixes a file view with another command (`head f && wc -l f`) passes the file-view rule, which only denies a call made entirely of viewing and searching.
- exec follows the Bash/PowerShell verdict for the same command. When that verdict is `ask`, or a denial because auto mode's classifier gave no verdict for the Bash check, exec uses the engine's own verdict for exec, so auto mode's classifier decides and an "always allow" choice in default mode is kept. An allow rule for all of exec also runs commands that Bash would have asked about.
- The Bash call exec makes is not checked for permission again; exec's own check, which follows the Bash/PowerShell verdict, is the only gate. Other plugins' Bash hooks do run on it; whether settings.json PreToolUse hooks matched on `Bash`/`PowerShell` do has not been checked. Each call runs with stdin closed, so interactive prompts do not work.

</details>

## Issues

Bug reports and suggestions are welcome as [GitHub issues](https://github.com/j-token/j-cc/issues). Pull requests are not accepted.

## Development

```
claude plugin validate .
claude plugin test .
```
