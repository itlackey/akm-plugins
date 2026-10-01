export type RecallDecision = {
  shouldRecall: boolean
  reason:
    | "explicit-akm"
    | "long-prompt"
    | "memory-intent"
    | "workflow-intent"
    | "agent-dispatch"
    | "command-dispatch"
    | "wiki-intent"
    | "proposal-intent"
    | "release-intent"
    | "coding-task"
    | "active-workflow"
    | "recent-asset-failure"
    | "skip-short"
    | "skip-chitchat"
    | "skip-low-signal"
    | "skip-nontask"
  query: string
  scopeHints?: string[]
}

import { extractAkmRefsFromString } from "./ref-extraction"

// Measured 2026-09-27: at least 53% of 30 days of per-prompt curate calls
// were not task queries at all — harness/tool envelopes (<task-notification>,
// <agent-message>, <bash-*>, <system-reminder>, <command-*>, <local-command>)
// and 220 byte-identical copies of the "This is an **AKM stash**" README line
// (src/assets/stash-skeleton/README.md in the akm CLI repo). This is the rule
// `akm curate` itself applies from 0.9.17-alpha.6; checking it here only saves
// the curate subprocess. Every tagged non-task input in those 30 days starts
// with a tag and closes one, so a tag merely mentioned inside a real question
// does not count. Length is not a signal either: 24 of 30 judged prompts over
// 2,000 characters had a relevant asset (retrieval eval plan §12).
const STASH_BOILERPLATE = "This is an **AKM stash** — a structured knowledge repository that stores reusable"
// Not part of akm's rule: the continuation Claude Code writes after a
// compaction opens with prose, not a tag, so the tag test above cannot see it.
const COMPACTION_CONTINUATION = "This session is being continued from a previous conversation"

// Every tag, opening or closing, with its name: `<name …>` / `</name>`.
const TAG = /<(\/?)([A-Za-z][\w:.-]*)(?:\s[^<>]*)?>/g

// Offset just past the `</name>` closing the block `text` opens with (a block
// of the same name nested inside it is skipped), or -1 when `text` does not open
// with a block or never closes it.
function leadingBlockEnd(text: string): number {
  const tags = new RegExp(TAG)
  let name: string | undefined
  let depth = 0
  for (let tag = tags.exec(text); tag; tag = tags.exec(text)) {
    if (name === undefined) {
      if (tag.index !== 0 || tag[1]) return -1
      name = tag[2]
    } else if (tag[2] !== name) continue
    depth += tag[1] ? -1 : 1
    if (depth === 0) return tag.index + tag[0].length
  }
  return -1
}

/**
 * `text` without the harness blocks that open it: each `<tag …>…</tag>`, one
 * after another. Claude Code sometimes prepends a <system-reminder> block (a
 * worktree notice, a background-task notice) to a prompt the user typed, so a
 * text that starts with a tag is not always an envelope; what follows the
 * blocks is what was typed. "" when nothing does: a task notification or a
 * subagent hand-back is blocks and no more.
 */
export function stripLeadingEnvelopes(text: string): string {
  let rest = text.trimStart()
  for (let end = leadingBlockEnd(rest); end > 0; end = leadingBlockEnd(rest)) rest = rest.slice(end).trimStart()
  return rest
}

/**
 * True for text that is not a prompt the user typed: a harness/tool envelope
 * (once the blocks leading the text are stripped, nothing is left, or what is
 * left starts with a tag and contains a closing tag), the post-compaction
 * continuation, or the literal stash README line. The Claude hook also asks
 * this before recording a prompt as the user's own words.
 */
export function isNonTaskPrompt(text: string): boolean {
  const typed = stripLeadingEnvelopes(text)
  if (typed === STASH_BOILERPLATE || typed.startsWith(COMPACTION_CONTINUATION)) return true
  return typed === "" ? text.trim() !== "" : typed.startsWith("<") && typed.includes("</")
}

