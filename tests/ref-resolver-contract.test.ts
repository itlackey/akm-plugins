// CONTRACT TEST: AKM 0.9 concept refs resolve directly under bundle roots.
// Keep this fixture aligned with the core resolver contract.

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { validateRefCandidates } from "../claude/shared/ref-extraction"

const tempDirs: string[] = []

function touch(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, "")
}

function makeBundle(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "akm-ref-contract-"))
  tempDirs.push(dir)
  touch(path.join(dir, "skills", "rollout", "SKILL.md"))
  touch(path.join(dir, "knowledge", "release-notes.md"))
  touch(path.join(dir, "knowledge", "projects", "akm", "deep-dive.md"))
  touch(path.join(dir, "memories", "rollout-notes.md"))
  touch(path.join(dir, "memories", "session-derived.derived.md"))
  touch(path.join(dir, "lessons", "no-fine-tuning.md"))
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("AKM 0.9 ref-resolver contract", () => {
  test("resolves canonical concept paths under a bundle root", () => {
    const bundle = makeBundle()
    const candidates = [
      "skills/rollout",
      "knowledge/release-notes",
      "knowledge/release-notes.md",
      "knowledge/projects/akm/deep-dive",
      "memories/rollout-notes",
      "memories/session-derived",
      "lessons/no-fine-tuning",
      "knowledge/missing",
    ]

    expect(validateRefCandidates(candidates, [bundle])).toEqual([
      "knowledge/projects/akm/deep-dive",
      "knowledge/release-notes",
      "knowledge/release-notes.md",
      "lessons/no-fine-tuning",
      "memories/rollout-notes",
      "memories/session-derived",
      "skills/rollout",
    ])
  })

  test("uses the concept path for qualified and fragmented refs", () => {
    const bundle = makeBundle()
    expect(
      validateRefCandidates(
        ["team-playbook//lessons/no-fine-tuning#Why", "team-playbook//lessons/missing#Why"],
        [bundle],
      ),
    ).toEqual(["team-playbook//lessons/no-fine-tuning#Why"])
  })

  test("does not resolve paths outside the bundle root", () => {
    const bundle = makeBundle()
    touch(path.join(bundle, "..", "outside.md"))
    expect(validateRefCandidates(["memories/../../outside", "../outside"], [bundle])).toEqual([])
  })
})
