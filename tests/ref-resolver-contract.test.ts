// CONTRACT TEST: ref-resolver
// ----------------------------------------------------------------------------
// This test pins the behavior of the asset-ref resolver inlined inside
// `shared/ref-extraction.ts` (and its runtime-shipped twin at
// `claude/shared/ref-extraction.ts`).
//
// A SISTER COPY of this fixture lives in the akm-core repo at
// `tests/contracts/ref-resolver-contract.test.ts`, where it drives the
// resolver inside `src/commands/lint/base-linter.ts` against the SAME
// canonical inputs. The fixture below MUST stay byte-identical (modulo the
// per-repo glue that selects which implementation is exercised). If you
// change a case here, change it there. If you add a new asset type, add it
// to BOTH `refToRelPath` implementations AND extend the fixture in BOTH
// tests.
//
// Why a hand-mirrored fixture instead of a shared package: the akm-plugins
// repo has no dependency on akm-core (and adding one would bloat the
// post-tool hot-path). The fixture is small, deliberate, and stable; drift
// across repos shows up as a contract-test failure on one side as soon as
// the resolver behavior diverges.
//
// Drift detection across the TWO in-repo copies is also covered here — the
// test runs the SAME fixture through both the top-level
// `shared/ref-extraction.ts` and the runtime-shipped
// `claude/shared/ref-extraction.ts`.
// ----------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { validateRefCandidates as validateRefCandidatesTopLevel} from "../claude/shared/ref-extraction"
import { validateRefCandidates as validateRefCandidatesRuntime } from "../claude/shared/ref-extraction"

// ── Fixture builder ──────────────────────────────────────────────────────────
//
// Builds a single canonical stash layout that exercises every reachability
// rule the resolver implements. The same layout is built by the akm-core
// sister test.

function buildFixtureStash(root: string): void {
  // Standard single-file asset types.
  touch(path.join(root, "memories", "rollout-notes.md"))
  touch(path.join(root, "agents", "bunjs-coder.md"))
  touch(path.join(root, "commands", "akm-help.md"))
  touch(path.join(root, "workflows", "release-train.md"))
  touch(path.join(root, "knowledge", "release-notes.md"))
  touch(path.join(root, "lessons", "no-fine-tuning.md"))
  touch(path.join(root, "tasks", "ship-0.8.0.md"))
  touch(path.join(root, "wikis", "akm-internals.md"))

  // Skill multi-file layout.
  touch(path.join(root, "skills", "rollout", "SKILL.md"))

  // Memory `.derived.md` sibling (no plain .md, only the derived file).
  touch(path.join(root, "memories", "session-derived.derived.md"))

  // Knowledge subdirectory layout (knowledge/<category>/<slug>.md).
  touch(path.join(root, "knowledge", "projects", "akm-release.md"))

  // Env: default (.env) and named (<name>.env) — replaces vault.
  touch(path.join(root, "env", ".env"))
  touch(path.join(root, "env", "myapp.env"))

  // Whole-file secrets.
  touch(path.join(root, "secrets", "deploy-key"))

  // Namespaced slug containing `/` — knowledge ref pointing at a file the
  // ref consumer has spelled with the full subpath.
  touch(path.join(root, "knowledge", "projects", "akm", "deep-dive.md"))
}

function touch(file: string, contents = ""): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

// ── Canonical fixture ────────────────────────────────────────────────────────
//
// Each case is { type, slug, reachable }. The contract is: given the stash
// layout above, the resolver returns `reachable` for every case.

interface ContractCase {
  description: string
  type: string
  slug: string
  reachable: boolean
}

const CONTRACT_CASES: ContractCase[] = [
  // ── reachable ─────────────────────────────────────────────────────────
  { description: "existing memory", type: "memory", slug: "rollout-notes", reachable: true },
  { description: "existing agent", type: "agent", slug: "bunjs-coder", reachable: true },
  { description: "existing command", type: "command", slug: "akm-help", reachable: true },
  { description: "existing workflow", type: "workflow", slug: "release-train", reachable: true },
  { description: "existing knowledge (top level)", type: "knowledge", slug: "release-notes", reachable: true },
  { description: "existing lesson", type: "lesson", slug: "no-fine-tuning", reachable: true },
  { description: "existing task", type: "task", slug: "ship-0.8.0", reachable: true },
  { description: "existing wiki", type: "wiki", slug: "akm-internals", reachable: true },
  { description: "skill multi-file layout (SKILL.md inside dir)", type: "skill", slug: "rollout", reachable: true },
  {
    description: "memory backed only by .derived.md sibling",
    type: "memory",
    slug: "session-derived",
    reachable: true,
  },
  {
    description: "knowledge under subdirectory (knowledge/<cat>/<slug>.md)",
    type: "knowledge",
    slug: "akm-release",
    reachable: true,
  },
  {
    description: "namespaced knowledge slug (slug contains '/')",
    type: "knowledge",
    slug: "projects/akm/deep-dive",
    reachable: true,
  },
  { description: "default env (slug='default' -> env/.env)", type: "env", slug: "default", reachable: true },
  { description: "named env (slug='myapp' -> env/myapp.env)", type: "env", slug: "myapp", reachable: true },
  { description: "whole-file secret", type: "secret", slug: "deploy-key", reachable: true },

  // ── not reachable ─────────────────────────────────────────────────────
  { description: "memory pointing at non-existent slug", type: "memory", slug: "no-such-memory", reachable: false },
  {
    description: "agent pointing at non-existent slug",
    type: "agent",
    slug: "no-such-agent",
    reachable: false,
  },
  {
    description: "knowledge pointing at non-existent slug",
    type: "knowledge",
    slug: "no-such-knowledge",
    reachable: false,
  },
  {
    description: "skill pointing at non-existent slug",
    type: "skill",
    slug: "no-such-skill",
    reachable: false,
  },
  {
    description: "env pointing at non-existent slug",
    type: "env",
    slug: "no-such-env",
    reachable: false,
  },
  {
    description: "secret pointing at non-existent slug",
    type: "secret",
    slug: "no-such-secret",
    reachable: false,
  },
  // `script` is intentionally unresolvable by the contract — the type is
  // skipped in `refToRelPath`. Both implementations must agree it never
  // resolves regardless of layout.
  { description: "script type is always unresolvable", type: "script", slug: "any-script", reachable: false },
]

