import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  akmRefFromValue,
  extractAkmRefsFromString,
  extractAllRefs,
  extractRefsFromAkmOutput,
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
      "Opaque selectors work too: knowledge/long-guide#akm-fragment-3-1138d4941c9a.",
      "Repeat skills/code-review (deduped).",
    ].join("\n")

    expect(extractAllRefs(text)).toEqual([
      "skills/code-review",
      "knowledge/deploy.md#Rollback",
      "team-playbook//lessons/release-safety#Before-you-start",
      "knowledge/long-guide#akm-fragment-3-1138d4941c9a",
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
        [
          "team-playbook//lessons/release-safety#Before-rollout",
          "lessons/release-safety#Summary",
          "lessons/release-safety#akm-fragment-3-1138d4941c9a",
        ],
        [bundle],
      ),
    ).toEqual([
      "lessons/release-safety#Summary",
      "lessons/release-safety#akm-fragment-3-1138d4941c9a",
      "team-playbook//lessons/release-safety#Before-rollout",
    ])
  })

  it("supports explicit Markdown extensions and derived memories by their own ID", () => {
    const bundle = makeBundle()
    touch(path.join(bundle, "knowledge", "doc.md"))
    touch(path.join(bundle, "memories", "session-x.derived.md"))

    // `<name>.derived.md` is the memory memories/<name>.derived; akm 0.9.20
    // refuses memories/<name> when only the derived file exists.
    expect(validateRefCandidates(["knowledge/doc.md", "memories/session-x.derived", "memories/session-x"], [bundle])).toEqual([
      "knowledge/doc.md",
      "memories/session-x.derived",
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

  it("accepts a ref outside the concept roots once akm named it, but never extracts one from prose", () => {
    const bundle = makeBundle()
    touch(path.join(bundle, "wikis", "legacy-page.md"))

    expect(validateRefCandidates(["wikis/legacy-page"], [bundle])).toEqual(["wikis/legacy-page"])
    expect(extractAllRefs("see wikis/legacy-page and src/app.ts")).toEqual([])
    expect(akmRefFromValue("wikis/legacy-page#intro")).toBe("wikis/legacy-page#intro")
    expect(akmRefFromValue("WORK/plan")).toBe("WORK/plan")
    expect(akmRefFromValue("skills/x/scripts/run.py")).toBe("skills/x/scripts/run.py")
    expect(akmRefFromValue("a/../b")).toBeUndefined()
    expect(akmRefFromValue("two words")).toBeUndefined()
    expect(akmRefFromValue(undefined)).toBeUndefined()
  })

  it("never takes SKILL.md for a ref, and types env/task/secret by an ancestor folder only", () => {
    // akm's recognizer: a skill's ref is its directory; an env/task/secret needs an
    // env/ tasks/ secrets/ folder among the file's ancestors, not as its own name.
    const bundle = makeBundle()
    touch(path.join(bundle, "skills", "rollout", "SKILL.md"))
    touch(path.join(bundle, "notes", "env.env"))
    touch(path.join(bundle, "notes", "tasks.yml"))
    touch(path.join(bundle, "notes", "secrets"))
    touch(path.join(bundle, "notes", "env", "prod.env"))

    expect(
      validateRefCandidates(["skills/rollout/SKILL", "skills/rollout", "notes/env", "notes/tasks", "notes/secrets", "notes/env/prod"], [bundle]),
    ).toEqual(["notes/env/prod", "skills/rollout"])
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

describe("extractRefsFromAkmOutput", () => {
  it("keeps every ref akm emits, whatever its first folder", () => {
    const list = [{ ref: "WORK/plan" }, { ref: "skills/x/scripts/run.py" }, { ref: "reports/data.js" }, { ref: "release" }, { ref: "team//wikis/page#intro" }, { ref: "not a ref" }]
    const refs = ["WORK/plan", "skills/x/scripts/run.py", "reports/data.js", "release", "team//wikis/page#intro"]

    // The list is `results`; older akm named it `hits` (search) or `items` (curate).
    for (const key of ["results", "hits", "items"]) expect(extractRefsFromAkmOutput(JSON.stringify({ [key]: list }))).toEqual(refs)
    expect(extractRefsFromAkmOutput(JSON.stringify({ ref: "WORK/plan", content: "see src/app.ts and skills/a" }))).toEqual(["WORK/plan", "skills/a"])
    expect(extractRefsFromAkmOutput("plain text: skills/a src/app.ts")).toEqual(["skills/a"])
  })

  it("reads the ref: lines of curate's text format, whatever their first folder", () => {
    const text = "1. Plan\n  ref: WORK/plan\n  ref: team//wikis/page\n  ref: reports/data.js\n  note: ref: src/app.ts\n  ref: not a ref\n"
    expect(extractRefsFromAkmOutput(text)).toEqual(["WORK/plan", "team//wikis/page", "reports/data.js"])
  })
})
