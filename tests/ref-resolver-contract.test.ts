// CONTRACT TEST: AKM 0.9 concept refs resolve directly under bundle roots.
// Keep this fixture aligned with the core resolver contract.
//
// The fixture mirrors the directory layout `akm bundle create` scaffolds in
// 0.9 — agents commands env facts instructions knowledge lessons memories
// scripts secrets sessions skills tasks workflows — verified against
// akm-cli@0.9.2 (stable). `wikis` is deliberately absent: it is neither in
// `akm info --format json`'s assetTypes nor scaffolded by `bundle create`, so
// including it would assert a contract the sister implementation does not
// have. facts/, instructions/ and sessions/ are the roots added since 0.8.

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
  touch(path.join(dir, "facts", "pricing-tiers.md"))
  touch(path.join(dir, "instructions", "pr-review.md"))
  touch(path.join(dir, "sessions", "2026-08-03-retro.md"))
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
      "facts/pricing-tiers",
      "instructions/pr-review",
      "sessions/2026-08-03-retro",
      "knowledge/missing",
    ]

    expect(validateRefCandidates(candidates, [bundle])).toEqual([
      "facts/pricing-tiers",
      "instructions/pr-review",
      "knowledge/projects/akm/deep-dive",
      "knowledge/release-notes",
      "knowledge/release-notes.md",
      "lessons/no-fine-tuning",
      "memories/rollout-notes",
      "memories/session-derived",
      "sessions/2026-08-03-retro",
      "skills/rollout",
    ])
  })

  test("does not resolve concept roots the 0.9 bundle layout no longer defines", () => {
    // `wikis` was a 0.8-era root. A bundle upgraded in place may still carry
    // the directory, but 0.9 neither scaffolds it nor reports it in
    // assetTypes, so the resolver must treat it as an ordinary path.
    const bundle = makeBundle()
    touch(path.join(bundle, "wikis", "legacy-page.md"))
    touch(path.join(bundle, "vaults", "legacy-vault.md"))

    expect(validateRefCandidates(["wikis/legacy-page", "vaults/legacy-vault"], [bundle])).toEqual([])
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
