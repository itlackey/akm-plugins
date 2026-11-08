/**
 * Client-side handling of `akm curate`'s `--format json` response, used by both
 * hooks and both OpenCode plugins for every automatic curate: drop the `rule`
 * hits (the session bootstrap carries the rules), keep the requested number of
 * the rest, apply the opt-in relevance floor and authored-first ranking
 * (AKM_CURATE_MIN_SCORE, #110) when it is set, and render just enough text to
 * stay useful — NOT a full port of the CLI's own formatter (next-steps footer,
 * warnings block, etc. — the hooks already append their own tip line and
 * provenance banner around this).
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
  "rule",
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
 * What to ask `akm curate` for so that `limit` ordinary hits survive dropping the rules. Rules lead
 * an untyped curate, capped at half the page, so a page of twice the limit always keeps `limit` of
 * the rest; `ordinaryCuratedItems` slices back to `limit`.
 */
export function curatePageSize(limit: number): number {
  return limit * 2
}

/**
 * The first `limit` hits that are not rules, in akm's order. The session bootstrap already put the
 * rules in context, and the lead akm gives them in curate would repeat them on every prompt.
 */
export function ordinaryCuratedItems(rawItems: unknown, limit: number): CuratedItem[] {
  if (!Array.isArray(rawItems)) return []
  return rawItems
    .filter((item): item is CuratedItem => !!item && typeof item === "object" && (item as CuratedItem).type !== "rule")
    .slice(0, limit)
}

/**
 * Keep items scoring at or above `minScore`, then stable-sort authored asset
 * types ahead of imported/scraped ones. Items with no numeric `score` are
 * kept regardless of `minScore` — a missing score is not evidence the item is
 * weak, it means this response shape did not carry one, and inventing a
 * reason to drop it would repeat the mistake #107 fixed on the extract side
 * (a specific wrong guess is worse than none).
 *
 * akm-cli has already decided which items are the top ones for this query;
 * this only decides which of those are worth showing, and in what order —
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
 * What an automatic curate shows: `limit` ordinary hits, put through the relevance floor and the
 * authored-first ranking only when a floor is set.
 */
export function curatedItemsToShow(rawItems: unknown, limit: number, minScore: number): CuratedItem[] {
  const items = ordinaryCuratedItems(rawItems, limit)
  return minScore > 0 ? filterAndRankCuratedItems(items, minScore) : items
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
