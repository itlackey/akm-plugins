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
//
// The concept-root list is the exact set of directories `akm bundle create`
// scaffolds in 0.9 (agents commands env facts instructions knowledge lessons
// memories scripts secrets sessions skills tasks workflows), which matches the
// `assetTypes` array reported by `akm info --format json` modulo pluralization.
// `wikis` was dropped for 0.9 — it is neither an asset type nor a scaffolded
// directory — and facts/instructions/sessions were added. Keep this list byte
// for byte in sync with opencode/index.ts and evals/tier2/metrics/feedback.ts.
const REF_PATTERN =
  /(?<![A-Za-z0-9@._+/:=-])(?:[A-Za-z0-9@._+-]+\/\/)?(?:agents|commands|env|facts|instructions|knowledge|lessons|memories|scripts|secrets|sessions|skills|tasks|workflows)\/[A-Za-z0-9._/-]+(?:#[A-Za-z0-9._~!$&'()*+,;=:@%/?-]+)?(?![A-Za-z0-9@._+/#$=-])/g;
const AKM_REF_STRICT =
  /^(?:[A-Za-z0-9@._+-]+\/\/)?(?:agents|commands|env|facts|instructions|knowledge|lessons|memories|scripts|secrets|sessions|skills|tasks|workflows)\/[A-Za-z0-9._/-]+(?:#[A-Za-z0-9._~!$&'()*+,;=:@%/?-]+)?$/;
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

// The extensions akm indexes under scripts/ as a script (SCRIPT_EXTENSIONS in
// core/recognition-util.js, 0.9.20). Any other file there is no asset: `akm show`
// reads it off disk and answers without a `ref`, and `akm feedback` refuses it.
const SCRIPT_EXTENSIONS = new Set([
  ".sh", ".ts", ".js", ".ps1", ".cmd", ".bat", ".py", ".rb", ".go", ".pl", ".php", ".lua", ".r", ".swift", ".kt", ".kts",
]);

/** `<id>.md`, or the file itself when the ID spells the extension out (akm toggles it). */
function markdownFile(directPath: string): boolean {
  return isFile(`${directPath}.md`) || (directPath.endsWith(".md") && isFile(directPath));
}

/**
 * Resolve a concept ID under any local bundle root without invoking AKM.
 *
 * A concept ID is the asset's path with the extension its type owns dropped:
 * `.md` for most types (tolerated in the ID too), `.yml` for a task, `.md` or
 * `.yml` for a workflow, `.env` for an env (the default env of a directory is
 * its `.env` file, ID env/default or env/<dir>/default). A skill is its
 * directory. Only scripts/ and secrets/ IDs keep the file's name, a script
 * needs one of akm's script extensions, and a secret is no `.lock` or
 * `.sensitive` marker. This is akm's placement rule (asset-placement.js, 0.9.20),
 * checked type by type against the real binary in fake-akm-contract.test.ts. A
 * file that merely exists is therefore not a ref: `akm show` and `akm feedback`
 * refuse tasks/x.yml, env/x.env, skills/x/SKILL.md, skills/x/scripts/run.py and
 * scripts/x.html.
 *
 * It is a rule, not a second resolver. The index also leaves out what its walk
 * skips (git-ignored files, dot-directories, bin/ and node_modules/, a reserved
 * index.md or log.md) and what it cannot parse (a task or workflow), and it
 * names a file kept outside its type's directory by its path from the bundle
 * root (scripts/skills/x/scripts/run.py); none of that is modelled here. A ref
 * the walk or parser rejects costs one refused probe, since auto-feedback runs
 * `akm show` before it submits.
 */
function conceptExistsInAnyBundle(conceptId: string, bundleRoots: readonly string[]): boolean {
  const type = conceptId.split("/", 1)[0];
  for (const root of bundleRoots) {
    if (!root) continue;
    const resolvedRoot = path.resolve(root);
    const directPath = path.resolve(resolvedRoot, conceptId);
    if (directPath !== resolvedRoot && !directPath.startsWith(`${resolvedRoot}${path.sep}`)) continue;

    if (type === "skills") {
      if (isFile(path.join(directPath, "SKILL.md"))) return true;
    } else if (type === "scripts") {
      if (SCRIPT_EXTENSIONS.has(path.extname(directPath).toLowerCase()) && isFile(directPath)) return true;
    } else if (type === "secrets") {
      if (!/\.(lock|sensitive)$/.test(directPath) && isFile(directPath)) return true;
    } else if (type === "tasks") {
      if (isFile(`${directPath}.yml`)) return true;
    } else if (type === "env") {
      if (isFile(`${directPath}.env`)) return true;
      if (path.basename(directPath) === "default" && isFile(path.join(path.dirname(directPath), ".env"))) return true;
    } else {
      if (markdownFile(directPath)) return true;
      if (type === "workflows" && isFile(`${directPath}.yml`)) return true;
    }
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
