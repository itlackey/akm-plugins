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
import { akmResultList } from "./result-list";

// Passive extraction is intentionally narrower than AKM's explicit ref parser:
// only standard concept roots are observed. This prevents ordinary paths such
// as src/app.ts from becoming automatic feedback targets.
//
// The concept-root list is the exact set of directories `akm bundle create`
// scaffolds in 0.9 (agents commands env facts instructions knowledge lessons
// memories scripts secrets sessions skills tasks workflows), which matches the
// `assetTypes` array reported by `akm doctor info --format json` modulo pluralization.
// `wikis` was dropped for 0.9 — it is neither an asset type nor a scaffolded
// directory — and facts/instructions/sessions were added. Keep this list byte
// for byte in sync with opencode/index.ts and evals/tier2/metrics/feedback.ts.
const REF_PATTERN =
  /(?<![A-Za-z0-9@._+/:=-])(?:[A-Za-z0-9@._+-]+\/\/)?(?:agents|commands|env|facts|instructions|knowledge|lessons|memories|scripts|secrets|sessions|skills|tasks|workflows)\/[A-Za-z0-9._/-]+(?:#[A-Za-z0-9._~!$&'()*+,;=:@%/?-]+)?(?![A-Za-z0-9@._+/#$=-])/g;
// An akm ref is the asset's bundle-relative path minus its type suffix (akm#1432),
// so its first folder says nothing about its type and may be any folder (`WORK/plan`,
// `reports/data.js`) or absent (`release`). This is the whole-token grammar: any
// ref akm emits. It is no filter on prose; the allowlist above is.
const AKM_REF_STRICT =
  /^(?:[A-Za-z0-9@._+-]+\/\/)?[A-Za-z0-9@._+-]+(?:\/[A-Za-z0-9._+@-]+)*(?:#[A-Za-z0-9._~!$&'()*+,;=:@%/?-]+)?$/;
const CONCEPT_ROOT_REF =
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

/**
 * Return whitespace-delimited tokens that are complete refs under a concept
 * root. Free text is scanned, so the concept-root allowlist still applies; use
 * {@link akmRefFromValue} for a value akm itself produced or was given as a ref.
 */
export function extractAkmRefsFromString(text: string): string[] {
  const refs = new Set<string>();
  for (const token of text.split(/\s+/)) {
    const normalized = normalizeToken(token);
    if (normalized && CONCEPT_ROOT_REF.test(normalized)) refs.add(normalized);
  }
  return [...refs];
}

/**
 * The ref in a field that holds one (`ref` of a search/curate/show result, the
 * `ref` argument of an akm call), whatever its first folder. akm decides what a
 * ref is; this only rejects values that cannot be one.
 */
export function akmRefFromValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ref = value.trim();
  return AKM_REF_STRICT.test(ref) && !ref.split("#", 1)[0].split("//").pop()!.split("/").some((s) => s === "." || s === "..") ? ref : undefined;
}

/**
 * The `ref` of a parsed akm result and of its result list (`results`, `hits` or `items`: search,
 * curate, show), whatever their first folder.
 */
export function refsOfAkmResult(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  const entries = [r, ...akmResultList(r)];
  const refs = entries.map((e) => (e && typeof e === "object" ? akmRefFromValue((e as Record<string, unknown>).ref) : undefined));
  return [...new Set(refs.filter((ref): ref is string => !!ref))];
}

/**
 * Refs in the text of an akm result: {@link refsOfAkmResult} for JSON, the
 * `ref:` lines of text-format output, plus any concept-root ref in the text.
 */
export function extractRefsFromAkmOutput(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const refLines = [...text.matchAll(/^\s*ref:\s*(\S+)\s*$/gm)].map((m) => akmRefFromValue(m[1]));
  return [...new Set([...refsOfAkmResult(parsed), ...refLines.filter((r): r is string => !!r), ...extractAkmRefsFromString(text)])];
}

interface NormalizedRef {
  canonical: string;
  conceptId: string;
}

function normalizeCandidate(candidate: string): NormalizedRef | null {
  const canonical = normalizeToken(candidate);
  const ref = akmRefFromValue(canonical);
  if (!ref) return null;

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

// The extensions akm indexes as a script (SCRIPT_EXTENSIONS in
// core/recognition-util.js, 0.9.20). Any other file there is no asset: `akm show`
// reads it off disk and answers without a `ref`, and `akm feedback` refuses it.
const SCRIPT_EXTENSIONS = new Set([
  ".sh", ".ts", ".js", ".ps1", ".cmd", ".bat", ".py", ".rb", ".go", ".pl", ".php", ".lua", ".r", ".swift", ".kt", ".kts",
]);

/** `<id>.md`, or the file itself when the ID spells the extension out (akm toggles it). */
function markdownFile(directPath: string): boolean {
  if (path.basename(directPath).replace(/\.md$/, "") === "SKILL") return false;
  return isFile(`${directPath}.md`) || (directPath.endsWith(".md") && isFile(directPath));
}

/**
 * Is there an asset whose ref is `directPath` (the ref resolved under a bundle
 * root)? A ref is the file's bundle-relative path minus its type's suffix (akm
 * #1432): `.md` for the markdown types (tolerated in the ref too), `/SKILL.md`
 * for a skill, `.env` for an env (`default` names the directory's `.env`), `.yml`
 * for a task; a script keeps its extension and a secret its name. The check is
 * by suffix and never by the ref's first folder, which no longer says what the
 * file is. A file that merely exists is no ref: `akm show` and `akm feedback`
 * refuse tasks/x.yml, env/x.env, skills/x/SKILL.md, workflows/x.yml and
 * scripts/x.html. An env/task/secret still has to sit under a folder of that
 * name, since only the folder tells those files from any other `.env`/`.yml`/bare file.
 *
 * It is a rule, not a second resolver. The index also leaves out what its walk
 * skips (git-ignored files, dot-directories, bin/ and node_modules/, a reserved
 * index.md or log.md) and what it cannot parse; none of that is modelled here.
 * A ref the walk or parser rejects costs one refused probe, since
 * auto-feedback runs `akm show` before it submits.
 */
function isAsset(directPath: string, ref: string): boolean {
  if (isFile(path.join(directPath, "SKILL.md")) || markdownFile(directPath)) return true;
  if (SCRIPT_EXTENSIONS.has(path.extname(directPath).toLowerCase()) && isFile(directPath)) return true;
  const folders = ref.split("/").slice(0, -1);
  if (folders.includes("env")) {
    if (isFile(`${directPath}.env`)) return true;
    if (path.basename(directPath) === "default" && isFile(path.join(path.dirname(directPath), ".env"))) return true;
  }
  if (folders.includes("tasks") && isFile(`${directPath}.yml`)) return true;
  return folders.includes("secrets") && !/\.(lock|sensitive)$/.test(directPath) && isFile(directPath);
}

// akm before #1432 named a file kept outside its type's directory with that
// folder in front (`scripts/skills/x/scripts/run.py`, `knowledge/wikis/page`) and
// resolves the old spelling everywhere, with one warning (akm#1434, akm#1440). These
// are the folders it used.
const LEGACY_PREFIXES = new Set(["scripts", "agents", "commands", "facts", "instructions", "knowledge", "lessons", "memories", "sessions"]);

/** Resolve a ref under any local bundle root without invoking AKM. */
function conceptExistsInAnyBundle(conceptId: string, bundleRoots: readonly string[]): boolean {
  const head = conceptId.split("/", 1)[0];
  const rest = conceptId.slice(head.length + 1);
  for (const root of bundleRoots) {
    if (!root) continue;
    const resolvedRoot = path.resolve(root);
    const inside = (file: string) => file !== resolvedRoot && file.startsWith(`${resolvedRoot}${path.sep}`);
    const directPath = path.resolve(resolvedRoot, conceptId);
    if (inside(directPath) && isAsset(directPath, conceptId)) return true;

    if (LEGACY_PREFIXES.has(head) && rest.includes("/")) {
      const legacyPath = path.resolve(resolvedRoot, rest);
      if (inside(legacyPath) && isAsset(legacyPath, rest)) return true;
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
