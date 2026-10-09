// Versioning policy: the plugins keep MAJOR.MINOR in sync with the akm CLI
// line they target, and let PATCH diverge freely inside that minor.
//
// The sync point is AKM_VERSION_RANGE in claude/shared/akm-version.ts. On a 0.x
// version a caret range is exactly a minor line (`^0.9.29` == `>=0.9.29 <0.10.0`),
// so "plugins are 0.9.x while akm is 0.9.x" is already what that constant says.
// This file makes the invariant enforced rather than conventional: five version
// fields, Claude's install ref, and OpenCode's exact package/lockfile pins all
// restate the same fact by hand, and nothing previously stopped them drifting.
//
// Patch divergence is deliberate. A plugin-only fix — the issue #86 startup
// crash, say — has to be shippable without waiting for an akm release, which is
// impossible if the patch component is spent mirroring akm's.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import { AKM_VERSION_RANGE, satisfiesAkmVersionRange } from "../claude/shared/akm-version"
import { valid } from "../claude/shared/vendor-semver"

const REPO_ROOT = path.join(import.meta.dir, "..")
const readText = (relative: string): string => readFileSync(path.join(REPO_ROOT, relative), "utf8")
const readJson = (relative: string): Record<string, any> => JSON.parse(readText(relative))

/** `0.9.29` -> `0.9`. Returns null for anything that is not plain semver. */
function minorLine(version: string): string | null {
  const parsed = valid(version)
  if (!parsed) return null
  const [major, minor] = parsed.split(".")
  return `${major}.${minor}`
}

/** `^0.9.29` -> `0.9.29`. The range floor is the minimum compatible CLI version. */
function rangeFloor(range: string): string {
  return range.trim().replace(/^[\^~>=v\s]+/, "")
}

// Every manifest the release workflow stamps with the single version string.
const VERSION_FIELDS: Array<{ file: string; read: () => string }> = [
  { file: "opencode/package.json", read: () => readJson("opencode/package.json").version },
  { file: "claude/package.json", read: () => readJson("claude/package.json").version },
  { file: "claude/.claude-plugin/plugin.json", read: () => readJson("claude/.claude-plugin/plugin.json").version },
  { file: "claude/.codex-plugin/plugin.json", read: () => readJson("claude/.codex-plugin/plugin.json").version },
  { file: ".claude-plugin/marketplace.json", read: () => readJson(".claude-plugin/marketplace.json").plugins[0].version },
]

