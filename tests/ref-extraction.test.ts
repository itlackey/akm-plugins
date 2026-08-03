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
