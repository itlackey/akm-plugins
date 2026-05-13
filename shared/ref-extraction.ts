const AKM_REF_PATTERN = /^(?:[A-Za-z0-9@._+/-]+\/\/)?(?:skill|command|agent|knowledge|memory|script|workflow|vault|wiki|lesson):[A-Za-z0-9._/\-]+$/
const EDGE_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "(", ")", "[", "]", "{", "}", "'", "\"", "`"])

function normalizeToken(token: string): string {
  let start = 0
  let end = token.length
  while (start < end && EDGE_PUNCTUATION.has(token[start] ?? "")) start += 1
  while (end > start && EDGE_PUNCTUATION.has(token[end - 1] ?? "")) end -= 1
  return token.slice(start, end)
}

export function extractAkmRefsFromString(text: string): string[] {
  const refs = new Set<string>()
  for (const token of text.split(/\s+/)) {
    const normalized = normalizeToken(token)
    if (normalized && AKM_REF_PATTERN.test(normalized)) refs.add(normalized)
  }
  return [...refs]
}
