/**
 * The list in an `akm search` or `akm curate` JSON response.
 *
 * Current akm returns it under `results` for both commands. Older akm returned search's under
 * `hits` and curate's under `items`; 0.10.261111 emits `results` beside them. Every plugin read of
 * that list goes through here, so one release works with older and newer akm: `results`, then
 * `hits`, then `items`. A response that carries none of them is an empty list.
 */
export function akmResultList(response: unknown): unknown[] {
  if (!response || typeof response !== "object") return []
  const r = response as { results?: unknown; hits?: unknown; items?: unknown }
  for (const list of [r.results, r.hits, r.items]) if (Array.isArray(list)) return list
  return []
}