describe("version policy", () => {
  test("the akm range is a caret range, so a minor line is what it pins", () => {
    // The whole policy rests on `^0.9.29` meaning ">=0.9.29 <0.10.0". If the range
    // is ever widened into an OR-list or a bare pin, "MAJOR.MINOR in sync" stops
    // having a single answer and every assertion below becomes a guess.
    expect(AKM_VERSION_RANGE).toMatch(/^\^\d+\.\d+\.\d+$/)
    expect(valid(rangeFloor(AKM_VERSION_RANGE))).not.toBeNull()
  })

  test("every stamped version is plain semver", () => {
    // Guards the format directly. A four-component version like
    // `0.9.14.20260904.1` reads as a reasonable way to encode a dated build, but
    // it is not semver: npm's own parser returns null for it and the registry
    // rejects it on publish. release.yml stamps, commits and tags BEFORE npm
    // ever sees the version, so an invalid string leaves a bad tag behind and
    // fails at the last step.
    for (const { file, read } of VERSION_FIELDS) {
      expect(`${file}: ${read()}`).toBe(`${file}: ${valid(read()) ?? "NOT-VALID-SEMVER"}`)
    }
  })

  test("all five manifests carry the identical version", () => {
    // release.yml writes one string into all five; they can only diverge
    // through a hand edit, which is exactly when nobody is checking.
    const seen = VERSION_FIELDS.map(({ file, read }) => `${file} -> ${read()}`)
    const versions = new Set(VERSION_FIELDS.map(({ read }) => read()))
    expect(`${[...versions].join(", ")} | ${seen.join(" ; ")}`).toBe(`${VERSION_FIELDS[0].read()} | ${seen.join(" ; ")}`)
  })

  test("the release workflow stamps and stages every manifest listed here", () => {
    // The test above only proves the files agree today. A manifest the bump step
    // never rewrites agrees until the first release and drifts at it.
    const workflow = readText(".github/workflows/release.yml")
    const staged = (workflow.split("\n").find((line) => line.trim().startsWith("git add ")) ?? "").split(/\s+/)
    for (const { file } of VERSION_FIELDS) {
      expect(`${file} stamped: ${workflow.includes(`updateJsonFile('${file}'`)}`).toBe(`${file} stamped: true`)
      expect(`${file} staged: ${staged.includes(file)}`).toBe(`${file} staged: true`)
    }
  })

  test("the plugin minor line matches the akm line the plugins target", () => {
    const expected = minorLine(rangeFloor(AKM_VERSION_RANGE))
    expect(expected).not.toBeNull()
    for (const { file, read } of VERSION_FIELDS) {
      expect(`${file}: ${minorLine(read())}`).toBe(`${file}: ${expected}`)
    }
  })

  test("patch is free to diverge from akm within the minor", () => {
    // Not a drift check — an executable statement of the policy, so that a
    // future change tightening patch back into lockstep fails here and has to
    // argue with the comment at the top of this file instead of sliding in.
    const floorPatch = rangeFloor(AKM_VERSION_RANGE)
    for (const candidate of ["0.9.0", "0.9.1", "0.9.29"]) {
      expect(minorLine(candidate)).toBe(minorLine(floorPatch))
    }
    expect(minorLine("0.10.0")).not.toBe(minorLine(floorPatch))
  })

  test("the range ceiling is real, and a prerelease is judged by its release core", () => {
    // claude/shared/akm-version.ts drops a prerelease tag before matching, so a
    // newer 0.9.x build is never refused for being a prerelease — 0.9.17-alpha.3
    // against ^0.9.16 used to disable akm for whole sessions. The ceiling is
    // this file's policy: 0.10.0-beta.1 is the next minor line, on 0.x the next
    // plugin line, so it is refused exactly like 0.10.0 until a 0.10.x plugin
    // ships with a new floor. 0.9.17-alpha.3 is now below the floor, so the same
    // shape is asserted one patch above it.
    expect(satisfiesAkmVersionRange("0.9.30-alpha.3")).toBe(true)
    expect(satisfiesAkmVersionRange("0.10.0")).toBe(false)
    expect(satisfiesAkmVersionRange("0.10.0-beta.1")).toBe(false)
  })

  test("the release workflow derives the version instead of accepting a typed one", () => {
    // The release version is <akm_version><UTC yyyymmddhhmm>, e.g. akm 0.9.1
    // released at 2026-08-24 20:12 UTC -> 0.9.1202608242012.
    //
    // This is enforced rather than conventional because the hand-typed scheme
    // it replaced shipped two releases with a typo'd YEAR -- 0.9.202808211043
    // and 0.9.202808220049 are both stamped 2028, not 2026. npm compares PATCH
    // numerically, so the NEXT correctly-dated hand-typed release would have
    // sorted BELOW them: the publish succeeds, `latest` stays on the older
    // build, and every consumer silently keeps installing it. Deriving the
    // timestamp in CI removes the typo, and the monotonicity check catches any
    // other way of sorting backwards.
    const workflow = readText(".github/workflows/release.yml")

    // The operator supplies the akm line, never the timestamp.
    expect(workflow).toContain("akm_version:")
    expect(workflow).not.toContain("inputs.version")
    expect(workflow).toContain("date -u +%Y%m%d%H%M")
    expect(workflow).toContain('VERSION="${AKM_VERSION}${TIMESTAMP}"')

    // ...and a publish that would leave `latest` pointing backwards is refused.
    expect(workflow).toContain("does NOT sort above the published ${channel}")
  })

  test("the derived version shape stays on the akm minor line and sorts forward", () => {
    // Pure arithmetic on the scheme, so a future change to the shape has to
    // face these cases rather than discovering them on npm.
    const derive = (akm: string, stamp: string): string => `${akm}${stamp}`
    const patchOf = (version: string): number => Number(valid(version)!.split(".")[2])

    const floorLine = minorLine(rangeFloor(AKM_VERSION_RANGE))
    expect(minorLine(derive("0.9.1", "202608242012"))).toBe(floorLine)

    // The two typo'd releases already on npm must be cleared by the scheme.
    const published = patchOf("0.9.202808220049")
    expect(patchOf(derive("0.9.1", "202608242012"))).toBeGreaterThan(published)

    // Monotonic within one akm patch, across an akm patch bump (even with an
    // earlier clock), and across a two-digit akm patch.
    expect(patchOf(derive("0.9.1", "202608242013"))).toBeGreaterThan(patchOf(derive("0.9.1", "202608242012")))
    expect(patchOf(derive("0.9.14", "202601010000"))).toBeGreaterThan(patchOf(derive("0.9.1", "202612312359")))
    expect(patchOf(derive("0.9.29", "202601010000"))).toBeGreaterThan(patchOf(derive("0.9.28", "202612312359")))
  })

  test("an akm prerelease derives a next version that npm accepts and that sorts between its neighbours", () => {
    // A prerelease akm_version (0.9.30-alpha.4) is a `next` release, derived as
    // <akm_version>.<UTC yyyymmddhhmm> so the whole string stays a valid semver
    // prerelease. Gluing the stamp on without the dot would read as part of the
    // last identifier (alpha.4202610080512) and sort by its text, not its time.
    const derive = (akm: string, stamp: string): string => (akm.includes("-") ? `${akm}.${stamp}` : `${akm}${stamp}`)
    const order = (a: string, b: string): number => Bun.semver.order(a, b)

    const next = derive("0.9.30-alpha.4", "202610080512")
    expect(next).toBe("0.9.30-alpha.4.202610080512")
    expect(valid(next)).toBe(next)
    expect(satisfiesAkmVersionRange(next)).toBe(true)

    // Below the stable it precedes, above the akm prerelease it targets, and
    // above the previous next (including the stale 0.8.0-rc.8 on npm today).
    expect(order(next, "0.9.30")).toBe(-1)
    expect(order(next, "0.9.30-alpha.4")).toBe(1)
    expect(order(next, derive("0.9.30-alpha.3", "202610090000"))).toBe(1)
    expect(order(next, "0.8.0-rc.8")).toBe(1)
    // Monotonic within one akm prerelease.
    expect(order(derive("0.9.30-alpha.4", "202610080513"), next)).toBe(1)
  })

  test("the release workflow publishes a prerelease akm_version as a next release without touching main", () => {
    const workflow = readText(".github/workflows/release.yml")

    // Derivation and validation; the monotonicity guard runs against the `next` tag.
    expect(workflow).toContain('VERSION="${AKM_VERSION}.${TIMESTAMP}"')
    expect(workflow).toContain("`dist-tags.${channel}`")
    expect(workflow).toContain("is outside AKM_VERSION_RANGE")
    expect(workflow).toContain("is not on npm. Publish that akm prerelease first")

    // The pin and lockfile are build-only: staged and committed in the next
    // branch, which never reaches `git push`; the stable branch is unchanged.
    const commit = workflow.slice(workflow.indexOf("- name: Commit and tag"), workflow.indexOf("publish-opencode:"))
    const [nextBranch, stableBranch] = commit.split("elif ! git diff --cached --quiet; then")
    expect(nextBranch).toContain("git add opencode/bun.lock")
    expect(nextBranch).not.toContain("git push\n")
    expect(stableBranch).toContain("git push\n")
    expect(workflow).toContain('npm pkg set "dependencies.akm-cli=$AKM_VERSION"')

    // Published under `next`, and released as a prerelease.
    expect(workflow).toContain("--tag next")
    expect(workflow).toContain("--prerelease")
  })

  test("Claude follows the range and OpenCode exact-pins its floor", () => {
    // The Claude hook has no package manager behind it (git marketplace, no
    // npm deps), so its ref is what a user is told to install. OpenCode imports
    // private dist modules in process, so both its manifest and lockfile must
    // resolve exactly the CLI version we tested rather than a future patch.
    const expectedRef = `akm-cli@${AKM_VERSION_RANGE}`
    const floor = rangeFloor(AKM_VERSION_RANGE)

    const packageRef = /AKM_PACKAGE_REF\s*\?\?\s*"([^"]+)"/.exec(readText("claude/hooks/akm-hook.ts"))?.[1]
    expect(`claude/hooks/akm-hook.ts: ${packageRef}`).toBe(`claude/hooks/akm-hook.ts: ${expectedRef}`)

    const bundledDep = readJson("opencode/package.json").dependencies["akm-cli"]
    expect(`opencode/package.json akm-cli: ${bundledDep}`).toBe(`opencode/package.json akm-cli: ${floor}`)

    const lockfile = readText("opencode/bun.lock")
    expect(lockfile).toContain(`"akm-cli": "${floor}"`)
    expect(lockfile).toContain(`"akm-cli": ["akm-cli@${floor}",`)
  })

  test("the release workflow refuses version-contract drift before tagging", () => {
    const workflow = readText(".github/workflows/release.yml")
    expect(workflow).toContain("does not equal AKM_VERSION_RANGE floor")
    expect(workflow).toContain("must exact-pin akm-cli")
  })

  test("every CI install of the real Codex pins one version, which claude/README.md names", () => {
    // tests/real-hosts.test.ts pins the trust hashes the real Codex computes for the two hooks, so a Codex that moves has
    // to move everywhere it runs, and be written down: tests.yml installs it for Linux and for Windows, release.yml for
    // the release gate.
    const [tests, release] = [".github/workflows/tests.yml", ".github/workflows/release.yml"]
    const pins = [tests, release].flatMap((file) => [...readText(file).matchAll(/@openai\/codex@(\S+)/g)].map((match) => ({ file, version: match[1] })))
    expect(pins.map(({ file }) => file)).toEqual([tests, tests, release])

    const { version } = pins[0]
    expect(valid(version)).toBe(version)
    expect(pins.map((pin) => `${pin.file}: ${pin.version}`)).toEqual(pins.map((pin) => `${pin.file}: ${version}`))
    expect(`claude/README.md names ${version}: ${readText("claude/README.md").includes(`real Codex (${version})`)}`).toBe(`claude/README.md names ${version}: true`)
  })
})