export function shouldRecall(prompt: string, options?: { activeWorkflow?: boolean; recentAssetFailure?: boolean }): RecallDecision {
  // What was typed, not the blocks that lead it: they would otherwise drive the
  // keyword rules below and ride into the curate query. A prompt that is nothing
  // but blocks keeps its whole text and is skipped as a non-task.
  const trimmed = prompt.trim()
  const text = stripLeadingEnvelopes(trimmed) || trimmed
  const lower = text.toLowerCase()
  const scopeHints: string[] = []
  if (!text) return { shouldRecall: false, reason: "skip-low-signal", query: "", scopeHints }
  if (options?.activeWorkflow) return { shouldRecall: true, reason: "active-workflow", query: text, scopeHints: ["workflow"] }
  if (options?.recentAssetFailure) return { shouldRecall: true, reason: "recent-asset-failure", query: text, scopeHints }
  if (isNonTaskPrompt(text)) return { shouldRecall: false, reason: "skip-nontask", query: text, scopeHints }
  if (text.length < 4 || /^(ok|thanks|thank you|yes|no|continue|go ahead|sure|cool)$/i.test(lower)) {
    return { shouldRecall: false, reason: "skip-short", query: text, scopeHints }
  }
  if (/\b(hi|hello|how are you|good morning|good night)\b/i.test(lower) && text.length < 40) {
    return { shouldRecall: false, reason: "skip-chitchat", query: text, scopeHints }
  }
  // Reuse the resolver-facing parser rather than carrying a second, stale
  // grammar here. AKM 0.9.14 refs are [bundle//]conceptId[#fragment]; retired
  // type:name strings must not turn an otherwise low-signal prompt into an
  // explicit AKM recall.
  if (/\bakm\b|\bbundle\b/.test(lower) || extractAkmRefsFromString(text).length > 0) {
    return { shouldRecall: true, reason: "explicit-akm", query: text, scopeHints: ["akm"] }
  }
  if (/\b(remember|memory|prior session|previous decision)\b/.test(lower)) {
    return { shouldRecall: true, reason: "memory-intent", query: text, scopeHints: ["memory"] }
  }
  if (/\b(workflow|resume|complete step|next step|blocked step)\b/.test(lower)) {
    return { shouldRecall: true, reason: "workflow-intent", query: text, scopeHints: ["workflow"] }
  }
  if (/\b(dispatch|agent|subagent|reviewer|planner|curator)\b/.test(lower)) {
    return { shouldRecall: true, reason: "agent-dispatch", query: text, scopeHints: ["agent"] }
  }
  if (/\b(command|slash command|run the bundle command)\b/.test(lower)) {
    return { shouldRecall: true, reason: "command-dispatch", query: text, scopeHints: ["command"] }
  }
  if (/\b(wiki|docs|knowledge base|ingest|lint)\b/.test(lower)) {
    return { shouldRecall: true, reason: "wiki-intent", query: text, scopeHints: ["wiki"] }
  }
  if (/\b(proposal|accept|reject|diff proposal|review proposals)\b/.test(lower)) {
    return { shouldRecall: true, reason: "proposal-intent", query: text, scopeHints: ["proposal"] }
  }
  if (/\b(release|publish|semver|version bump|bump version|tag the release|cut a release)\b/.test(lower)) {
    return { shouldRecall: true, reason: "release-intent", query: text, scopeHints: ["workflow", "command"] }
  }
  if (
    text.length >= 16
    && /\b(review|pull request|\bpr\b|diff|refactor|type hints|typing|readability|readable|debug|diagnose|traceback|exception|exceptions|scaffold|unit test|tests|test|changelog|release notes|deployment|deploy|rollback|runbook|error code|healthcheck|linters|lint|format|formatting|naming conventions|convention|style guide|onboarding|new hire|new engineer|api keys|secrets|plan|design|architecture|tradeoffs|build|implement|fix|update)\b/.test(lower)
  ) {
    return { shouldRecall: true, reason: "coding-task", query: text, scopeHints: ["code"] }
  }
  if (text.length >= 120) return { shouldRecall: true, reason: "long-prompt", query: text, scopeHints }
  return { shouldRecall: false, reason: "skip-low-signal", query: text, scopeHints }
}
