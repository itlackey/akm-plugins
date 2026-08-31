// Versioning policy: the plugins keep MAJOR.MINOR in sync with the akm CLI
// line they target, and let PATCH diverge freely inside that minor.
//
// The sync point is AKM_VERSION_RANGE in claude/shared/akm-version.ts. On a 0.x
// version a caret range is exactly a minor line (`^0.9.6` == `>=0.9.6 <0.10.0`),
// so "plugins are 0.9.x while akm is 0.9.x" is already what that constant says.
// This file makes the invariant enforced rather than conventional: four version
// fields and three install-ref copies all restate the same fact by hand, and
// nothing previously stopped them drifting apart.
//
// Patch divergence is deliberate. A plugin-only fix — the issue #86 startup
// crash, say — has to be shippable without waiting for an akm release, which is
// impossible if the patch component is spent mirroring akm's.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import { AKM_VERSION_RANGE } from "../claude/shared/akm-version"
import { valid } from "../claude/shared/vendor-semver"

const REPO_ROOT = path.join(import.meta.dir, "..")
const readText = (relative: string): string => readFileSync(path.join(REPO_ROOT, relative), "utf8")
const readJson = (relative: string): Record<string, any> => JSON.parse(readText(relative))

/** `0.9.6` -> `0.9`. Returns null for anything that is not plain semver. */
function minorLine(version: string): string | null {
  const parsed = valid(version)
  if (!parsed) return null
  const [major, minor] = parsed.split(".")
  return `${major}.${minor}`
}

/** `^0.9.6` -> `0.9.6`. The range floor is the minimum compatible CLI version. */
function rangeFloor(range: string): string {
  return range.trim().replace(/^[\^~>=v\s]+/, "")
}

// Every manifest the release workflow stamps with the single version string.
const VERSION_FIELDS: Array<{ file: string; read: () => string }> = [
  { file: "opencode/package.json", read: () => readJson("opencode/package.json").version },
  { file: "claude/package.json", read: () => readJson("claude/package.json").version },
  { file: "claude/.claude-plugin/plugin.json", read: () => readJson("claude/.claude-plugin/plugin.json").version },
  { file: ".claude-plugin/marketplace.json", read: () => readJson(".claude-plugin/marketplace.json").plugins[0].version },
]

describe("version policy", () => {
  test("the akm range is a caret range, so a minor line is what it pins", () => {
    // The whole policy rests on `^0.9.6` meaning ">=0.9.6 <0.10.0". If the range
    // is ever widened into an OR-list or a bare pin, "MAJOR.MINOR in sync" stops
    // having a single answer and every assertion below becomes a guess.
    expect(AKM_VERSION_RANGE).toMatch(/^\^\d+\.\d+\.\d+$/)
    expect(valid(rangeFloor(AKM_VERSION_RANGE))).not.toBeNull()
  })

  test("every stamped version is plain semver", () => {
    // Guards the format directly. A four-component version like
    // `0.9.6.20260831.1` reads as a reasonable way to encode a dated build, but
    // it is not semver: npm's own parser returns null for it and the registry
    // rejects it on publish. release.yml stamps, commits and tags BEFORE npm
    // ever sees the version, so an invalid string leaves a bad tag behind and
    // fails at the last step.
    for (const { file, read } of VERSION_FIELDS) {
      expect(`${file}: ${read()}`).toBe(`${file}: ${valid(read()) ?? "NOT-VALID-SEMVER"}`)
    }
  })

  test("all four manifests carry the identical version", () => {
    // release.yml writes one string into all four; they can only diverge
    // through a hand edit, which is exactly when nobody is checking.
    const seen = VERSION_FIELDS.map(({ file, read }) => `${file} -> ${read()}`)
    const versions = new Set(VERSION_FIELDS.map(({ read }) => read()))
    expect(`${[...versions].join(", ")} | ${seen.join(" ; ")}`).toBe(`${VERSION_FIELDS[0].read()} | ${seen.join(" ; ")}`)
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
    for (const candidate of ["0.9.0", "0.9.1", "0.9.7"]) {
      expect(minorLine(candidate)).toBe(minorLine(floorPatch))
    }
    expect(minorLine("0.10.0")).not.toBe(minorLine(floorPatch))
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
    expect(workflow).toContain("does NOT sort above the published latest")
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
    expect(patchOf(derive("0.9.6", "202601010000"))).toBeGreaterThan(patchOf(derive("0.9.1", "202612312359")))
    expect(patchOf(derive("0.9.10", "202601010000"))).toBeGreaterThan(patchOf(derive("0.9.6", "202612312359")))
  })

  test("every install-ref copy restates AKM_VERSION_RANGE exactly", () => {
    // Three hand-maintained copies of the range live outside the constant.
    // They are what a user is told to install when the version gate fails, so a
    // stale copy sends people to the wrong akm.
    const expectedRef = `akm-cli@${AKM_VERSION_RANGE}`

    const packageRef = /AKM_PACKAGE_REF\s*\?\?\s*"([^"]+)"/.exec(readText("claude/hooks/akm-hook.ts"))?.[1]
    expect(`claude/hooks/akm-hook.ts: ${packageRef}`).toBe(`claude/hooks/akm-hook.ts: ${expectedRef}`)

    const installRef = /AKM_RECOMMENDED_INSTALL_REF\s*=\s*"([^"]+)"/.exec(readText("opencode/index.ts"))?.[1]
    expect(`opencode/index.ts: ${installRef}`).toBe(`opencode/index.ts: ${expectedRef}`)

    const bundledDep = readJson("opencode/package.json").dependencies["akm-cli"]
    expect(`opencode/package.json akm-cli: ${bundledDep}`).toBe(`opencode/package.json akm-cli: ${AKM_VERSION_RANGE}`)
  })
})
