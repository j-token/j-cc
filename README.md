# j-cc

A Claude Code plugin that cuts down how often Claude **reads files with commands, waits on long-running commands, or works without reading your instructions**. It runs entirely inside Claude Code, with no external model or API key.

[한국어](README.ko.md)

## Problems it solves

### 1. Reading files with commands adds unneeded content

Claude views and searches files with commands like `cat`, `grep -r` and `find`. That puts unneeded output into the context, and edits made with commands cannot be undone with `/rewind`.

j-cc denies calls that view, search, write or edit files with commands and points Claude to Read, Grep, Glob, Write and Edit.

- file views per 100 shell calls **8.0 → 3.3**, searches **9.2 → 1.8**

### 2. Commands keep the session stuck

If `npm test` takes 5 minutes, Claude can do nothing else for those 5 minutes.

With j-cc, commands run through the `exec` tool. exec returns the output so far within 30 seconds at most, and the command keeps running in the background. A notification arrives when it ends, so Claude works on other things in the meantime.

- commands holding the session over 60s per 1,000 shell calls **28.6 → 11.5**, wait per shell call **8.8s → 4.5s**

### 3. Commands get stuck in an endless loop

When Claude runs `tail -f` to watch a log, or a loop like `while true; do ...; sleep 60; done`, the command never ends and the session stops with it.

j-cc denies these commands and points Claude to Monitor for logs and to `/loop` or `CronCreate` for repeating work.

### 4. Work is reported done without reading your instructions and skills

Even when CLAUDE.md says "run the tests before committing", Claude reports the work done without running tests. Even when a skill fits the task, Claude does the work by hand instead of using it.

j-cc adds these rules to the system prompt.

1. Your instructions take priority over default behavior
2. Check the skill listing before starting work
3. Run the narrowest check before reporting done

- code-editing turns that ended with no check after the last edit **14.5% → 6.7%**

### 5. Short notes come out in English in a non-English conversation

Even with `language` set to Korean, the short note right after reading English tool output comes out in English.

j-cc repeats the reply language on every tool result and mid-conversation notice. If a reply still comes out almost all in English, the in-CC model judges whether it is in your `language`; if not, a toast says so and the next turn carries a warning.

> Subagents get the same rules when they start. Long agent and MCP descriptions are cut to reduce context; skill descriptions are kept whole, because the "use when" part Claude matches tasks against usually comes after the first sentence.

## Running commands with exec and poll

j-cc denies foreground Bash and PowerShell calls, and Claude runs commands through these two tools instead.

| Tool | What it does |
|---|---|
| `exec` | Runs the command in the background and returns within **30 seconds at most** (10 by default). If the command finished by then, you get the exit code and output; if it is still running, the output so far and a `session_id`. A notification arrives when the command ends. |
| `poll` | Waits at least 5 seconds and up to **5 minutes** for output from a running command and returns as soon as the command ends. `terminate: true` stops it, and calling it without `session_id` lists running commands. |

**Example: a test run that takes 3 minutes**

```
exec  "npm test"         → after 10s: output so far + session_id 3   (tests keep running)
Read / Edit ...          → meanwhile, read and edit other files
(notice) session 3 ended → read the result, move to the next step
```

- poll is used only when the result is needed. Repeating poll with no other work in between is refused.
- If you send a message while exec or poll is waiting, it returns right away with the output so far and Claude reads your message. Claude Code hands a mid-turn message to Claude only when a tool result comes back, so without this the message waited up to 30 seconds behind exec and up to 5 minutes behind poll. The command keeps running. This does not apply to `claude -p`, where the message reaches the hook only after the tool result.
- Up to 16 commands can run at once, and output is cut to 20,000 characters by default, keeping the head and tail.
- Each call starts a fresh shell with stdin closed, so interactive commands that wait for input cannot be used.

## Install

```
/plugin marketplace add j-token/j-cc
/plugin install j-cc@j-cc
```

