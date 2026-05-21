/**
 * AKM ref extraction & live-stash validation.
 *
 * Background: session-checkpoint memories captured by the hook embed Bash
 * command bodies verbatim — heredocs, grep patterns, jq queries, JSON
 * payloads. Naive ref extraction (`text.match(REF_PATTERN)`) treats every
 * `<type>:<slug>` token as a real reference, which causes `akm lint` to
 * flag string-literal tokens as `missing-ref`. The next session capture
 * regenerates the same flags — a permanent lint treadmill.
 *
 * The fix (this module): we drop the "guess from context" heuristic and
 * instead **validate every candidate against the live local stash**. A
 * token only graduates from "candidate" to "ref" when the referenced asset
 * actually exists on disk. Anything that doesn't resolve is silently
 * dropped — including all the literal-string false positives.
 *
 * The validation logic mirrors the consumer-side lint walker
 * (`src/commands/lint/base-linter.ts#refExistsInAnyStash`). We deliberately
 * inline a small copy here (rather than spawn a subprocess) so the hook's
 * post-tool path stays cheap (zero subprocess, zero JSON parse). The two
 * resolvers must stay in sync; any new asset type added to lint's
 * `refToRelPath` must be added here too.
 */

// CONTRACT: ref-resolver
// ----------------------------------------------------------------------------
// The `refExistsInAnyStash` and `refToRelPath` helpers below are
// contract-locked: a sister copy lives in the akm-core repo at
// `src/commands/lint/base-linter.ts`. Both implementations resolve the same
// `<type>:<slug>` -> on-disk-asset question and MUST agree on the set of
// reachable refs for any given stash layout.
//
// The lock is enforced by `tests/ref-resolver-contract.test.ts`, which drives
// `validateRefCandidates` (the only public entry to this resolver) through a
// canonical fixture set. The akm-core repo ships an equivalent test at
// `tests/contracts/ref-resolver-contract.test.ts` that drives ITS copy
// through the SAME inputs. Any change to the resolver behavior on either
// side MUST update both contract tests in lockstep, or one will fail.
//
// Cases the contract covers (see fixture in the contract test):
//   - existing memory / knowledge / agent / workflow / skill / vault refs
//   - knowledge subdirectory layout (knowledge/<category>/<slug>.md)
//   - skill multi-file layout (skills/<slug>/SKILL.md)
//   - memory `.derived.md` sibling
//   - vault default vs named (.env vs <name>.env)
//   - namespaced slugs containing `/`
//   - non-existent refs
//   - script type (unresolvable by design — both must return false)
// ----------------------------------------------------------------------------

