# akm-claude

Claude Code plugin for [AKM](https://github.com/itlackey/akm) 0.10.261111 or newer. It provides an AKM skill, five slash commands, and lifecycle hooks that curate context and learn from concept usage.

The AKM skill also supports delegating work to an AKM agent through Claude's
existing Bash tool. It invokes `akm agent` directly; it does not use MCP,
generated Claude agent definitions, or hooks that intercept Claude's native
`Agent` tool. See `skills/akm/SKILL.md` for the dispatch contract.

## Installation

```sh
/plugin marketplace add itlackey/akm-plugins
/plugin install akm
```

Or use the Claude CLI:

```sh
claude plugin marketplace add itlackey/akm-plugins
claude plugin install akm@akm-plugins
```

For the prerelease channel add the marketplace from the `next` branch instead: `claude plugin marketplace add itlackey/akm-plugins@next` (or `"ref": "next"` and `"autoUpdate": true` in the `akm-plugins` entry of `extraKnownMarketplaces`; see the [repo README](../README.md#updating)). The default branch is stable. Run `/reload-plugins` in a running session after an update.

The hooks require Bun 1.0 or newer on `PATH`. AKM must also be installed, available on `PATH`, and be `0.10.261111` or newer (the plugins pass `--project` and run akm in the session's directory, which older builds do not support). Only an akm below that minimum is refused; any later release, including a later minor such as 0.11, passes, and the check compares `major.minor.patch` only, so `0.10.261111-beta` and `0.10.261102-rc` pass. The session-start hook reports a degraded status when either dependency is unavailable (for a too-old akm it names the installed version, the minimum and the upgrade command, turns the hook-driven features off, and does not forbid running `akm` yourself) and does not install software automatically. Claude Code must be 2.1.139 or newer, the first release that can start a hook without a shell (see [Windows](#windows) for why that matters). On Windows, neither Git for Windows nor WSL is needed.

## Slash Commands

| Command | Description |
| --- | --- |
| `/akm-search [query] [flags]` | Search configured bundles or registries; omit the query to browse. |
| `/akm-show <ref> [context flags]` | Show a concept; opaque search fragments are exact by default and support bounded indexed-safe lead context. |
| `/akm-curate <task>` | Curate ranked concepts and pack selected local assets' full content into one 8,000-token response. |
| `/akm-feedback <ref> <+\|-> [note]` | Record positive or negative feedback. Negative feedback requires a note. |
| `/akm-remember [name]` | Distill durable knowledge from the conversation into a memory. |

AKM references use `[bundle//]conceptId[#fragment]`, for example `skills/code-review`, `memories/release-retro`, or `team-playbook//knowledge/deploy#Rollback`. Search flags use current source names: `--from local`, `--from registry`, `--from all`, or `--from <bundle-name>`.

`/akm-show` accepts `--context exact|lead` plus one of `--max-tokens N` or
`--max-chars N`. `exact` is backward-compatible and remains the default.
For an opaque fragment ref returned by search, `lead` returns the indexed-safe
first fragment followed by an explicitly labelled selected match, bounded to
3,200 characters unless overridden. Friendly authored heading selectors retain
their existing source-live behavior.

The commands take their input as "the text the user gave with the command", never through a `$ARGUMENTS` placeholder. Claude Code appends that text as an `ARGUMENTS:` line when no placeholder in a command receives it, and Codex, which converts a plugin's commands into skills when it installs the plugin, skips any command that has a placeholder ([Codex](#codex)).

## Lifecycle Hooks

Hooks are non-blocking and keep local, redacted state for feedback and memory capture.

| Event | Behavior |
| --- | --- |
| `SessionStart` | Verifies Bun and AKM availability, warms AKM data, and injects the AKM discovery guidance plus pending proposals, active workflows, the project's rules and most-used assets (at a start, a clear and after a compaction; [details](#session-rules-and-most-used-assets)), and curated context when available. Surfaces a missing bundle or a failed previous extraction to both the model and the user. |
| `UserPromptSubmit` | Curates substantive prompts and supplies the result as additional context. It also captures explicit memories, corrections, guardrails, preferences, and positive feedback. High-confidence durable signals are authored asynchronously with `akm proposal new`; repeated task intent across distinct sessions can produce a skill proposal. Retrospective praise still credits concepts the session recently touched. Only text you typed counts: subagent hand-backs, cross-session messages, task notifications, the post-compaction continuation and, under Codex, a prompt a subagent received are never recorded as intent, learned from, or read as praise. A harness block such as `<system-reminder>` in front of what you typed is set aside, and the rest is the prompt. |
| `UserPromptExpansion` | Records use of the five AKM slash commands. |
| `PostToolUse` / `PostToolUseFailure` | Records tool observations. A successful `akm` command that used a concept also submits deduplicated positive feedback for eligible concepts; a failed one submits nothing and logs a warning naming its concepts, which are not remembered as used, so later praise does not credit them. |
| `PostToolBatch` | Adds a compact batch observation to local session state. |
| `SubagentStart` | Injects concise AKM context for the subagent. |
| `TaskCreated` / `TaskCompleted` | Records task lifecycle summaries for later memory extraction. |
| `PostCompact` | Preserves a compacted-session observation for later recall. (A compaction also fires `SessionStart` with source `compact`, which reloads the rules and most-used assets.) |
| `SessionEnd` | Refreshes the local AKM index and starts non-blocking session extraction. |

The plugin registers no `PreToolUse` hooks: nothing it does needs to run before a tool, and the `PostToolUse` pass records strictly more about the same call.

Hook processing never prints secret values. Automatic feedback skips references that AKM reports as ineligible, and a *successful* read-only `akm show` / `search` / `curate` submits nothing — inspecting a concept is not evidence that it helped. A *failed* `akm` command (non-zero exit or timeout) submits nothing either: a failed akm command is not feedback on the asset, and `PostToolUseFailure` only records the observation and logs a warning (`akm_tool_failed` in `session.log`) naming the concepts the command touched and the error. The OpenCode plugin applies the same rules to its `akm_show` / `akm_search` / `akm_curate` tools, so the same action lands the same way on either harness. Only concept IDs are credited, not file paths (`tasks/x.yml`, `skills/x/SKILL.md` and the files inside a skill are not refs), and a ref whose `akm show` lookup comes back empty (not indexed yet, ambiguous, unknown bundle) or without a `ref` (a file akm only reads off disk, such as `scripts/x.html`) is skipped.

### Session rules and most-used assets

At session start, and again after each compaction, the `SessionStart` hook puts two sections into the model's context, ahead of the curated results: the project's **rules** (every applicable `rules/` asset, in full, under its ref), then an ordered list of the project's **most-used assets** (ref and description only; counts and ranking stay inside akm). Both come from the public `akm` CLI (`akm search "" --type rule`, `akm show <ref>`, `akm search --by-usage`); the plugin keeps no popularity store and opens no database. They need an akm that has them (akm#1512); on an older one the lookups fail, are logged, and the session carries on without the sections.

- **Which project.** The session's directory selects the project through akm's `projects` config, as for every other call. With no project, both sections read only your default bundle (`--project none --from <defaultBundle>`), with no selection filters or preferences; with no default bundle configured, `--project none` alone.
- **When.** `SessionStart` with source `startup`, `clear` or `compact` (a missing source counts as a start). A `resume` or `fork` does not reload: the transcript still holds them. Duplicate callbacks for the same event within 10 seconds load once. Ordinary prompts never reload.
- **Codex.** The same hook runs under Codex, whose manifest is unchanged (a changed hook command asks every user to trust it again). Codex fires `SessionStart` with source `compact` after a compaction, so the reload needs no separate hook.
- **Budget.** The 4000-character context budget covers the whole `SessionStart` context. The sections take what the primer, warnings, pending proposals and workflows before them leave, rule text first. A rule is shown whole or left out; if rules are left out (or akm's listing was cut at 200), the section ends with a note saying how many and how to list them. The most-used list names at most 10 assets and says when it was cut or left out to fit. A project with rules and no usage history gets its rules and no list.
- **What counts as use.** akm counts `akm show` events by a user in the last 90 days, per project; search and curate results do not count. The plugin runs its own reads with `AKM_EVENT_SOURCE=unknown`, so loading the sections never raises their own ranking. Events recorded before akm attributed a project count for no project.
- **Prompt-time curation** is unchanged and independent of this load.

### Automatic learning proposals

The prompt hook uses a conservative local classifier as a fast first pass. Explicit `remember:` requests, durable preferences, guardrails, and corrections above the confidence floor are redacted, deduplicated per project, then sent to a detached proposal-authoring worker. The worker submits an `instruction` or `memory` through `akm proposal new`; it never edits `CLAUDE.md`, `AGENTS.md`, rules, commands, or project files. AKM's normal proposal commands own review, acceptance, rejection, and later improvement. Proposal authoring requires the AKM agent profile configured by `akm setup`; failures are retained in the proposal ledger and worker log. Learning is akm's own switch, `akm setup --learning on|off` (`improve.enabled` in `config.json`), on this host and for all bundles; the plugin reads it and never changes it: while it is off, nothing is captured, no proposal is authored and no session is extracted.

Positive feedback is retained as evidence and continues to drive feedback for recently used assets, but praise by itself does not create a content-free proposal. Separately, short task intents are compared within the project. A similar intent must occur in at least three distinct sessions before the plugin submits a cross-platform `skill` proposal. Exact and near-duplicate submissions are suppressed by the durable ledger under the plugin state directory.

## Codex

The same directory is also a Codex plugin: `.codex-plugin/plugin.json` is its Codex manifest, and the repo's `.agents/plugins/marketplace.json` lists it.

```sh
codex plugin marketplace add itlackey/akm-plugins
codex plugin add akm@akm-plugins
```

For the prerelease channel, add the marketplace with `--ref next`: `codex plugin marketplace add itlackey/akm-plugins --ref next`.

Bun 1.0 or newer and AKM 0.10.261111 or newer must be on `PATH`, as [above](#installation); nothing installs them for you. Codex skips plugin hooks until you review and trust them: run `/hooks` in the Codex CLI and trust the two AKM hooks. Codex asks again when a plugin update changes a hook.

Codex gets:

- the AKM skill, which drives the `akm` CLI;
- the five commands, as skills. Codex converts a plugin's `commands/*.md` into skills when it installs the plugin; they are listed as `akm:source-command-akm-search` and so on (type `$` or run `/skills` to pick one). It skips a command that has a `$ARGUMENTS` or `$1` placeholder, so the commands take their input as the text the user gave with them: in Codex that is the request, in Claude Code an `ARGUMENTS:` line it appends to the command;
- the `SessionStart` hook (`session-start`): checks Bun and AKM, warms AKM data, and injects the AKM primer with pending proposals, active workflows, the project's rules and most-used assets and curated context when available. It tells you and the model when AKM or its bundle is missing;
- the `UserPromptSubmit` hook (`curate-prompt`): curates substantive prompts and adds the result as context. It also captures explicit memories, corrections, guardrails and preferences, which become reviewable proposals ([Automatic learning proposals](#automatic-learning-proposals)).

On macOS and Linux the hooks go through `hooks/akm-hook.sh`; on Windows each hook's `commandWindows` runs `hooks/akm-hook.ts` directly (see [Windows](#windows)).

**No tool feedback.** Codex's `PostToolUse` gives a Bash command's output but no exit status, and it has no failure event, so a failed `akm` command cannot be told from a successful one. The Codex manifest registers no `PostToolUse` hook (nor any other hook of the Lifecycle Hooks table), and the hook submits no feedback under Codex whatever `plugins.autoFeedback` says: nothing is recorded as used, and no feedback is sent, neither after a tool call nor for a "that worked". Record feedback yourself, with `akm feedback` or the `akm-feedback` command.

**Updates.** Codex updates the plugin by itself every time it starts; `codex plugin marketplace upgrade akm-plugins` does it on demand. A release that changes a hook's command shows that hook as modified in `/hooks`, and it does not run until you trust it again.

On macOS and Linux each hook's command starts with `[ -f "${PLUGIN_ROOT}/hooks/akm-hook.sh" ] || exit 0;`. In Codex 0.147 the start-up marketplace upgrade runs while the first session after a plugin release is being created: that session starts with the previous version's absolute hook path, and the upgrade then deletes that version's directory. `sh` on the missing script exits 2, which Codex counts as a block (`SessionStart` Failed, and the first prompt Blocked and never sent). With the guard that session simply runs without the AKM hooks. Codex 0.159 refreshes its hook runtime after the upgrade and is not affected. The guard protects the upgrade *from* a release that has it, so an install that predates the guard still hits the race once more. Windows has no guard: `bun` on a missing script exits 1, which Codex reports as Failed, not Blocked.

Codex reads the same `plugins` section of akm's `config.json` as every other build ([Settings](#settings)). The Codex hooks keep their state in Codex's plugin data directory (`$CODEX_HOME/plugins/data/akm-akm-plugins`, normally under `~/.codex`) and label their records `codex`, so Codex's state stays out of `$XDG_STATE_HOME/akm-claude`. Both platforms' commands pass `--harness=codex`; the hook takes the directory from the `PLUGIN_DATA` variable Codex exports to it. The files listed under Troubleshooting appear in that directory.

**Blocking destructive commands.** No hook gates `akm` commands ([Locking down destructive commands](#locking-down-destructive-commands)); Codex's own rules do. A `prefix_rule` in `~/.codex/rules/default.rules` matches the start of a command and either asks first (`prompt`) or refuses it (`forbidden`, with the justification shown to the model):

```python
prefix_rule(
    pattern = ["akm", "proposal", "accept"],
    decision = "prompt",
    justification = "Accepting a proposal changes the bundle",
)

prefix_rule(
    pattern = ["akm", ["remove", "upgrade"]],
    decision = "forbidden",
    justification = "Run this yourself, outside the session",
)
```

Try one with `codex execpolicy check --pretty --rules ~/.codex/rules/default.rules -- akm remove skills/old`. A pattern matches the command's leading words only: `["akm", "sync", "--push"]` matches `akm sync --push -m msg` but not `akm sync -m msg --push`.

CI installs the real Codex on Linux and on Windows and runs `tests/real-hosts.test.ts` against it ([What was tested on Windows](#what-was-tested-on-windows)).

## Windows

The hooks run on native Windows for both hosts, with or without Git for Windows. WSL is not needed.

| | Claude Code | Codex |
| --- | --- | --- |
| Needs | Claude Code 2.1.139 or newer, and `bun.exe` on `PATH` | A Codex that honours `commandWindows` (it has since May 2026), and `bun.exe` on `PATH` |
| How a hook starts | Exec form: Claude Code spawns `bun` with `${CLAUDE_PLUGIN_ROOT}/hooks/akm-hook.ts <mode>` as its arguments. No shell is involved, so Git Bash, PowerShell and cmd.exe make no difference, and a shell profile that prints something cannot corrupt the hook's JSON | The manifest's `commandWindows`, which Codex hands to `pwsh` (else `powershell.exe`; `cmd.exe` when it knows no shell): `bun "<plugin root>/hooks/akm-hook.ts" <mode> --harness=codex` |
| State | `%USERPROFILE%\.local\state\akm-claude` | The plugin data directory Codex exports as `PLUGIN_DATA` |

What differs from macOS and Linux:

- `bun` has to be a real `bun.exe` (the Bun installer, winget or scoop). Claude Code cannot start the `bun.cmd` shim that installing Bun with npm leaves behind, because it spawns the program without a shell.
- akm may be npm's `akm.cmd` or Bun's `akm.exe`. The hook searches `PATH` for `.com`, `.exe`, `.bat` and `.cmd` in `PATHEXT` order, and never takes the extensionless `akm` shell script npm leaves beside `akm.cmd`. A `.cmd` is run through `cmd.exe`, which re-parses its command line, so `"`, `%`, `&`, `|`, `<`, `>`, `^` and line breaks in what the hook passes akm (the curate query is your prompt) become spaces first.
- There is no friendly "Bun is not installed" message. `hooks/akm-hook.sh` used to answer once at session start when `bun` was missing; now only Codex's macOS and Linux command goes through it (it names Codex when it answers). Claude Code's hooks are exec form on every platform, so there is no wrapper to degrade through, and without `bun` the host reports a failed hook on each event until Bun is installed (for Codex on Windows, PowerShell's "bun is not recognized").
- Every akm call goes through a small `bun` runner (`hooks/akm-run.ts`) rather than being started by the hook itself. `akm.cmd` is `cmd.exe` starting `node` starting `bun`, and a spawn's own timeout would end only the `cmd.exe` and leave the rest running, so the runner owns the timeout and, when it expires, ends akm's whole process tree with `taskkill /T /F`. `akm index` and the session-end extraction run the runner detached, with the log files as its output, because a Windows child that is not detached is killed when the process that started it exits and a detached `cmd.exe` loses its redirected output.
- The state directory's mode is not restricted: Windows has no POSIX modes, and the files inherit the permissions of your profile directory.

### What was tested on Windows

`.github/workflows/tests.yml` runs a `windows` job on `windows-latest` for every pull request and every push to `main`. It runs:

- the hook tests, with Git for Windows off `PATH`. Claude's exec-form handlers run the way Claude Code runs them; Codex's `commandWindows` runs through `pwsh`, Windows PowerShell 5.1 and `cmd.exe /C`, and with a PowerShell console code page of 932; each against a fake akm that is `akm.cmd`, and once against the `akm-cli` the OpenCode packages pin, as npm itself installs it;
- the real Claude Code (2.1.286) and the real Codex (0.160.0), installed from npm and started with no credential. `claude -p` registers the manifest's 23 handlers and runs SessionStart, UserPromptSubmit and SessionEnd through exec form before it stops at "Not logged in". `codex exec` runs the two hooks, with the plugin installed from the checkout and trusted the way `/hooks` does, before its model provider, a dead local port, refuses the request.

Tests that write their fake akm as a POSIX `sh` script, assert POSIX mode bits or run `akm-hook.sh` are skipped there by name (`[skipped on Windows: ...]`): `tests/host-runtime.ts` explains why, and `tests/hook-commands.test.ts` and `tests/codex-plugin.test.ts` run the same hook modes against the Windows-capable fake.

CI runs one Windows image (`windows-latest`, Bun's latest release), `claude -p` rather than Claude Code's interactive or desktop modes, and the runner's own locale and console code page. Windows 10 and Server images, ARM, and other Bun versions are not exercised. That `bun.cmd` cannot be started by Claude Code's exec form is Claude Code's documented behavior (`https://code.claude.com/docs/en/hooks#exec-form-and-shell-form`), not something CI checks.

## Locking down destructive commands

The plugin does not gate destructive `akm` commands, and no hook inspects a Bash invocation to decide whether to block it. That gate was removed in 0.8.0: tokenized matching produced false positives on commit messages, heredoc bodies, and any other prose containing an `akm <verb>` substring, and deciding which shell calls to allow is the host platform's job, not a plugin's.

Use Claude Code's own permission rules in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "ask": ["Bash(akm proposal accept *)", "Bash(akm sync --push *)"],
    "deny": ["Bash(akm remove *)", "Bash(akm config set *)"]
  }
}
```

Independently of any permission rule, the AKM skill instructs the agent to get explicit user approval before invoking a destructive verb — `proposal accept`, `proposal reject`, `proposal revert`, `sync --push`, `remove`, env/secret writes, `task add` / `task run`, `upgrade`, `update --all`, `config set`.

## Settings

The plugin has no settings of its own and no environment variables for them. Its settings are the `plugins` section of akm's own `config.json` (the file `akm config` edits: `AKM_CONFIG_DIR`, else `$XDG_CONFIG_HOME/akm`, else `~/.config/akm`; `%APPDATA%\akm` on Windows). The hooks read that file directly; no `akm` process is started for it. The Claude Code `/plugin` configuration dialog is gone, and Codex and the two OpenCode plugins read the same file. Every key is optional:

```jsonc
{
  "plugins": {
    "autoFeedback": true,          // automatic feedback, "that worked" included. Always off under Codex.
    "indexOnSessionEnd": true,     // `akm index` at session end; false on CI runners and low-power machines
    "curateLimit": 5,              // curated results per prompt or session, 1 to 25
    "curateTimeoutSeconds": 8,     // how long a hook waits for `akm`. The `akm --version` probe has its own fixed cap (3 s, 10 s on Windows).
    "pendingProposalTimeoutSeconds": 2,
    "redact": { "pii": false, "highEntropy": false }
  }
}
```

Background learning (capturing corrections and preferences, and the `proposal extract` at session end) is akm's own switch, `improve.enabled`: `akm setup --learning off` turns it off for the whole host, `akm setup --learning on` back on.

A wrong value is ignored with a warning (the default applies): one line in `session.log` and in the `SessionStart` message. A config file that does not parse leaves every setting at its default. `akm config set plugins.curateLimit 8` writes a key.

**Redaction cannot silently turn off.** `redact.pii` (credit-card-shaped digit runs, US SSNs, phone numbers) and `redact.highEntropy` (long base64/hex-shaped strings, 32 characters or more) are off when the key is absent, because both over-redact ordinary logs. An explicit `false` turns one off. A value that is not `true` or `false`, or a config file that exists but cannot be read, leaves redaction **on** and says so. The retired `AKM_REDACT_PII` and `AKM_REDACT_HIGH_ENTROPY` variables are not settings any more, but while one is set and its config key is absent that redaction stays on, with a warning to set the key: moving to the config file never drops redaction.

The other variables the plugin reads are not settings:

| Variable | Purpose |
| --- | --- |
| `AKM_CONFIG_DIR` | Where akm's `config.json` is (akm's own location variable). |
| `AKM_BUNDLE_DIR` | The AKM bundle root (akm's own variable). Set it when you can: without it the hooks discover the bundle by spawning `akm info`, which adds a subprocess to every file-tool hook that sees a concept-like token. |
| `AKM_LOCAL_BUILD_CLI` | Absolute path to a locally built AKM CLI entry point. |
| `AKM_PACKAGE_REF` | Package specification shown when AKM is unavailable (`akm-cli@>=0.10.261111-0`). It is never installed automatically. |

The retired setting variables (`AKM_AUTO_FEEDBACK`, `AKM_INDEX_ON_SESSION_END`, `AKM_CURATE_LIMIT`, `AKM_CURATE_TIMEOUT`, `AKM_PENDING_PROPOSAL_TIMEOUT`, `AKM_AUTO_LEARNING`, `AKM_AUTO_MEMORY`) are ignored, and a warning names the key that replaces each. Everything else that used to be a variable is a constant now: prompt curation is always on; the curate score floor and `--type` filter are gone; the context budget is 4000 characters; state files are capped at 1 MiB; the cached quality classification lives 24 hours; automatic feedback needs a classifier confidence of 0.6, a learning proposal 0.75 and a skill proposal three distinct sessions; the proposal worker is capped at 10 minutes; the retrospective vocabulary is fixed.

Hooks keep their state under `$XDG_STATE_HOME/akm-claude` (`~/.local/state/akm-claude`; `%USERPROFILE%\.local\state\akm-claude` on Windows), and under Codex in its plugin data directory (`PLUGIN_DATA`), labelled `codex` by the `--harness=codex` flag in the Codex manifest's commands.

### Scope

Every `akm` call a hook makes runs in the session's directory (`CLAUDE_PROJECT_DIR` when set, otherwise the hook payload's `cwd`), so akm resolves the user's project from the `projects` entry in its own config. The plugin's lifecycle records in `events.jsonl` carry the session ID and the project.

## Troubleshooting

Hooks never write diagnostics to stderr. The few failures only you can fix — AKM missing, no bundle configured, the last memory extraction failed — travel through the hook protocol's `systemMessage` field, so Claude Code shows them to you at session start. Everything else lands in the state directory (`$XDG_STATE_HOME/akm-claude` by default), owner-only and size-capped:

| File | Contents |
| --- | --- |
| `session.log` | Hook lifecycle: AKM readiness, version mismatches, subprocess failures, session-end extraction attempts, and a warning for each failed `akm` command that touched a concept. |
| `extract.log` | Output of the detached `akm proposal extract` run at session end. Check here first if durable memories never appear — a fresh install without a configured LLM profile logs `LLM_NOT_CONFIGURED`, which `akm setup` resolves. You should not have to go looking: when the newest run in this file failed, or ran but harvested nothing (e.g. an unreachable LLM engine), the next session start reports it and prints this file's absolute path. |
| `index.log` | Output of the detached `akm index` refresh run at session end. Check here if search results go stale. |
| `learning-signals.jsonl` | Redacted prompt signals captured by the hot-path classifier. |
| `learning-proposals.jsonl` / `learning-proposals.log` | Durable dedupe/status ledger and bounded worker outcomes for automatic proposals. |
| `workflow-observations.jsonl` | Redacted task-intent observations used to require recurrence across distinct sessions before proposing a skill. |
| `feedback.log` / `memory.log` | Automatic feedback decisions, the outcome of each `akm` command (a failure is logged here, never submitted as feedback), and observed concept IDs. |
| `events.jsonl` | Structured, redacted lifecycle events. |

## Recommended Flow

1. Use `/akm-curate` for task-oriented discovery.
2. Use `/akm-search` when you need an exact concept ID.
3. Inspect the selected concept with `/akm-show`.
4. Record the result with `/akm-feedback`.
5. Save durable project knowledge with `/akm-remember`.
6. Delegate specialized work with `akm agent <agent-ref>` when an AKM agent's
   prompt, model, or tool policy is part of the task.
