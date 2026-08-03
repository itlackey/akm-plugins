/**
 * AKM 0.9 ref extraction and local bundle validation.
 *
 * Session checkpoints can contain command bodies, heredocs, and serialized
 * tool output. Extraction is deliberately permissive, then candidates are
 * retained only when their concept ID resolves inside a provided bundle root.
 * This keeps the hook subprocess-free and drops ref-shaped string literals.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";

// Passive extraction is intentionally narrower than AKM's explicit ref parser:
// only standard concept roots are observed. This prevents ordinary paths such
// as src/app.ts from becoming automatic feedback targets.
const REF_PATTERN =
  /(?<![A-Za-z0-9@._+/:=-])(?:[A-Za-z0-9@._+-]+\/\/)?(?:agents|commands|env|knowledge|lessons|memories|scripts|secrets|skills|tasks|wikis|workflows)\/[A-Za-z0-9._/-]+(?:#[A-Za-z0-9._~!$&'()*+,;=:@%/?-]+)?(?![A-Za-z0-9@._+/#$=-])/g;
const AKM_REF_STRICT =
  /^(?:[A-Za-z0-9@._+-]+\/\/)?(?:agents|commands|env|knowledge|lessons|memories|scripts|secrets|skills|tasks|wikis|workflows)\/[A-Za-z0-9._/-]+(?:#[A-Za-z0-9._~!$&'()*+,;=:@%/?-]+)?$/;
const EDGE_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "(", ")", "[", "]", "{", "}", "'", "\"", "`"]);

function normalizeToken(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && EDGE_PUNCTUATION.has(token[start] ?? "")) start += 1;
  while (end > start && EDGE_PUNCTUATION.has(token[end - 1] ?? "")) end -= 1;
  return token.slice(start, end);
}

/** Return all ref-shaped tokens in first-occurrence order, deduplicated. */
export function extractAllRefs(text: string): string[] {
  if (!text) return [];
  const refs = new Set<string>();
  for (const match of text.match(REF_PATTERN) ?? []) {
    const normalized = normalizeToken(match);
    if (AKM_REF_STRICT.test(normalized)) refs.add(normalized);
  }
  return [...refs];
}

/** Return whitespace-delimited tokens that are complete AKM refs. */
export function extractAkmRefsFromString(text: string): string[] {
  const refs = new Set<string>();
  for (const token of text.split(/\s+/)) {
    const normalized = normalizeToken(token);
    if (normalized && AKM_REF_STRICT.test(normalized)) refs.add(normalized);
  }
  return [...refs];
}

interface NormalizedRef {
  canonical: string;
  conceptId: string;
}

function normalizeCandidate(candidate: string): NormalizedRef | null {
  const canonical = normalizeToken(candidate);
  if (!AKM_REF_STRICT.test(canonical)) return null;

  const withoutFragment = canonical.split("#", 1)[0] ?? "";
  const separator = withoutFragment.indexOf("//");
  const conceptId = separator === -1 ? withoutFragment : withoutFragment.slice(separator + 2);
  const segments = conceptId.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;

  return { canonical, conceptId };
}

function isFile(file: string): boolean {
  try {
    return existsSync(file) && statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Resolve a concept ID under any local bundle root without invoking AKM. */
function conceptExistsInAnyBundle(conceptId: string, bundleRoots: readonly string[]): boolean {
  for (const root of bundleRoots) {
    if (!root) continue;
    const resolvedRoot = path.resolve(root);
    const directPath = path.resolve(resolvedRoot, conceptId);
    if (directPath !== resolvedRoot && !directPath.startsWith(`${resolvedRoot}${path.sep}`)) continue;

    if (isFile(directPath) || isFile(`${directPath}.md`)) return true;
    if (isFile(path.join(directPath, "SKILL.md"))) return true;
    if (conceptId.startsWith("memories/") && isFile(`${directPath}.derived.md`)) return true;
  }
  return false;
}

/** Extract and retain only refs whose concept IDs exist in a local bundle. */
export function validateLiveRefs(text: string, bundleRoots: readonly string[]): string[] {
  return validateRefCandidates(extractAllRefs(text), bundleRoots);
}

/**
 * Validate pre-extracted refs against local bundle roots. Bundle qualifiers and
 * fragments are preserved in the result but do not alter local path lookup.
 */
export function validateRefCandidates(candidates: readonly string[], bundleRoots: readonly string[]): string[] {
  if (!candidates || candidates.length === 0) return [];
  const roots = bundleRoots.filter(Boolean);
  if (roots.length === 0) return [];

  const refs = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeCandidate(candidate);
    if (normalized && conceptExistsInAnyBundle(normalized.conceptId, roots)) refs.add(normalized.canonical);
  }
  return [...refs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