import { existsSync, statSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * Permissive ref regex. Matches `[origin//]type:slug` for the known asset
 * types. Origins (e.g. `local//`, `npm:foo//`) are tolerated but stripped
 * before validation — only `local//` refs are resolvable against the local
 * stash; anything else is dropped because we cannot validate it offline.
 *
 * Kept in sync with the lint walker pattern in
 * `src/commands/lint/base-linter.ts`.
 */
const REF_PATTERN =
  /(?:[A-Za-z0-9@._+/-]+\/\/)?(?:skill|command|agent|knowledge|memory|lesson|script|workflow|vault|wiki):[A-Za-z0-9._/-]+/g;

/**
 * Return every `<type>:<slug>` token in `text` regardless of context.
 * Order matches first-occurrence; duplicates are removed.
 */
export function extractAllRefs(text: string): string[] {
  if (!text) return [];
  return [...new Set(text.match(REF_PATTERN) ?? [])];
}

/**
 * Map ref type → relative path within a stash root.
 * Returns `null` for types that cannot be resolved by direct path
 * (scripts live in nested dirs; remote-only types).
 */
function refToRelPath(refType: string, refName: string): string | null {
  switch (refType) {
    case "agent":
      return path.join("agents", `${refName}.md`);
    case "command":
      return path.join("commands", `${refName}.md`);
    case "knowledge":
      return path.join("knowledge", `${refName}.md`);
    case "memory":
      return path.join("memories", `${refName}.md`);
    case "script":
      return null; // scripts live in nested dirs — skip
    case "skill":
      return path.join("skills", refName, "SKILL.md");
    case "workflow":
      return path.join("workflows", `${refName}.md`);
    case "lesson":
      return path.join("lessons", `${refName}.md`);
    case "task":
      return path.join("tasks", `${refName}.md`);
    case "wiki":
      return path.join("wikis", `${refName}.md`);
    case "vault":
      if (!refName || refName === "default") return path.join("vaults", ".env");
      return path.join("vaults", `${refName}.env`);
    default:
      return null;
  }
}

/**
 * True if `<type>:<refName>` resolves to a real file under any provided
 * stash root. Mirrors `refExistsInAnyStash` in `src/commands/lint/base-linter.ts`.
 */
function refExistsInAnyStash(refType: string, refName: string, stashRoots: readonly string[]): boolean {
  const relPath = refToRelPath(refType, refName);
  if (!relPath) return false;
  for (const root of stashRoots) {
    if (!root) continue;
    const absPath = path.join(root, relPath);
    if (existsSync(absPath)) return true;
    // Multi-file skill layout: directory containing SKILL.md
    const bareDir = absPath.replace(/\.md$/, "");
    try {
      if (existsSync(bareDir) && existsSync(path.join(bareDir, "SKILL.md"))) return true;
    } catch {
      // ignore
    }
    // .derived.md variant for memory refs
    if (refType === "memory") {
      const derivedPath = path.join(root, "memories", `${refName}.derived.md`);
      if (existsSync(derivedPath)) return true;
    }
    // Knowledge subdirectory layout (knowledge/projects/foo/...)
    if (refType === "knowledge") {
      try {
        const knowledgeDir = path.join(root, "knowledge");
        if (existsSync(knowledgeDir) && statSync(knowledgeDir).isDirectory()) {
          for (const entry of readdirSync(knowledgeDir)) {
            const subPath = path.join(knowledgeDir, entry, `${refName}.md`);
            if (existsSync(subPath)) return true;
          }
        }
      } catch {
        // ignore
      }
    }
    // Fallback: refName already encodes the stash-relative path
    const directPath = path.join(root, `${refName}.md`);
    if (existsSync(directPath)) return true;
    const directDir = path.join(root, refName);
    try {
      if (existsSync(directDir) && existsSync(path.join(directDir, "SKILL.md"))) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

/**
 * Drop candidate tokens that obviously cannot resolve:
 * - Embedded shell expansion: `memory:$(cmd)`, `knowledge:${VAR}`
 * - ACP type notation: `agent::Type`
 * - Empty / placeholder slugs: single char, `**`, leading `/`, `~`, `http*`
 * - Remote origins other than `local//` (cannot be validated offline)
 */
function normalizeCandidate(fullRef: string): { type: string; name: string } | null {
  if (fullRef.includes("$(") || fullRef.includes("${")) return null;
  if (fullRef.includes("::")) return null;

  let ref = fullRef;
  if (ref.startsWith("local//")) {
    ref = ref.slice("local//".length);
  } else if (ref.includes("//")) {
    return null; // remote origin — cannot validate locally
  }

  const colonIdx = ref.indexOf(":");
  if (colonIdx === -1) return null;
  const type = ref.slice(0, colonIdx);
  const name = ref.slice(colonIdx + 1);
  if (!name || name.startsWith("/") || name.startsWith("~") || name.startsWith("http")) return null;
  if (name.length <= 1 || name === "**") return null;
  // Slug must not contain shell metacharacters — pipe etc. would be a
  // pasted regex like `memory:foo|knowledge:bar`.
  if (/[|&;<>(){}\[\]"`'\\?*]/.test(name)) return null;
  return { type, name };
}

/**
 * Given an arbitrary block of text and one or more stash roots, return the
 * subset of `<type>:<slug>` tokens that actually resolve to a real asset
 * on disk. String literals (heredocs, grep patterns, jq queries) are
 * silently dropped — they don't exist in the stash and therefore cannot
 * generate `missing-ref` lint flags after the body is captured.
 *
 * The returned list is sorted alphabetically and deduplicated.
 */
export function validateLiveRefs(text: string, stashRoots: readonly string[]): string[] {
  return validateRefCandidates(extractAllRefs(text), stashRoots);
}

/**
 * Validate a pre-extracted list of candidate refs against one or more
 * stash roots. Returns the subset that resolve to a real on-disk asset,
 * sorted alphabetically and deduplicated. The input is typically produced
 * by `extractAllRefs(...)` on raw command/output text — the producer-side
 * collection step is permissive so candidates can be accumulated across
 * tool invocations and validated once at memory-capture time.
 */
export function validateRefCandidates(candidates: readonly string[], stashRoots: readonly string[]): string[] {
  if (!candidates || candidates.length === 0) return [];
  const roots = stashRoots.filter(Boolean);
  if (roots.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const norm = normalizeCandidate(candidate);
    if (!norm) continue;
    if (!refExistsInAnyStash(norm.type, norm.name, roots)) continue;
    const canonical = `${norm.type}:${norm.name}`;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}
