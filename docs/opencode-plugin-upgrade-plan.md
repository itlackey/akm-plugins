# OpenCode + AKM Plugin Upgrade Plan

## Context

The AKM plugins for OpenCode (`opencode/index.ts`, ~1956 lines) and Claude Code
(`claude/`) wrap the `akm` CLI to expose stash assets — skills, commands,
agents, knowledge, memories, scripts, workflows, vaults, and wikis — into both
agent harnesses. The current implementation registers a useful but partial set
of OpenCode hooks and exposes 24 `akm_*` tools, plus a Claude-side hook script
and a small slash-command surface.

A review of the OpenCode plugin SDK (`@opencode-ai/plugin` v1.2.20) and the
current code revealed several high-leverage capabilities that are not yet
wired up: pre-execution tool gating, compaction context preservation, native
OpenCode agents/commands, cross-session memory access, workflow-aware system
prompts, and a few correctness/safety bugs in existing paths. This plan
captures the prioritized work needed to close those gaps and let the plugin
participate more fully in the compound-engineering loop AKM is designed for.

The intended outcome: every OpenCode and Claude Code session that touches the
stash leaves it stronger — assets are auto-resolved before tools run,
destructive operations are gated, the curator agent runs as a real
restricted subagent, hints and active workflows survive compaction, child
sessions can read parent context, and the stash improves with every turn
without blocking the TUI.

## Scope decisions

**In scope (Phase 1 — must-do, correctness + safety):**

1. Fix `akm_curate` double `--format` flag.
2. Make `tool.execute.after` auto-feedback fire-and-forget instead of
   `execFileSync`.
3. Add a `tool.execute.before` hook for fuzzy-ref pre-resolution and
   destructive-op gating.
4. Wire `experimental.session.compacting` and re-inject hints / curated
   context / active workflows after compaction.
5. Extend `extractToolRefs` to scan free-text child outputs from
   `akm_agent` / `akm_cmd` / `akm_evolve`.

**In scope (Phase 2 — should-do, reach + ergonomics):**

6. Ship a real OpenCode `akm-curator` subagent under `opencode/agent/` with
   restricted tool policy, and have `akm_evolve` default to it.
7. Use `shell.env` to surface `AKM_STASH_DIR` / `AKM_PROJECT` to bash tools.
8. Mid-session memory checkpoints after N successful asset-touching tool
   calls.
9. Add `akm_parent_messages` and `akm_session_messages` read-only tools so
   dispatched stash agents can see what the primary already knows.
10. Add the four missing Claude slash commands (`/akm-search`, `/akm-show`,
    `/akm-agent`, `/akm-cmd`) for parity with the most-used OpenCode tools.

**Phase 3 — nice-to-have:**

11. Retrospective feedback pattern matcher bound to the last few refs in the
    session buffer (positive signals only).
12. Beef up `claude/agents/akm-curator.md` to mirror the OpenCode curator
    system prompt.
