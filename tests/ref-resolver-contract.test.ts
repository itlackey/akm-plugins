// CONTRACT TEST: AKM 0.9 concept refs resolve directly under bundle roots.
// Keep this fixture aligned with the core resolver contract.
//
// The fixture mirrors the directory layout `akm bundle create` scaffolds in
// 0.9 — agents commands env facts instructions knowledge lessons memories
// scripts secrets sessions skills tasks workflows — verified against
// akm-cli@0.9.14 (stable). `wikis` is deliberately absent: it is neither in
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
      "memories/session-derived.derived",
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
      "memories/session-derived.derived",
      "sessions/2026-08-03-retro",
      "skills/rollout",
    ])
  })

  test("does not resolve a file path AKM would reject as a ref", () => {
    // Verified against akm-cli 0.9.20: a concept ID is the asset's path with
    // the type's own extension dropped, and a skill is its directory. Only
    // scripts/ and secrets/ IDs keep the file's name, and `.md` is tolerated on
    // the markdown types. Every file below exists, and `akm show` /
    // `akm feedback` answer "not found" / "not in the index" for each path that
    // is not in the expected list (157 of the 238 auto-feedback failures on one
    // machine were tasks/*.yml, files inside skills, and backup files).
    const bundle = makeBundle()
    touch(path.join(bundle, "tasks", "nightly.yml"))
    touch(path.join(bundle, "skills", "rollout", "scripts", "run.py"))
    touch(path.join(bundle, "skills", "rollout", "references", "notes.md"))
    touch(path.join(bundle, "knowledge", "release-notes.md.bak"))
    touch(path.join(bundle, "scripts", "deploy.sh"))
    touch(path.join(bundle, "secrets", "api-token"))

    expect(
      validateRefCandidates(
        [
          "tasks/nightly.yml",
          "skills/rollout/SKILL.md",
          "skills/rollout/scripts/run.py",
          "skills/rollout/references/notes.md",
          "knowledge/release-notes.md.bak",
          "skills/rollout",
          "knowledge/release-notes.md",
          "scripts/deploy.sh",
          "secrets/api-token",
        ],
        [bundle],
      ),
    ).toEqual(["knowledge/release-notes.md", "scripts/deploy.sh", "secrets/api-token", "skills/rollout"])
  })

  test("resolves a task, a workflow and an env file by the ID akm gives them", () => {
    // Checked against akm-cli 0.10.26101002-alpha: a task is tasks/<id>.yml and its ID drops
    // the extension; a workflow is <id>.md only (the GitHub-shaped .yml workflow
    // was removed in 0.10, so a stray workflows/x.yml names nothing); an env is <name>.env, and `.env` and `default.env` are the default of
    // their directory, env/default or env/<dir>/default. `.yaml` is no task.
    // fake-akm-contract.test.ts runs the same refs through the real binary.
    const bundle = makeBundle()
    touch(path.join(bundle, "tasks", "nightly.yml"))
    touch(path.join(bundle, "tasks", "legacy.yaml"))
    touch(path.join(bundle, "workflows", "ship.yml"))
    touch(path.join(bundle, "workflows", "release.md"))
    touch(path.join(bundle, "env", "staging.env"))
    touch(path.join(bundle, "env", "prod.env.bak"))
    touch(path.join(bundle, "env", ".env"))
    touch(path.join(bundle, "env", "team", ".env"))

    expect(
      validateRefCandidates(
        [
          "tasks/nightly",
          "workflows/ship",
          "workflows/release",
          "workflows/release.md",
          "env/staging",
          "env/default",
          "env/team/default",
          "tasks/nightly.yml",
          "tasks/legacy",
          "tasks/legacy.yaml",
          "workflows/ship.yml",
          "env/staging.env",
          "env/prod.env.bak",
          "env/prod",
          "env/.env",
          "env/team/.env",
        ],
        [bundle],
      ),
    ).toEqual([
      "env/default",
      "env/staging",
      "env/team/default",
      "tasks/nightly",
      "workflows/release",
      "workflows/release.md",
    ])
  })

  test("resolves a script or markdown file kept outside its type's directory by its path from the bundle root", () => {
    // akm resolves a concept ID against its type's directory and, for a file
    // kept elsewhere in the bundle, against the bundle root: a skill's script is
    // scripts/skills/x/scripts/run.py and its reference page knowledge/skills/x/
    // references/notes, a page under wikis/ is knowledge/wikis/page (checked
    // against 0.9.20, where fake-akm-contract.test.ts runs the same refs through
    // the real binary). Not a file at the bundle root, which akm does not index,
    // and not an ID that repeats its type's directory.
    const bundle = makeBundle()
    for (const file of ["skills/rollout/scripts/run.py", "skills/rollout/references/notes.md", "wikis/page.md", "eval/check.ts", "top.md", "topscript.sh"]) {
      touch(path.join(bundle, file))
    }
    touch(path.join(bundle, "scripts", "deploy.sh"))

    expect(
      validateRefCandidates(
        [
          "scripts/skills/rollout/scripts/run.py",
          "knowledge/skills/rollout/references/notes",
          "knowledge/wikis/page",
          "knowledge/wikis/page.md",
          "scripts/eval/check.ts",
          "scripts/skills/rollout/references/notes.md",
          "knowledge/top",
          "scripts/topscript.sh",
          "scripts/scripts/deploy.sh",
          "knowledge/knowledge/release-notes",
        ],
        [bundle],
      ),
    ).toEqual([
      "knowledge/skills/rollout/references/notes",
      "knowledge/wikis/page",
      "knowledge/wikis/page.md",
      "scripts/eval/check.ts",
      "scripts/skills/rollout/scripts/run.py",
    ])
  })

  test("resolves a script only when its extension is one akm indexes as a script", () => {
    // akm indexes scripts/ files with one of 16 extensions (.sh .ts .js .ps1
    // .cmd .bat .py .rb .go .pl .php .lua .r .swift .kt .kts, any case) and
    // keeps the extension in the ID. Anything else under scripts/ is no asset:
    // `show` reads it off disk and answers without a ref, `feedback` refuses it.
    const bundle = makeBundle()
    for (const file of ["deploy.sh", "team/run.py", "build.TS", "page.html", "data.json", "notes.txt", "deploy"]) {
      touch(path.join(bundle, "scripts", file))
    }

    expect(
      validateRefCandidates(
        [
          "scripts/deploy.sh",
          "scripts/team/run.py",
          "scripts/build.TS",
          "scripts/page.html",
          "scripts/data.json",
          "scripts/notes.txt",
          "scripts/deploy",
          "scripts/missing.sh",
        ],
        [bundle],
      ),
    ).toEqual(["scripts/build.TS", "scripts/deploy.sh", "scripts/team/run.py"])
  })

  test("resolves a secret by its file name, except akm's lock and sensitive-marker files", () => {
    const bundle = makeBundle()
    for (const file of ["api-token", "tls.pem", "api-token.lock", "api-token.sensitive"]) {
      touch(path.join(bundle, "secrets", file))
    }

    expect(
      validateRefCandidates(
        ["secrets/api-token", "secrets/tls.pem", "secrets/api-token.lock", "secrets/api-token.sensitive"],
        [bundle],
      ),
    ).toEqual(["secrets/api-token", "secrets/tls.pem"])
  })

  test("resolves a derived memory by its own ID, not by its parent's", () => {
    // `<name>.derived.md` is a memory of its own, memories/<name>.derived. akm
    // 0.9.20 refuses memories/<name> when only the derived file exists.
    const bundle = makeBundle()

    expect(validateRefCandidates(["memories/session-derived.derived", "memories/session-derived"], [bundle])).toEqual([
      "memories/session-derived.derived",
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
        [
          "team-playbook//lessons/no-fine-tuning#Why",
          "lessons/no-fine-tuning#akm-fragment-3-1138d4941c9a",
          "team-playbook//lessons/missing#Why",
        ],
        [bundle],
      ),
    ).toEqual([
      "lessons/no-fine-tuning#akm-fragment-3-1138d4941c9a",
      "team-playbook//lessons/no-fine-tuning#Why",
    ])
  })

  test("does not resolve paths outside the bundle root", () => {
    const bundle = makeBundle()
    touch(path.join(bundle, "..", "outside.md"))
    expect(validateRefCandidates(["memories/../../outside", "../outside"], [bundle])).toEqual([])
  })
})