Requires Claude Code 2.1.326 or later (the hooks module API's `tool.run`). On older versions exec does not run.

j-cc is a tool that helps the workflow; it is **not a security boundary.**

**If your organization manages Claude Code**, a plugin you install yourself cannot change the system prompt or the notices added to the conversation, so only part of j-cc works.

- Works: 1-3 (command blocking, exec, endless-loop blocking), the note on a partial Read, the reply-language reminder on tool results and the language drift warning
- Does not work: the rules in 4 (your instructions first, skills first, check before done), the shorter Claude in Chrome section, the addition to the `language` instruction, the reply-language reminder on mid-conversation notices, dropping duplicate skills and shortening the agent listing, capping MCP instructions and grouping the deferred tool list, removing `total_tokens_reminder`, dropping duplicate completion notices for commands exec already reported

## Evidence

The numbers above come from 3,581 interactive CLI session transcripts from 2026-09-10 to 11-02. They compare Opus main sessions after October 16, when j-cc came into use, split into sessions with j-cc (38) and without (120).

Tasks differ between sessions, so not every difference can be credited to j-cc. The method, full tables and the paper behind the changes ([arXiv:2609.00006](https://arxiv.org/html/2609.00006v1)) are in [docs/harness-engineering-evidence.md](docs/harness-engineering-evidence.md).

## Options

| Option | Default | Description |
|---|---|---|
| `dedicatedTools` | `true` | Denies calls that view, search, write or edit files with commands and points to Read, Grep, Glob, Write and Edit. When off, that blocking and guidance are dropped; waits, endless loops and foreground Bash are still handled. |
| `modelJudge` | `true` | Uses the in-CC model (Haiku) to judge background commands the rules cannot decide, bypass reasons and reply-language drift. When off, only deterministic rules are used. |
| `blockChaining` | `false` | When on, denies calls that chain commands with `&&`, `\|\|` or `;` outside quotes. |
| `timeAwareness` | `true` | Adds the current time to user messages in the main session and, once a minute, to a tool result, so the model works to deadlines like "in 15 minutes". |
| `askAsync` | `false` | When on, adds the `mcp__j-cc__ask_async` tool: Claude puts a question above the prompt and keeps working instead of waiting, and takes your next message as the reply. |

## When a command is wrongly blocked

The rules are not exact, so a command you really need can get blocked. In that case, add a comment giving the reason and run it again. The comment works only on a command a j-cc rule blocks; on any other command j-cc refuses the call and asks for it again without the comment, since auto mode can read an unneeded "allow" comment as an attempt to get around a check.

```
grep -c MAGIC app.exe # j-cc:allow: the Grep tool does not search inside binary files
```

<details>
<summary>How bypasses are judged</summary>

- If a rule would have blocked a command that carries the comment, the in-CC model (Haiku) reads the rule, the command and the reason and judges whether the command is really needed.
- A vague reason, convenience, or a job the suggested tool can do is denied as `Bypass rejected`, with one sentence naming the tool or approach to use instead.
- Judgments are remembered per command.
- A command no rule blocks is not reviewed. On a Bash or PowerShell call, the result says the comment was not needed. The comment does not allow foreground Bash.
- With `modelJudge` off, or when the model gives no answer, the comment is trusted and the command passes.
- The old plugin marker `# use-right-tool:allow:` is recognized too.

</details>

## Details

<details>
<summary>Everything it does, by area</summary>

| Area | What it does |
|---|---|
| Files through the dedicated tools | Denies calls that view, search, write or edit files with commands and points to Read, Grep, Glob, Write and Edit. |
| Commands through exec | Denies foreground Bash and PowerShell calls and points to `mcp__j-cc__exec`. exec hands the command to Bash or PowerShell as a background task and returns the output so far when the command ends or `yield_time_ms` (default 10s, at most 30s) passes. A command that has not ended keeps running, and a notification arrives when it ends. `mcp__j-cc__poll` waits for more output (at least 5 seconds, at most 5 minutes) or stops the task with `terminate: true`. A poll called with no other work since the last report is refused. Up to 16 commands can run at once. Bash and PowerShell with `run_in_background: true` run as is. |
| Endless-loop blocking | Denies following a stream (`tail -f`, `watch`, `logs -f`, ...), endless loops, and loops that wait a minute or more per iteration, pointing to Monitor, `/loop` and `CronCreate`. A Bash or PowerShell `run_in_background` command the rules cannot decide that shows loop, wait or server signals is judged by the in-CC model (Haiku) and denied when judged `endless` (`modelJudge`). In the foreground shell of a subagent without exec, dev servers, polling loops and waits of 5 seconds or more are denied too. |
| Command chaining | Not blocked by default. With `blockChaining` on, calls that chain with `&&`, `\|\|` or `;` outside quotes are denied. |
| Time awareness | Adds the local time with its UTC offset to every main-session prompt, as in `[j-cc] Current time: 2026-11-21T14:00:00+09:00 (Saturday).` A tool result gets it once a minute has passed since the last note, along with the time since the user's last message. Only one of a set of parallel tool calls gets it, and subagents do not. The `# Time (j-cc)` system prompt section says to turn relative deadlines into absolute times and, near a deadline, to wrap up with what is in hand instead of starting new work (`timeAwareness`). |
| Asking without waiting | A question asked with `mcp__j-cc__ask_async` is shown in full in the band above the prompt, and in short in the status line, the transcript and an OS notification, and the call returns at once, so Claude keeps working on what does not depend on the answer. Pressing a choice in the band puts it in the prompt without sending it, so you can edit it first. A message you send while the question is open is marked as a possible reply to question qN, and the question closes. A message sent mid-turn arrives with the next tool result and cuts exec and poll waits. With no reply within the time Claude set (`reply_within_minutes`, default 5, at most 120), the next tool result says the question expired so Claude goes on with an assumption. One question is open at a time, and subagents cannot use it. Off by default; turn on `askAsync` to use it. |
| Prompt additions | Adds three sections to the system prompt (four with `timeAwareness` on, counting `# Time (j-cc)` above). `# User workflow first` covers CLAUDE.md priority, checking skills first and running the narrowest check before reporting done. `# Tool routing` says to search with ToolSearch before falling back to the shell when a needed tool is missing, and `# Shell commands (j-cc)` explains how to use exec. The skill listing header gets the rule "compare the task with the listing before starting, call a skill that covers the task or any step of it before anything else, and load it when unsure." The end of the Bash and PowerShell descriptions lists the blocking rules above. PowerShell is deferred behind ToolSearch, and Monitor is loaded from the start. |
| Reply language | Adds that the `language` setting also applies to short notes between tool calls. Repeats the reply language on main-session tool results, mid-conversation notices and prompts you did not send. If a reply is almost all ASCII letters (20 or more, leaving out code, paths and URLs), the in-CC model judges whether it is in your `language`. If it judges not, a toast says so and the next tool result or prompt carries a warning (`modelJudge`). |
| Subagents | When a subagent starts, the rules for file tools, parallel lookups, exec and Monitor are appended to its task. 71% of subagent requests called a single tool, so it is told to send independent lookups together in one message. A subagent that did not get the rules this way (forks included) gets them once on its first shell result. An agent whose definition file lists `tools:` without exec does not have its foreground shell blocked. Even in sessions using j-cc, subagents viewed and searched files with commands 12.7 / 9.4 times per 100 shell calls (4-5 times the main session). There is no guarantee the main system prompt reaches subagents, so the rules are delivered separately. |
| Context reduction | Cuts agent listing descriptions to their first sentence (at most 120 characters) and drops duplicate agents and skills. Skill descriptions stay whole, multi-line `TRIGGER` lines included: with only the first sentence, Claude missed a skill whose "use when" part came after it ([docs/skill-listing.md](docs/skill-listing.md)). MCP server instructions are cut at 600 characters per server, and an MCP server with 8 or more tools has its deferred tool list collapsed into one line. Removes `total_tokens_reminder` and replaces the Claude in Chrome section with a short version. When a Read stops before the end of a file, it says how to read the rest. j-cc does not add a default `limit` to Read or `head_limit` to Grep: auto mode drops its verdicts for the other calls in a response once a hook changes one call's input ([docs/auto-mode-blocks.md](docs/auto-mode-blocks.md)). |

</details>

## Limits

<details>
<summary>All known limits</summary>

- The rules are not exact, so they can block a command that is needed or miss one that should be blocked.
- Whether a subagent has exec is read from its definition file: the project's `.claude/agents/<name>.md` first, then `~/.claude/agents/`. Plugin agents are assumed to have exec.
- exec runs commands through the Bash tool, so the sandbox should apply when it is on, but this has not been checked with the sandbox on. In 2.1.316 the Windows sandbox is behind a feature flag. Wherever Claude Code limits background time, as in subagents, a task that has not ended by that limit (10 minutes by default) is stopped, the same as Bash `run_in_background`.
- Pressing Esc while exec or poll is waiting has not been checked in an interactive session.
- With `blockChaining` on, chaining detection only looks at quotes, so `;` inside `for …; do …; done` or a PowerShell `{ …; … }` block is denied too. The guidance points to writing such a script to a file in the scratchpad and running that file.
- A chain of a file view and another command (`head f && wc -l f`) is not caught by the file-view rule. That rule only denies a call made entirely of viewing and searching.
- The time zone is the system time zone the mod runtime knows. Claude Code has no time-zone API, so a runtime running in UTC prints `+00:00` (the absolute time is still right). The time is not refreshed while the model thinks for a long stretch without tool results.
- `ask_async` marks any message you send while a question is open as a possible reply, whatever it says; Claude decides whether it answers the question. Expiry is checked only when a tool result comes back, so it is not reported while Claude calls no tools.
- exec's permission follows the Bash/PowerShell verdict for the same command. When that verdict is `ask`, or the call was denied because auto mode's classifier gave no Bash verdict, the engine's own verdict for exec is used as is. So in auto mode the classifier decides, and choosing "always allow" in default mode leaves that rule in place. Adding all of exec to an allow rule also runs, without asking, commands Bash would have asked about.
- The Bash call exec makes is not checked for permission again. exec's own check, which follows the Bash/PowerShell verdict for the same command, is the only gate. Other plugins' Bash hooks apply to this call too. Whether `Bash`/`PowerShell` PreToolUse hooks in settings.json apply has not been checked. Commands run with stdin closed, so interactive prompts cannot be used.
- j-cc does not work together with [Code Mode](https://code.claude.com/docs/en/code-mode). Code Mode does not turn on while a mod that checks tool calls is installed, and j-cc works through `tool.call` hooks. Starting with j-cc on and `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1` opens the session with the ordinary tools and no Code Mode (checked on 2.1.325). To use Code Mode, turn j-cc off.

</details>

## Issues

Bug reports and suggestions go to [GitHub issues](https://github.com/j-token/j-cc/issues). Pull requests are not accepted.

## Development

```
claude plugin validate .
claude plugin test .
```