13. Revisit `command.execute.before` once upstream ships the `noReply`
    option (issue sst/opencode#9306).

**Explicitly out of scope:**

- `permission.ask` handler — the SDK defines it but the host never fires it
  (sst/opencode#7006). Skip until upstream wires it.
- `experimental.chat.messages.transform` for vault redaction — rewriting
  history the agent already conditioned on is unsafe; prevent leaks at the
  source via `tool.execute.before` instead.
- `tool.definition` augmentation of built-in `read`/`write`/`bash` — small
  payoff for a per-turn system-prompt cost.
- Porting all 24 `akm_*` tools to Claude Code — Claude's design is
  skill-teaches-CLI, not a tool wrapper. Slash-command parity is enough.
- Short-circuiting slash commands via `command.execute.before` — pointless
  until `noReply` exists.

## Phase 1 — Must-do

### 1. Fix `akm_curate` double `--format` flag

**File:** `opencode/index.ts:446` (`runCli`) and `opencode/index.ts:1311`
(`akm_curate`).

`runCli` always appends `--format json` after the caller's args. The
`akm_curate` tool builds args starting with `--for-agent --format text
--detail summary -q curate ...`. The duplicate flag is argv-last-wins, so
the tool currently returns JSON despite the prose description and despite
`runCurateForPrompt` (the in-hook helper at `opencode/index.ts:176`) which
correctly emits text.

**Change:** in `runCli`, only append `--format json` when the caller's args
do not already contain a `--format` flag. Audit other call sites for
implicit reliance on the override.

### 2. Async auto-feedback

**File:** `opencode/index.ts:217` (`recordFeedbackSync`) and the
`tool.execute.after` block at `opencode/index.ts:1097`.

Today, every ref touched by a successful or failed tool synchronously
shells out to `akm feedback <ref> ...` via `execFileSync`. With the 8s cap
and N refs per call, this can stall tool finalization noticeably.

**Change:** replace with a non-blocking variant — `child_process.spawn`
detached, `stdio: 'ignore'`, `unref()` — and add a small in-process
deduper (`Set<"<ref>:<polarity>">`) keyed by `${ref}:${sentiment}` per
session to coalesce duplicates within the same tool finalization. Errors
log via `client.app.log`.

### 3. New `tool.execute.before` hook

**File:** `opencode/index.ts` (new top-level hook beside `tool.execute.after`).

Two responsibilities:

- **Fuzzy-ref pre-resolution.** When an `akm_*` tool argument is `ref` or
  `package_ref` and does not match the `[origin//]type:name` grammar
  (`AKM_REF_PATTERN` at `opencode/index.ts:32`), run a one-hit
  `akm search --type any --limit 1` and rewrite `output.args.ref` if a
  confident match is found. If no confident match, return a short-circuit
  error with disambiguation hints.
- **Destructive-op gating.** Block `akm_remove`, `akm_save` with `push:true`,
  `akm_vault unset`, and `akm_vault show` unless `args.confirm === true`.
  Returns a synthesized output explaining what was blocked and how to
  retry. This is the primary defense against accidental data loss; it is
  also the right place to enforce vault-leak prevention since
  `permission.ask` is not yet usable.

Risk: changes the contract of existing tools. Phase the rollout —
fuzzy-ref resolution is opt-in via env var (`AKM_FUZZY_REFS=1`) for one
release; destructive gating is on by default but with an obvious
`confirm:true` escape hatch documented in tool descriptions.

### 4. Compaction-aware context preservation

**File:** `opencode/index.ts` (new `experimental.session.compacting` hook;
existing `experimental.chat.system.transform` at `opencode/index.ts:1001`).

- Add a `sessionWorkflow` map keyed by sessionID that caches the output of
  `akm workflow list --active` once per session.
- New `experimental.session.compacting` hook pushes the cached hints,
  curated assets, active workflow status, and the last curator report (if
  any) into `output.context` so they survive compaction.
- After compaction, the `experimental.chat.system.transform` is fired
  again — re-prepend hints + workflow status (currently they delete after
  first inject and never reappear). Track "transform fired this turn" via
  a per-session counter rather than hard-deleting the cache.

Net effect: hint context, curated stash, and active workflow state survive
compaction; long sessions stay grounded.

### 5. Free-text ref scanning on child outputs

**File:** `opencode/index.ts:290` (`extractToolRefs`).

`akm_agent` / `akm_cmd` / `akm_evolve` return `{ ok, ..., text }` where
`text` is the child agent's reply. Today only structured fields
(`ref`, `hits[].ref`, `assetHits[].ref`) are scanned, so any ref the child
agent recommended in prose is invisible to auto-feedback and the session
buffer.

**Change:** when the tool name is `akm_agent` / `akm_cmd` / `akm_evolve`
and the parsed output has a `text` field, run `AKM_REF_PATTERN` against
the text and merge the matches. Conservative policy: refs found this way
get added to the session buffer for memory capture and **only positive**
auto-feedback (we cannot tell from prose alone whether the ref failed).

## Phase 2 — Should-do

### 6. Ship a native OpenCode `akm-curator` subagent

**New file:** `opencode/agent/akm-curator.md`.

Frontmatter:

```yaml
---
mode: subagent
description: AKM stash curator. Reviews session activity and proposes stash improvements.
permission:
  task: deny
tools:
  akm_remove: deny
  akm_save: deny
  akm_vault: deny
  write: deny
  bash: deny
---
```

Body: lift the `CURATOR_AGENT_PROMPT` constant from `opencode/index.ts:34`
into this file so the prompt has a single source of truth. The plugin
keeps a fallback string for environments where the agent file is not
loaded.

**Wiring:** in `akm_evolve` (`opencode/index.ts:1334`), default
`dispatch_agent` to `"akm-curator"` and fall back to `"general"` when the
agent is not available. Always persist the curator's reply text as
`memory:akm-curator-<YYYYMMDD>-<sid>` via `akm remember --force` so the
next curator run can build on it.

**Package:** add `"agent/"` to `opencode/package.json` `files` array so
the agent file ships with the npm release.

### 7. `shell.env` context injection

**File:** `opencode/index.ts` (new `shell.env` hook).

Surface `AKM_STASH_DIR` (resolved via `akm config get stashDir`),
`AKM_PROJECT` (the project worktree from `ctx.project.worktree`), and
`AKM_PLUGIN_VERSION` so plain `akm` calls in bash tools inherit
the right context. Cheap, additive, no breakage risk.

### 8. Mid-session memory checkpoints

**File:** `opencode/index.ts:151` (`addBufferEntry`) and
`opencode/index.ts:234` (`captureSessionMemory`).

After every N (default 8, env override `AKM_MEMORY_CHECKPOINT_EVERY`)
successful asset-touching tool calls, flush the session buffer via the
existing `captureSessionMemory` code path. The captured memory should not
delete the buffer state used for the final session-end memory; instead,
mark entries as "checkpointed" and only carry forward new entries to the
next checkpoint.

### 9. Cross-session message access

**File:** `opencode/index.ts` (two new tools).

```
akm_parent_messages — reads the current session's parentID via the SDK
                      and fetches all messages from the parent session.
akm_session_messages — fetches messages from any session by ID (allowlist
                      or curator-only).
```

Both tools call `client.session.message.list({ path: { id: ... } })` and
return a compact summary (role, agent, parts text). Useful for dispatched
stash agents that need to know what the primary already discussed.
Restrict via the curator agent's `tools:` allowlist; do not enable for
the default `general` agent.

### 10. Claude slash-command parity

**New files** under `claude/commands/`:

- `akm-search.md` — wraps `!akm search "$ARGUMENTS"`.
- `akm-show.md` — wraps `!akm show "$ARGUMENTS"`.
- `akm-agent.md` — fetches an agent by ref and dispatches via the AKM
  skill's existing dynamic-dispatch flow.
- `akm-cmd.md` — fetches a command template, renders `$ARGUMENTS`/`$1`/`$2`,
  and executes the result.

These are markdown wrappers; no hook changes needed. They mirror the
most-used OpenCode tools to give Claude users a comparable command
surface without porting the full 24-tool wrapper.

## Phase 3 — Nice-to-have

11. Retrospective feedback matcher bound to the last 3 refs in
    `sessionBuffer`, positive signals only (regex on follow-up user text:
    `\bthanks\b`, `\bperfect\b`, `\bworked\b`). Drop if noisy.
12. Mirror the new OpenCode curator prompt into
    `claude/agents/akm-curator.md` for symmetry.
13. Revisit `command.execute.before` once `noReply` lands upstream.

## Critical files

- `opencode/index.ts` — Phases 1 and 2 changes (hooks, tools, helpers).
- `opencode/package.json` — add `agent/` to `files` array.
- `opencode/agent/akm-curator.md` — new (Phase 2.6).
- `claude/commands/akm-search.md`, `akm-show.md`, `akm-agent.md`,
  `akm-cmd.md` — new (Phase 2.10).
- `claude/agents/akm-curator.md` — refresh (Phase 3.12).
- `tests/opencode-plugin.test.ts` — extend coverage for new hooks.
- `tests/claude-plugin.test.ts` — add slash-command coverage.

## Reusable existing utilities

- `runCli` (`opencode/index.ts:446`) — single CLI invocation path; reuse
  for any new tools.
- `runCliSyncRaw` (`opencode/index.ts:161`) — sync variant for in-hook
  paths; keep for compaction context preservation but pair with timeout
  budgets.
- `resolveRefInput` (`opencode/index.ts:739`) — already does fuzzy
  resolution for `akm_agent` / `akm_cmd`; the new `tool.execute.before`
  hook should call this same helper.
- `ensureTargetSessionID` / `promptTargetSession`
  (`opencode/index.ts:766`, `opencode/index.ts:815`) — child-session
  dispatch; reuse for any future sub-dispatch tools.
- `extractToolRefs` / `extractMemoryRefs`
  (`opencode/index.ts:290`, `opencode/index.ts:694`) — extend in place
  rather than introducing a parallel scanner.
- `captureSessionMemory` (`opencode/index.ts:234`) — extend with
  checkpoint mode rather than duplicating.
- `AKM_REF_PATTERN` (`opencode/index.ts:32`) — single source of truth for
  the ref grammar.

## Verification

For each phase, before merging:

1. **Unit tests.** Extend `tests/opencode-plugin.test.ts` with cases for
   the new hooks (`tool.execute.before` short-circuit, compaction context
   push, free-text ref scan). Extend `tests/claude-plugin.test.ts` for
   the new slash commands.
2. **CLI smoke.** With a real stash, run `akm search`, `akm show`,
   `akm curate`, `akm workflow list --active`, `akm feedback` to
   confirm CLI compatibility.
3. **OpenCode TUI smoke.** Load the plugin in OpenCode, open a session,
   invoke `akm_search` / `akm_agent` / `akm_evolve`, trigger
   compaction, verify hints and workflow status reappear in the system
   prompt.
4. **Claude TUI smoke.** Install the plugin via `/plugin install akm`,
   exercise the new slash commands, verify the SessionStart and
   PostToolUse hooks still record memories and feedback.
5. **Auto-feedback dedupe.** Trigger a tool that touches multiple refs
   and confirm `akm feedback` is called at most once per `(ref, polarity)`
   per tool call, asynchronously.
6. **Destructive-op gating.** Confirm `akm_remove` / `akm_save --push` /
   `akm_vault unset|show` short-circuit unless `confirm:true`. Confirm
   the error message is actionable.
7. **Curator dispatch.** Invoke `akm_evolve` and confirm the dispatched
   agent uses `akm-curator`, that its tool policy denies destructive
   ops, and that its reply lands as `memory:akm-curator-*`.
