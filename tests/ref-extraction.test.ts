import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  extractAkmRefsFromString,
  extractAllRefs,
  validateLiveRefs,
  validateRefCandidates,
} from "../claude/shared/ref-extraction"

const tempDirs: string[] = []

function makeBundle() {
  const dir = mkdtempSync(path.join(tmpdir(), "akm-ref-extraction-"))
  tempDirs.push(dir)
  return dir
}

function touch(file: string, contents = "") {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("extractAllRefs", () => {
  it("does not classify ordinary repository paths as AKM refs", () => {
    expect(extractAllRefs("Changed src/app.ts and docs/guide.md; used skills/code-review.")).toEqual([
      "skills/code-review",
    ])
  })

  it("extracts concept refs with bundles and heading fragments", () => {
    const text = [
      "Use skills/code-review, then knowledge/deploy.md#Rollback.",
      "Also team-playbook//lessons/release-safety#Before-you-start!",
      "Repeat skills/code-review (deduped).",
    ].join("\n")

    expect(extractAllRefs(text)).toEqual([
      "skills/code-review",
      "knowledge/deploy.md#Rollback",
      "team-playbook//lessons/release-safety#Before-you-start",
    ])
  })

  it("extracts candidates around shell separators without accepting retired refs", () => {
    expect(extractAllRefs("grep 'memories/foo|knowledge/bar.md' skill:retired skills/partial$(cmd)")).toEqual([
      "memories/foo",
      "knowledge/bar.md",
    ])
  })

  it("returns an empty list when no refs are present", () => {
    expect(extractAllRefs("")).toEqual([])
    expect(extractAllRefs("nothing-to-see-here")).toEqual([])
  })

  it("observes the 0.9 concept roots added since 0.8 (facts, instructions, sessions)", () => {
    // `akm bundle create` scaffolds facts/, instructions/ and sessions/ in 0.9
    // and `akm info --format json` lists fact, instruction and session in
    // assetTypes. Refs to them were previously invisible to passive extraction,
    // so they could never be observed or receive automatic feedback.
    expect(
      extractAllRefs("See facts/pricing-tiers, instructions/pr-review.md, and sessions/2026-08-03-retro."),
    ).toEqual(["facts/pricing-tiers", "instructions/pr-review.md", "sessions/2026-08-03-retro"])
  })

  it("covers exactly the 0.9 concept roots — no wikis, no vaults", () => {
    // The canonical list is the set of directories `akm bundle create`
    // scaffolds: agents commands env facts instructions knowledge lessons
    // memories scripts secrets sessions skills tasks workflows.
    const roots = [
      "agents",
      "commands",
      "env",
      "facts",
      "instructions",
      "knowledge",
      "lessons",
      "memories",
      "scripts",
      "secrets",
      "sessions",
      "skills",
      "tasks",
      "workflows",
    ]
    for (const root of roots) {
      expect(extractAllRefs(`touched ${root}/example today`)).toEqual([`${root}/example`])
    }
    // `wikis` was retired for 0.9: it is neither an asset type nor a
    // scaffolded bundle directory, so it must read as an ordinary path.
    for (const retired of ["wikis", "vaults", "src", "docs", "node_modules"]) {
      expect(extractAllRefs(`touched ${retired}/example today`)).toEqual([])
    }
  })
})

describe("extractAkmRefsFromString", () => {
  it("handles surrounding punctuation and requires complete tokens", () => {
    expect(extractAkmRefsFromString("(skills/foo), knowledge/doc.md#Heading. xskills/nope")).toEqual([
      "skills/foo",
      "knowledge/doc.md#Heading",
    ])
    expect(extractAkmRefsFromString("skills/foo|knowledge/doc.md")).toEqual([])
  })
})

describe("validateRefCandidates", () => {
  it("keeps only concept IDs that resolve in a bundle root", () => {
    const bundle = makeBundle()
    touch(path.join(bundle, "skills", "rollout", "SKILL.md"))
    touch(path.join(bundle, "knowledge", "projects", "akm", "release-notes.md"))
    touch(path.join(bundle, "memories", "real-memory.md"))

    expect(
      validateRefCandidates(
        [
          "skills/rollout",
          "knowledge/projects/akm/release-notes",
          "memories/real-memory",
          "memories/missing",
        ],
        [bundle],
      ),
    ).toEqual(["knowledge/projects/akm/release-notes", "memories/real-memory", "skills/rollout"])
  })

  it("preserves bundle qualifiers and fragments while validating the concept path", () => {
    const bundle = makeBundle()
    touch(path.join(bundle, "lessons", "release-safety.md"), "# Before rollout")

    expect(
      validateRefCandidates(
        ["team-playbook//lessons/release-safety#Before-rollout", "lessons/release-safety#Summary"],
        [bundle],
      ),
    ).toEqual(["lessons/release-safety#Summary", "team-playbook//lessons/release-safety#Before-rollout"])
  })

  it("supports explicit Markdown extensions and derived memories", () => {
    const bundle = makeBundle()
    touch(path.join(bundle, "knowledge", "doc.md"))
    touch(path.join(bundle, "memories", "session-x.derived.md"))

    expect(validateRefCandidates(["knowledge/doc.md", "memories/session-x"], [bundle])).toEqual([
      "knowledge/doc.md",
      "memories/session-x",
    ])
  })

  it("resolves the 0.9 concept roots added since 0.8 (facts, instructions, sessions)", () => {
    const bundle = makeBundle()
    touch(path.join(bundle, "facts", "pricing-tiers.md"))
    touch(path.join(bundle, "instructions", "pr-review.md"))
    touch(path.join(bundle, "sessions", "2026-08-03-retro.md"))

    expect(
      validateRefCandidates(
        [
          "facts/pricing-tiers",
          "instructions/pr-review",
          "sessions/2026-08-03-retro",
          "instructions/missing",
        ],
        [bundle],
      ),
    ).toEqual(["facts/pricing-tiers", "instructions/pr-review", "sessions/2026-08-03-retro"])
  })

  it("rejects retired roots even when the file exists on disk", () => {
    // A bundle carried over from 0.8 may still have wikis/ on disk; 0.9 does
    // not scaffold or recognize it, so it must never validate as a ref.
    const bundle = makeBundle()
    touch(path.join(bundle, "wikis", "legacy-page.md"))

    expect(validateRefCandidates(["wikis/legacy-page"], [bundle])).toEqual([])
  })

  it("rejects traversal, malformed, retired, and shell-like candidates", () => {
    const bundle = makeBundle()
    touch(path.join(bundle, "memories", "real.md"))

    expect(
      validateRefCandidates(
        ["memories/../outside", "memories/$(cmd)", "memory:real", "memories/real|knowledge/doc", "memories/real"],
        [bundle],
      ),
    ).toEqual(["memories/real"])
  })

  it("returns sorted, deduplicated refs and requires bundle roots", () => {
    const bundle = makeBundle()
    touch(path.join(bundle, "memories", "beta.md"))
    touch(path.join(bundle, "memories", "alpha.md"))

    expect(validateRefCandidates(["memories/beta", "memories/alpha", "memories/beta"], [bundle])).toEqual([
      "memories/alpha",
      "memories/beta",
    ])
    expect(validateRefCandidates(["memories/alpha"], [])).toEqual([])
  })
})

describe("validateLiveRefs", () => {
  it("filters ref-shaped transcript literals against the bundle", () => {
    const bundle = makeBundle()
    touch(path.join(bundle, "memories", "rollout-notes.md"))
    touch(path.join(bundle, "skills", "bun-review", "SKILL.md"))

    const transcript = `
Use memories/rollout-notes.
grep 'memories/missing|knowledge/projects/akm/missing' file.md
skills/bun-review handled it.
`
    expect(validateLiveRefs(transcript, [bundle])).toEqual(["memories/rollout-notes", "skills/bun-review"])
  })
})