// ── Tests ────────────────────────────────────────────────────────────────────

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeStash(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "akm-ref-contract-"))
  tempDirs.push(dir)
  return dir
}

/**
 * Drive the akm-plugins resolver: feed a single `<type>:<slug>` candidate to
 * `validateRefCandidates` and return whether it survived validation. The
 * validator is the only public entry to the inlined `refExistsInAnyStash` —
 * it returns the candidate iff the resolver reports it reachable.
 *
 * Mirrors the akm-core glue at
 * `tests/contracts/ref-resolver-contract.test.ts#resolveRef`, which composes
 * `refToRelPath` + `refExistsInAnyStash` directly.
 */
function makeResolver(validate: typeof validateRefCandidatesTopLevel) {
  return function resolveRef(type: string, slug: string, stashRoots: string[]): boolean {
    const candidate = `${type}:${slug}`
    const out = validate([candidate], stashRoots)
    return out.length === 1 && out[0] === candidate
  }
}

describe("ref-resolver contract (top-level shared/ref-extraction.ts)", () => {
  const resolveRef = makeResolver(validateRefCandidatesTopLevel)

  test("canonical fixture: every case resolves as the contract specifies", () => {
    const stash = makeStash()
    buildFixtureStash(stash)
    const stashRoots = [stash]

    const failures: string[] = []
    for (const c of CONTRACT_CASES) {
      const actual = resolveRef(c.type, c.slug, stashRoots)
      if (actual !== c.reachable) {
        failures.push(
          `  - [${c.type}:${c.slug}] (${c.description}): expected reachable=${c.reachable}, got ${actual}`,
        )
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `ref-resolver contract drift detected (${failures.length} case(s)):\n${failures.join("\n")}\n\n` +
          "If you intentionally changed the resolver behavior, update BOTH this fixture\n" +
          "and the sister fixture in the akm-core repo at\n" +
          "  tests/contracts/ref-resolver-contract.test.ts\n" +
          "in the same coordinated change.",
      )
    }
    expect(CONTRACT_CASES.length).toBeGreaterThanOrEqual(20)
  })

  test("script type is always unresolvable regardless of layout", () => {
    const stash = makeStash()
    buildFixtureStash(stash)
    touch(path.join(stash, "scripts", "any-script.md"))
    expect(resolveRef("script", "any-script", [stash])).toBe(false)
  })

  test("unknown asset type is unresolvable", () => {
    const stash = makeStash()
    buildFixtureStash(stash)
    expect(resolveRef("not-a-real-type", "anything", [stash])).toBe(false)
  })
})

describe("ref-resolver contract (runtime claude/shared/ref-extraction.ts)", () => {
  const resolveRef = makeResolver(validateRefCandidatesRuntime)

  test("canonical fixture: every case resolves as the contract specifies", () => {
    const stash = makeStash()
    buildFixtureStash(stash)
    const stashRoots = [stash]

    const failures: string[] = []
    for (const c of CONTRACT_CASES) {
      const actual = resolveRef(c.type, c.slug, stashRoots)
      if (actual !== c.reachable) {
        failures.push(
          `  - [${c.type}:${c.slug}] (${c.description}): expected reachable=${c.reachable}, got ${actual}`,
        )
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `runtime ref-resolver contract drift detected (${failures.length} case(s)):\n${failures.join("\n")}\n\n` +
          "The runtime-shipped copy at claude/shared/ref-extraction.ts has drifted from\n" +
          "the contract. Update both in-repo copies (claude/shared/ and shared/) AND\n" +
          "the akm-core sister copy in lockstep.",
      )
    }
  })

  test("script type is always unresolvable regardless of layout", () => {
    const stash = makeStash()
    buildFixtureStash(stash)
    touch(path.join(stash, "scripts", "any-script.md"))
    expect(resolveRef("script", "any-script", [stash])).toBe(false)
  })

  test("unknown asset type is unresolvable", () => {
    const stash = makeStash()
    buildFixtureStash(stash)
    expect(resolveRef("not-a-real-type", "anything", [stash])).toBe(false)
  })
})
