/**
 * #110 — client-side filtering and rendering for `akm curate`'s `--format
 * json` response, used only by the opt-in relevance-floor path
 * (AKM_CURATE_MIN_SCORE) in both hooks.
 *
 * Why this exists: `akm curate --format text` (the default the hooks have
 * always used) never prints a per-item relevance score — `formatCuratePlain`
 * on the CLI side has no `score` line — so the hooks had no way to tell "five
 * weak hits" from "five strong hits" and always emitted whatever the CLI
 * returned. `--shape agent` DOES carry `score` (and `type`) on each item in
 * `--format json`, so the fix lives here: switch to JSON, decide, and render
 * just enough text to stay useful — NOT a full port of the CLI's own
 * formatter (next-steps footer, warnings block, etc. — the hooks already
 * append their own tip line and provenance banner around this).
 *
 * This module is intentionally not wired into the default (score-floor
 * disabled) code path: that path keeps calling `--format text` exactly as
 * before, so existing behavior — and every test that fakes the CLI's text
 * output — is untouched. See akm-plugins#110 for the fuller design tradeoff
 * (a renderer that fully replaces `--format text` in all cases, so
 * type-priority ranking could apply unconditionally rather than only when
 * the floor is enabled, was considered and deferred as a larger, riskier
 * change than this issue's evidence justified doing in one pass).
 */

export interface CuratedItem {
  type?: unknown
  name?: unknown
  ref?: unknown
  description?: unknown
  reason?: unknown
  score?: unknown
}

// Asset types a human or agent authored directly for THIS stash, as opposed
// to a bulk-imported snapshot of external content (a website crawl, a wiki
// page, a transcript). #110's evidence: on a real machine, a GitHub Copilot
// blog post and three doc-site snapshots outranked same-day lessons and
// memories written about the exact subject being asked about. This is a
// preference, not a filter — imported types still show, just after authored
// ones — because a snapshot can still be the best (or only) available hit.
const AUTHORED_ASSET_TYPES = new Set([
  "lesson",
  "memory",
  "knowledge",
  "skill",
  "command",
  "agent",
  "instruction",
  "fact",
  "workflow",
  "task",
  "env",
  "secret",
])

function isAuthoredType(type: unknown): boolean {
  return typeof type === "string" && AUTHORED_ASSET_TYPES.has(type)
}

/**
 * Keep items scoring at or above `minScore`, then stable-sort authored asset
 * types ahead of imported/scraped ones. Items with no numeric `score` are
 * kept regardless of `minScore` — a missing score is not evidence the item is
 * weak, it means this response shape did not carry one, and inventing a
 * reason to drop it would repeat the mistake #107 fixed on the extract side
 * (a specific wrong guess is worse than none).
 *
 * akm-cli has already decided which N items are the top-N for this query;
 * this only decides which of those N are worth showing, and in what order —
 * it never asks the CLI for more candidates to backfill a dropped slot, so a
 * strict floor can legitimately shrink the result set to nothing.
 */
export function filterAndRankCuratedItems(rawItems: unknown, minScore: number): CuratedItem[] {
  if (!Array.isArray(rawItems)) return []
  const items = rawItems.filter((item): item is CuratedItem => !!item && typeof item === "object")
  const survivors =
    minScore > 0 ? items.filter((item) => typeof item.score !== "number" || item.score >= minScore) : items
  return survivors
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const rankDiff = Number(isAuthoredType(b.item.type)) - Number(isAuthoredType(a.item.type))
      // Stable within each group: preserve akm-cli's own relative order
      // (its score-based ranking) rather than re-sorting by score here too.
      return rankDiff !== 0 ? rankDiff : a.index - b.index
    })
    .map(({ item }) => item)
}

/**
 * Compact plain-text rendering of already-filtered/ranked items. Deliberately
 * smaller than the CLI's own `formatCuratePlain`: no "Next steps" footer or
 * warnings block, because both hooks that call this already append their own
 * tip line (CURATED_CONTEXT_TAIL) and provenance banner around the result.
 */
export function renderCuratedItems(query: string, items: readonly CuratedItem[]): string {
  const lines: string[] = [`Curated results for "${query}"`]
  for (const item of items) {
    const type = typeof item.type === "string" ? item.type : "unknown"
    const name = typeof item.name === "string" ? item.name : "unnamed"
    lines.push("")
    lines.push(`[${type}] ${name}`)
    if (typeof item.description === "string" && item.description) lines.push(`  ${item.description}`)
    if (typeof item.ref === "string" && item.ref) lines.push(`  ref: ${item.ref}`)
    if (typeof item.reason === "string" && item.reason) lines.push(`  why: ${item.reason}`)
  }
  return lines.join("\n")
}
