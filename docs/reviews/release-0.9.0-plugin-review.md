# Critical review: akm-plugins `release/0.9.0`

- **Reviewed ref:** `origin/release/0.9.0` @ `34c3871` (plugins at `0.9.0-beta.1`)
- **Date:** 2026-07-11
- **Scope:** code sharing across plugins, harness and akm integration per plugin, extensibility to new harnesses, stale documentation, misalignments with the akm CLI, unnecessary features/bloat, tests and evals.
- **Note:** all `file:line` references below are against the `release/0.9.0` tree, not the branch this report is committed to.

## Executive summary

0.9.0 is a genuine slimming release (−2,004/+665 lines vs `main`: session-checkpoint writes removed, tier-2 memory metric deleted, version contract centralized in `claude/shared/akm-version.ts`). But as it stands the branch ships several release-blocking defects and a structural sharing problem:

1. **Guaranteed crash in the OpenCode plugin.** `captured` is referenced but never declared in the `session.compacted` handler (`opencode/index.ts:2495–2496`) — a leftover from the deleted checkpoint write. Every compaction throws a `ReferenceError` that is swallowed by the catch at `:2518`, so `post_compact_summary` events are never written. Bun strips types without checking and nothing typechecks `index.ts` in CI, which is how this shipped.
2. **Dead lifecycle hook guts the memory-harvest story.** `stop:` (`opencode/index.ts:2525–2536`) is not a hook in `@opencode-ai/plugin@1.2.20` — the host never calls it. The memory-candidate harvest therefore only fires on explicit `session.deleted`, i.e. almost never. The repo's own test asserts `hooks.stop` is defined (`tests/opencode-plugin.test.ts:275`), testing the plugin's shape rather than the host's contract.
3. **The docs actively fight the release.** `/akm-setup` (`claude/commands/akm-setup.md:23–56`) declares 0.9.x *incompatible* and instructs installing `akm-cli@^0.8.0`; both plugins' consent banners do the same (`claude/hooks/akm-hook.ts:62,881–883`; `opencode/index.ts:1704–1705`) — while the shared contract accepts `^0.9.0` and two runtime paths *require* 0.9.x semantics (`akm extract --session-id`, curate `--detail brief`). Following the plugin's own instructions downgrades users onto a CLI the plugin no longer fully works with.
4. **A model-remap feature that doesn't belong and is buggy.** The Claude hook rewrites the Agent tool's `model` param (`claude/hooks/akm-hook.ts:18–54, 1272–1317`), force-floors unknown aliases to `sonnet`, silently downgrades full model IDs outside opus/sonnet/haiku (including `claude-fable-5`, the very ID the `fable` alias was added for in `999aeec` — the pass-through regex at `:45` doesn't know the family), and couples every remap with `permissionDecision:"allow"`, silently bypassing any user-configured `ask` rule for the Agent tool.
5. **The sharing architecture doesn't scale to a third harness.** `claude/shared/` covers only leaf utilities (~1,150 lines); ~40–45% of the 4,014-line OpenCode plugin re-implements policy that also lives in the 1,417-line Claude hook, and the two copies have already diverged in observable behavior (env-var parsing, defaults). Adding a Codex/Gemini plugin today means hand-porting ~1,500 lines from one of two drifted sources.

The detailed findings follow, organized by the review's focus areas. A prioritized fix list is at the end.

---

## 1. How code is shared — and how it isn't

### 1.1 What is actually shared

`claude/shared/` (8 modules, ~1,150 lines): version contract + vendored semver, redaction, recall policy, feedback-confidence classification, memory event/candidate JSONL persistence, ref extraction. `opencode/index.ts` imports these via `../claude/shared/*`; at `npm pack` time `opencode/scripts/vendor-shared.mjs` copies them into `opencode/shared/` and **regex-rewrites the import strings in `index.ts`** (keeping an `index.ts.prepack-bak`), and `unvendor-shared.mjs` reverses it.

Problems:

- **The shared core is namespaced under one harness.** `claude/shared/` as the canonical home for cross-harness code is backwards and forces the vendoring dance. A top-level `shared/` (or a real workspace package — there is no root `package.json` at all) removes both.
- **The vendoring mechanism is fragile:** source-level regex import rewriting, a backup file left behind on interrupted packs, and a published tarball whose source differs from the repo tree.
- **Dead dependency:** `opencode/package.json:44` declares `semver@^7.7.2`; nothing imports it — the vendored matcher is used on both sides.
- **The shared layer itself contains divergence.** Three different AKM ref grammars: `recall-policy.ts:23` (no `script`/`task` types), `memory-candidates.ts:47` (no `task`), `ref-extraction.ts:68–69` (full set, different trailing-char rules) — plus more inline copies in each plugin (`akm-hook.ts:118`, `opencode/index.ts:111`, and a third inline regex at `index.ts:2673`). `ref-extraction.ts:25–46` carries a hand-maintained "contract lock" with a sister resolver in the akm core repo and a self-contradictory "this file is the SECOND copy" comment block.

### 1.2 What is duplicated instead of shared

The big behavioral layers are re-implemented per harness, some verbatim:

| Layer | Claude | OpenCode | State |
| --- | --- | --- | --- |
| cwd project context | `akm-hook.ts:122–158` | `index.ts:478–513` | verbatim copy |
| akm config read/write | `akm-hook.ts:377–441` | `index.ts:291–360` | near-identical incl. shared `#463` comments |
| CLI resolution / version probe / consent banner | `akm-hook.ts:279–360, 852–890` | `index.ts:1452–1738` (~290 lines) | same policy, **already behaviorally diverged** |
| Session-start hints prose | `SESSION_START_HEADER`, `akm-hook.ts:103–117` | `AKM_HINTS_PREFIX`, `index.ts:1192–1208` | same prose, tool-name substitutions |
| Curate-on-prompt, auto-feedback, candidate harvest, retrospective regexes, context budget | throughout | throughout | mirrored with local edits |
| `akm help` quick-reference table | `commands/akm-help.md`, `SKILL.md` | `index.ts:1258–1370` | **four** hand-maintained copies incl. `docs/akm-help-registry.md`; all four drifted (§5) |
| akm-curator agent prompt | `claude/agents/akm-curator.md` | `opencode/agent/akm-curator.md` + fallback prompt at `index.ts:165` | three copies; disagree on report shape (7 vs 9 sections) and write permissions |

Concrete evidence the fork has already cost correctness:

- `AKM_AUTO_FEEDBACK` parsing: OpenCode treats any value `!== "0"` as enabled (`index.ts:50`); Claude requires `=== "1"` (`akm-hook.ts:75`). `AKM_AUTO_FEEDBACK=2` enables one plugin and disables the other.
- `AKM_INDEX_ON_SESSION_END` defaults diverge (OpenCode `0` at `index.ts:534`, Claude `1` at `akm-hook.ts:81`).
- The Claude hook gained a prompt-injection provenance banner for recalled stash content (`RECALLED_CONTENT_PROVENANCE`, `akm-hook.ts:94–101`); the OpenCode system-transform injects curated content with **no equivalent provenance framing** (`index.ts:2551–2575`). A security-relevant parity gap.

### 1.3 Recommendation

Restructure into a harness-agnostic `core/` (CLI resolution + probing, config I/O, recall/feedback/candidate policy, capture pipeline, help registry consumed as *data*, prompt prose as templates) with thin `claude/` and `opencode/` adapters that only map lifecycle events onto core calls and are the only code allowed to touch a harness SDK. Generate all help-table copies from `docs/akm-help-registry.md` at build time and extend the parity test to every consumer and every column (its current form checks one column of one copy — see §5).

---

## 2. Claude plugin: harness and akm integration

The hook wiring is **API-correct**: all registered events (`UserPromptExpansion`, `PostToolUseFailure`, `PostToolBatch`, `SubagentStart`, `TaskCreated`, `TaskCompleted`, `PostCompact`, etc.) are real Claude Code hook events, `additionalContext` is used where honored, and `updatedInput` + `permissionDecision` on PreToolUse is a documented combination. The problems are in what the handlers do:

- **[high] Model remap** (`akm-hook.ts:18–54, 1272–1317`) — see executive summary #4. Also: it only reads `~/.claude/agents/<name>.md` frontmatter (`:1293`), ignoring project-level and plugin-provided agents; and the header comment ("only four valid aliases", `:19–23`) contradicts the comment at `:38–42` and the docs. Delete the feature, or reduce to pass-through-unless-known-bad and never couple with `permissionDecision:"allow"`.
- **[high] Stale install ref vs version contract.** `AKM_PACKAGE_REF` defaults to `akm-cli@^0.8.0` (`:62`); banner text at `:881–883`. Contract: `shared/akm-version.ts:21`.
- **[high] Logging-policy violations.** `process.stderr.write` banners at `:886`, `:972`, `:1020` directly violate `AGENTS.md:3,62`; hook stderr on exit 0 is only surfaced in debug mode anyway, so they mostly don't reach users either.
- **[high] Unbounded state growth.** Seven append-only files under `$XDG_STATE_HOME/akm-claude/` with no rotation or caps; `quality-cache.tsv` is read and reversed **in full on every Bash PostToolUse** (`:894–899`) and entries never expire, so a `proposed` asset later promoted to `curated` is misclassified forever.
- **[med] Registered-hook vs documented-behavior gap.** No `Stop`, `SubagentStop`, or `PreCompact` hooks are registered in `plugin.json`, yet `SKILL.md:362` still claims stop-time persistence of `memory:claude-session-YYYYMMDD-<sid>` — deleted in `f3f47c8`. The skill instructs the model to improve a memory that is never created.
- **[med] First-run config mutation.** `detectAgentDefault()` writes `defaults.agent=claude` into the shared `~/.config/akm/config.json` (`:931–946`) — opt-out (`AKM_PLUGIN_NO_AUTO_DEFAULT=1`) mutation of cross-tool config from a hook; an OpenCode user who opens Claude Code once gets their default agent flipped.
- **[med] Auto-positive feedback on viewing.** Any successful Bash command mentioning `akm` plus a ref submits positive feedback at confidence 0.65 ≥ the 0.6 threshold (`:1090–1131`; `shared/feedback-signals.ts:20–39`) — `akm show skill:foo` boosts `skill:foo`'s ranking. Viewing ≠ helping; this biases the ranking loop the whole plugin exists to feed.
- **[med] Session-file collision.** `extractSessionId()` returns `""`, never `null` (`:548–552`), so the `sid ?? "unknown"` fallbacks at `:1167`/`:1235` never trigger; id-less sessions all clobber `curated/prompt-.md`. Should be `sid || "unknown"`.
- **[med] Fragile JSON triangulation.** Three-way key fallbacks per akm call site (`{value}`/`{stashDir}` at `:235–241`; `{proposals}`/`{hits}` at `:1240–1245`; `runId|id`, `status|state` at `:726–731`) hide CLI contract drift instead of surfacing it.
- **[med] Latency taxes.** `shouldRecall()`'s coding-task regex (`shared/recall-policy.ts:62–67`) matches nearly any dev prompt ("test", "fix", "build", "update"…), so almost every prompt pays an LLM-reranked `akm curate` (≤8s) before Claude sees it; `subagentStart()` runs `akm workflow list --active` on every subagent launch (`:742–744`); SessionEnd blocks on a synchronous `akm index` (`:948–952`) that SessionStart already warms in the background and that `SKILL.md:66` calls "rarely needed".
- **[med] Non-atomic candidate updates.** `updateCandidateStatus()` read-modify-writes the JSONL with no temp-file rename or lock (`shared/memory-candidates.ts:181–196`); concurrent hook processes can drop candidates.
- **[low] `timeout(1)` soft dependency** — no GNU `timeout` on stock macOS, so akm calls run unbounded to the outer hook timeout; `readAkmVersion` (`:339–342`) is never wrapped at all. **[low]** Dead dispatch entries (`ensure-akm`, `check-akm`, no-op `pre-tool`, standalone `user-feedback` duplicated inside `curatePrompt`). **[low]** Elaborate Windows PATH/PATHEXT resolution (`:280–315`) is dead — the entrypoint is `sh akm-hook.sh`. **[low]** ~1.5KB of static "v0.8.0" marketing prose injected into every session (`:102–117`), duplicating SKILL.md content.

## 3. OpenCode plugin: harness and akm integration

The hook surface is largely real (verified against `@opencode-ai/plugin@1.2.20` type declarations): `event`, `chat.message`, `tool.execute.before/after`, `shell.env`, and `experimental.chat.system.transform` all exist, and session/subagent dispatch uses genuine SDK calls. The defects:

- **[high] `captured` ReferenceError** — executive summary #1 (`index.ts:2495–2496`).
- **[high] Dead `stop` hook** — executive summary #2 (`index.ts:2525–2536`; comment at `:2522–2524` admits it's a Claude-ism).
- **[high] Triple export risks double initialization.** `index.ts:4013–4014` exports the plugin function as `AkmPlugin`, `server`, and inside `export default { server, id }`. OpenCode's loader initializes every exported function as a plugin — two function exports means duplicate hook registration (double auto-feedback, double session-start curates). The SDK's own example exports exactly one const. Tests bless the triple shape (`tests/opencode-plugin.test.ts:206–207`) without testing what the loader does with it.
- **[high] Event-loop blocking despite the "non-blocking" claim.** `README.md:45` says every hook is non-blocking; in reality hooks use synchronous `execFileSync` — `session.created` serially runs curate (8s cap), hints, workflow list and proposal count; `chat.message` can block up to **60s** (`:2780 → :929 → :1831`). `execFileSync` blocks the whole Bun process (TUI/server), not just the session; the comment at `:583` misunderstands this.
- **[med] `akm --version` probe before every CLI call.** `resolveAkmCommand` (`:1716–1738`) re-runs a sync probe (10s timeout) on every `runCli`/`queueFeedback` invocation — every tool call is ≥2 subprocess spawns and a hung probe stalls the host.
- **[med] stderr consent banner** (`:1709–1711`) violates the same AGENTS.md logging rule as the Claude hook.
- **[med] Auto-positive feedback inflation.** `classifyToolFeedback` (`:2129–2137`) treats any output with `type`/`hits` keys as positive at confidence 0.65 — every successful `akm_show`/`akm_search` queues positive `akm feedback`. Same ranking-bias defect as the Claude side.
- **[med] Memory leaks.** `session.deleted` cleanup (`:2505–2515`) misses `retrospectiveState`, `sessionRecallAudit`, and per-session `pendingProposalSummaryCache` entries; `sessionBuffer` is uncapped; curated files under `os.tmpdir()/akm-opencode/curated` are never deleted.
- **[med] Bypassable confirmation gate.** The `tool.execute.before` gate works by injecting an `__akmBlocked` arg each tool must voluntarily check (`:2586–2613`); `akm_env`/`akm_secret`/`akm_proposal` re-verify `confirm` inside `execute`, but **`akm_memory` promote/reject does not** (`:3080–3165`).
- **[med] Privacy posture of logging.** `chat.message` logs up to 1,000 chars of every user message at info level (`:2636–2643`) and `runCli` logs full akm stdout (`:1763–1773`); both pass regex redaction, but pattern-based redaction over raw prompts is best-effort and contradicts the README's minimal-touch framing.
- **[med] 0.9-only semantics inside a range that still accepts 0.8.0.** `akm extract --type opencode --session-id` requires akm ≥0.9.0-beta.33 per its own comment (`:93–95, 1419`) and will spawn a failing subprocess every 10 minutes per session on 0.8.0; curate `detail:"summary"` maps to the 0.9.0-only `--detail brief` (`:3176–3183`).
- **[low/med] `akm_env run` splits the command with `/\s+/`** (`:3547`), breaking quoted arguments — a proper quote-aware `splitArguments` exists at line 20 of the same file. The child's stdout is also returned to the model verbatim, so the "values never reach stdout" contract only holds if the child cooperates.
- **[low] Assorted:** POSIX-only `execSync("… &")` backgrounding hack (`:810–821`) whose comment contradicts itself; four JSON-parse helpers, three identical (`:572, :823, :1986, :2090`); dead `truncateLine` (`:634`); `getPendingProposalCount` awaited three times in one expression (`:2559`); telemetry mapper stamps any non-workflow event as `"workflow_step"` (`:831–851`); the SDK client is used only through `as unknown as` structural casts (~20 sites), discarding the SDK's own types.

## 4. Extensibility to new harnesses

**Verdict: poor today.** A third-harness author must port ~1,500 lines of policy from whichever plugin they read first, inheriting its bugs and diverging from day one — which is exactly the documented history of these two. Concrete blockers:

- No neutral shared package (§1); prose and policy baked into per-harness code.
- **Harness names are hardcoded in the shared layer**: `memory-events.ts:80–83` and `memory-candidates.ts:61–65` switch on the union type `"claude-code" | "opencode"` for state-dir naming; `feedback-signals.ts` carries the same closed union. A third harness requires editing shared modules, not just adding an adapter.
- Feature parity is tracked by hand in a README table whose rows are pinned **verbatim by a test** (`tests/claude-plugin.test.ts:277–297`) — institutionalizing staleness rather than preventing drift (§5).
- The eval harnesses re-implement each host environment by hand (§7), so each new harness also needs a bespoke eval shim.

Meanwhile the repo's own `AGENTS.md` drop-in path ("All Other Agents", README.md:114–116) demonstrates that a large fraction of plugin behavior — discovery guidance, verb tables, destructive-verb etiquette — is deliverable as instructions with zero code. That should sharpen the bar for what earns a code path in any harness plugin (§6).

## 5. Stale documentation and registry drift

- **[release-blocking] Version pins.** `akm-setup.md:23–56` calls 0.9.x incompatible and installs `^0.8.0`. "0.8.0" appears 12× in claude/README, 5× in opencode/README, 15× in root README, 9× in SKILL.md, 7× in AGENTS.md, 19× across six command files. Zero occurrences of "0.9.0" in either plugin README. The session-injected header prose says "v0.8.0 adds…" (`akm-hook.ts:102,110`).
- **Removed features still documented as live:** session-summary memory writes (`opencode/README.md:57`, `SKILL.md:362`, both curator agents, `akm-evolve.md:8`, and the curator fallback prompt at `index.ts:166` — the curator is instructed to review memories that are never written); phantom `AKM_MEMORY_CHECKPOINT_EVERY` env var (`opencode/README.md:54,126` — appears nowhere in code); `tool.execute.after` "checkpoints memories every N calls" (no such path); root `README.md:155` lists `Stop`/`SubagentStop`/`PreCompact` hooks that aren't registered and claims hooks "gate risky raw AKM Bash" — the gate the same repo documents as removed in 0.8.0 in three places.
- **Feature parity tracker fiction:** "#56 Claude PreToolUse safety guard — Shipped in Claude" describes the removed gate; the two "Deferred to 0.9.0" rows (#29, #31) are unresolved on the 0.9.0 release branch; all 15 rows are test-pinned (`tests/claude-plugin.test.ts:277–297`), so fixing the README requires touching the test — likely why nobody has.
- **Count contradictions:** claude/README says 22 verbs (`:251`) and "the 21 slash commands above" (`:278`); `akm-help.md:7–10` enumerates only 18 (missing the four memory commands); `opencode/README.md:17` claims 21 tools but the table lists 20 (`akm_memory` missing); `akm_proposal` rows omit `drain` in both READMEs.
- **README contradicts code:** `opencode/README.md:115` "Session start no longer auto-curates" vs `:50` and `index.ts:2458–2465` (it does); `README.md:200` "prefers the bundled binary first" vs code deliberately doing local-build → PATH → bundled last (`index.ts:1596–1617`); `README.md:55` documents an `experimental.session.compacting` hook the plugin doesn't implement (tests assert its *absence*, `tests/opencode-plugin.test.ts:217`); model-alias table says four aliases (`claude/README.md:150`) vs five in code.
- **Registry drift despite a "parity test."** `docs/akm-help-registry.md:3` claims the test fails "when any row drifts" between it and the embedded copies. The test (`tests/claude-plugin.test.ts:237–263`) checks only the Command cell, only in `akm-help.md` and `SKILL.md` — `opencode/index.ts`'s copy isn't checked at all and has materially drifted (proposal-row command, sync-row flags, improve-row notes/keywords, drain-row flags, secret-row wording). Verbs the plugins actually invoke are missing from the registry entirely: `akm extract`, `akm hints`, `akm help migrate`, and there is **no `env` row** even though `akm-env.md:41–52` routes users to `/akm-help topic="env"`. Three docs advertise a phantom `save` verb (`akm-help.md:12`, `SKILL.md:37`, `claude/README.md:279`) that the registry only knows as `sync`.
- **Stale planning doc:** `docs/opencode-plugin-upgrade-plan.md` opens by saying the previous plan is stale and is itself now wrong (claims 14 tools — actual 21; lists removed `permission.ask`/`command.execute.before` hooks; cites long-past test counts). Archive or delete; move the durable #31 analysis into the issue.
- **AGENTS.md:80** documents `akm env show`, which appears nowhere else and would violate the "values never surface" contract if real.

## 6. Bloat: features better replaced by integration or instructions

- **Model remap** (§2) — delete; this is host-platform territory, and it currently subverts both model selection and permissions.
- **Four-to-five overlapping capture pipelines per harness:** TSV `feedback.log`/`memory.log`; structured `events.jsonl`; regex-classified `memory-candidates.jsonl` (keyword NLP: "worked|helped|useful" → asset_feedback @0.72, `shared/memory-candidates.ts:73–147`); per-session buffers; and — new in 0.9.0 — server-side `akm extract`, which is the real extraction engine. On OpenCode add the retrospective-feedback state machine as a fifth. `akm extract` supersedes the client-side keyword classifier and the TSV logs duplicate `events.jsonl`; at least two mechanisms per harness can be deleted outright. The in-code comments narrate the churn ("03-R1/06-M1 kept half…", `index.ts:1074–1079`).
- **Trivial wrapper surfaces.** OpenCode: `akm_wiki` (~115 lines), `akm_workflow` (~130), `akm_proposal`, `akm_env`/`akm_secret` list-actions, `akm_init`, `akm_info` are args→argv switch-cases around `runCli`; the plugin *already ships the alternative* (`akm_help` + quick-reference → raw CLI via shell). The typed value-add is per-action confirm gating and enum discoverability — that justifies proposal/env/secret, not the wiki/workflow plumbing. Claude: `akm-search.md`, `akm-show.md`, `akm-feedback.md`, `akm-remember.md`, `akm-curate.md` (13–17 lines each) duplicate what the 644-line SKILL.md already teaches.
- **The memory quartet should be one command.** `/akm-memory-audit/-candidates/-promote/-reject` all operate on one JSONL file; OpenCode already proves the consolidation with a single `akm_memory` tool. A `/akm-memory <action>` matches the existing `/akm-proposal`, `/akm-wiki`, `/akm-workflow` pattern.
- **Five entry points into one proposal queue:** `/akm-proposal` subsumes `/akm-review-proposals` (literally "proposal list, then show+diff each"); `/akm-improve` and `/akm-propose` share a verbatim step; `/akm-evolve` dispatches a curator whose output is more proposals. Each re-explains the triage/drain/sync machinery — that explanation is copy-pasted into **six** files plus the registry.
- **`akm_session_messages` / `akm_parent_messages`** (`index.ts:3248–3311`): transcript readers whose only guard is a string compare on the agent name; they exist to feed the curator, which server-side `akm extract` now also covers. Candidates for removal.
- **Instructions masquerading as code:** `userPromptExpansion` spawns `sh + bun` per `/akm-*` expansion to inject constant caution strings (`akm-hook.ts:679–685`) that belong in command frontmatter; ~1.5KB static header prose injected per session duplicates the skill.
- **Two parallel context re-injection trackers** in the OpenCode transform (epoch maps + curated-version maps, 6 maps total, `index.ts:75–79, 2548–2576`) to decide whether to push one string.
- **Double-loaded help table:** the full 20-row table sits verbatim in both `akm-help.md:19–39` and `SKILL.md:49–69` — two copies of ~1,900 words in context whenever both load.
- **Contradictory and hazardous prompt surface:** `SKILL.md:520` tells Claude to dispatch stash agents via `claude -p --permission-mode bypassPermissions` — directly defeating the harness permission system and contradicting both `akm-agent.md:17` (enforce via `--allowedTools`) and `claude/README.md:72` (toolPolicy "not enforced"); flag spelling drifts (`--allowedTools` vs `--allowed-tools`); hardcoded rotting model IDs (`SKILL.md:486` `claude-sonnet-4-5-20250514` — a nonexistent ID; `gpt-5.4` in the alias map; `openai/gpt-5.3-codex` in opencode/README examples); `akm-curate.md:6` uses `--format text` while `SKILL.md:230` mandates `--format json` for the same verb.
- Realistic consolidated surface: **~12–14 Claude commands** (fold memory×4→1, merge review-proposals into proposal, demote the five one-liner wrappers) and **~14 OpenCode tools** (drop wiki/workflow/session-message wrappers onto the `akm_help` + CLI path).

## 7. Tests and evals

Empirically verified: `bun test tests/` passes (314 tests) and the tier-2 runner reproduces the checked-in baseline. Architecture is sound — the Claude hook is tested black-box as a subprocess with fake `akm` scripts on PATH; the OpenCode plugin is imported for real with mocked `child_process`; tier-2 eval harnesses spawn/import the real plugins rather than re-implementing them. Issues:

- **[med-high] Three independent fake-akm implementations, none contract-tested.** The evals shim (`evals/lib/fake-akm.ts`), the Claude tests' inline shell scripts, and the OpenCode tests' mocked `execFileSync` all invent their own JSON envelopes; no test pins any of them to real akm output, so a real 0.9.0 envelope change passes every test. The shim silently no-ops every verb it doesn't model (`fake-akm.ts:384–385`) — including `config get/set`, `workflow list --active`, `proposal list`, and `extract`, all of which the hook actually calls — so the proposal-count, active-workflow, and extract pipeline stages are invisible to tier-2. The shim's own comments record that this exact failure mode (missing `--shape` flag silently collapsing curation to zero) already happened once (`:253–255`).
- **[med] Tests pin the plugin's shape, not the host contract:** `hooks.stop` asserted defined (`tests/opencode-plugin.test.ts:275`) though the host never calls it; the triple export blessed (`:206–207`); README parity-tracker rows pinned verbatim (`tests/claude-plugin.test.ts:277–297`); five literal source-text greps (`:157–161`). And **nothing typechecks `opencode/index.ts`** — which is how the `captured` ReferenceError shipped. Adding `tsc --noEmit` to CI is the single highest-leverage test fix.
- **[med] CI wiring fragility:** unit tests only run inside the misleadingly-named "Evals" workflow; **no lockfiles** anywhere (`.gitignore` ignores them — the review environment observed bundled `akm-cli@^0.9.0-beta.0` resolving to a binary self-reporting 0.7.9); `release.yml` runs tier-2 without installing evals deps (works only while tier-2 has zero runtime deps — an undocumented invariant); the PR-comment step fails the job on fork PRs; `release.yml` always checks out the default branch, so this release branch can't be released without merging first.
- **[med] Eval-harness host shims drift-prone:** the OpenCode eval harness monkey-patches `child_process` with a `spawn` that always ignores stdin (`evals/tier2/harness/opencode.ts:126`) — any stdin-piping plugin path silently degrades under evals only; two independent mock clients of the same host API; `REF_RE`/curated-file regexes copy-pasted into three eval files.
- **[med] Tier-3 is dead weight in its current form:** ~1,300 lines (real-agent loop, LLM judge with verdict cache, `ab.ts` A/B with git worktrees and Wilson CIs) reachable only via manual `workflow_dispatch`; `ab.ts` referenced by no workflow; no evidence of any run (empty results dirs); Wilson intervals over n≈3–12 trials are statistically meaningless; the judge's hardcoded single-model pricing table silently misprices any model override. Either wire a cheap smoke lane into CI or reclassify it as manual tooling.
- **[low-med] Doc rot:** `tests/README.md:8` covers a nonexistent `claude/index.ts`; `evals/README.md:159–162` claims tier-3 is stub-only (false — the real loop is the default; only one of two duplicated "does NOT measure" sections was updated); tier-3 README and code comments advertise prompt caching the code explicitly removed; dead `readStdinForCall` + the shim's `remember` stdin-capture branch survived their only consumer (the deleted memory metric).
- **[low] Coverage gaps:** `check-akm`, `pre-tool-nonbash`, `post-tool-nonbash` hook subcommands have zero tests; no coverage tooling, and test volume is inverted relative to risk (57 tests for the 1,417-line hook).

## 8. Prioritized recommendations

**Release blockers (fix before 0.9.0 ships):**
1. Fix the `captured` ReferenceError (`opencode/index.ts:2495–2496`) and add `tsc --noEmit` for both plugins to CI.
2. Replace the dead `stop` hook with real OpenCode lifecycle coverage (`session.idle`/`session.compacted`/`session.deleted`) so the candidate harvest actually runs; fix the test that pins `hooks.stop`.
3. Reduce to a single plugin export (`AkmPlugin`) and verify against the loader.
4. Purge the `^0.8.0` pins: `akm-setup.md`, both consent banners, `AKM_PACKAGE_REF` default — align with `AKM_VERSION_RANGE`; either drop 0.8.0 from the accepted range or gate the 0.9-only calls (`extract --session-id`, `--detail brief`) on probed version.
5. Delete or fix the model remap; at minimum stop flooring unknowns to `sonnet`, pass through unrecognized full IDs, and remove the `permissionDecision:"allow"` coupling.
6. Remove `--permission-mode bypassPermissions` from SKILL.md's dispatch recipe.
7. Purge removed-feature claims from docs (session-summary memories, phantom hooks, phantom env vars, "gate risky raw AKM Bash") and the curator prompts that reference never-written memories; fix the count contradictions.

**Structural (start now, land after 0.9.0):**
8. Move `claude/shared/` to a neutral top-level package; migrate the duplicated policy layers (CLI resolution, config I/O, hints/curate/feedback/candidate orchestration) into it; make harness IDs open strings so a third adapter doesn't edit shared code; kill the prepack regex-vendoring in favor of a normal package boundary.
9. Make `docs/akm-help-registry.md` the generated-from source for all four table copies and extend the parity test to all consumers/columns; add registry rows for `extract`, `hints`, `env`, `help migrate`; remove the phantom `save`.
10. Collapse the capture pipelines around server-side `akm extract`; delete the TSV logs and the regex candidate classifier; fix auto-feedback so viewing an asset is not a positive signal.
11. Consolidate the command/tool surfaces (~12–14 each); unify Claude/OpenCode command naming; single-source the curator prompt.
12. Add lockfiles, run unit tests in a dedicated workflow, install evals deps in `release.yml`, guard the PR-comment step on fork PRs, and add one contract test that pins a fake-akm envelope against real CLI output.
13. Add state-file rotation/caps on both sides; fix the OpenCode session-map leaks and tmp-file cleanup; make candidate updates atomic.
14. Decide tier-3's fate: a CI smoke lane or explicit manual-tooling status.
