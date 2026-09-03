// Unit tests for the minimal vendored semver used by the Claude hook.
// See claude/hooks/vendor-semver.ts for the rationale (B7: marketplace
// install does not run `bun install`, so depending on the real `semver`
// package would make every hook silently no-op for users whose Bun
// auto-install is disabled).

import { describe, expect, it } from "bun:test"
import { satisfies, valid } from "../claude/shared/vendor-semver"

describe("valid()", () => {
  it("accepts standard semver", () => {
    expect(valid("0.8.0")).toBe("0.8.0")
    expect(valid("1.2.3")).toBe("1.2.3")
    expect(valid("10.20.30")).toBe("10.20.30")
  })
  it("accepts prereleases", () => {
    expect(valid("0.8.0-rc0")).toBe("0.8.0-rc0")
    expect(valid("0.8.0-rc.1")).toBe("0.8.0-rc.1")
    expect(valid("1.0.0-alpha.beta.1")).toBe("1.0.0-alpha.beta.1")
  })
  it("accepts build metadata", () => {
    expect(valid("1.0.0+build.123")).toBe("1.0.0+build.123")
    expect(valid("1.0.0-rc1+build.abc")).toBe("1.0.0-rc1+build.abc")
  })
  it("strips a leading v", () => {
    expect(valid("v1.2.3")).toBe("1.2.3")
  })
  it("rejects garbage", () => {
    expect(valid("not-a-version")).toBeNull()
    expect(valid("1.2")).toBeNull()
    expect(valid("1.2.3.4")).toBeNull()
    expect(valid("")).toBeNull()
    expect(valid(null)).toBeNull()
    expect(valid(undefined)).toBeNull()
  })
})

describe("satisfies() — AKM_REQUIRED_RANGE behavior", () => {
  // This is the exact range the Claude hook uses: see
  // claude/hooks/akm-hook.ts:AKM_REQUIRED_RANGE.
  const RANGE = "^0.8.0-rc.0 || ^0.8.0 || ^0.9.0-beta.0 || ^0.9.0"

  it("accepts stable 0.8.x versions", () => {
    expect(satisfies("0.8.0", RANGE)).toBe(true)
    expect(satisfies("0.8.3", RANGE)).toBe(true)
    expect(satisfies("0.8.99", RANGE)).toBe(true)
  })

  it("accepts both dotted (rc.N) and mono (rcN) prerelease forms >= rc.0", () => {
    // dotted form (matches akm-cli's actual published versions, e.g. 0.8.0-rc.5)
    expect(satisfies("0.8.0-rc.0", RANGE)).toBe(true)
    expect(satisfies("0.8.0-rc.5", RANGE)).toBe(true)
    // mono form (defensive: an older script might tag this way)
    expect(satisfies("0.8.0-rc0", RANGE)).toBe(true)
    expect(satisfies("0.8.0-rc1", RANGE)).toBe(true)
  })

  it("rejects 0.7.x", () => {
    expect(satisfies("0.7.0", RANGE)).toBe(false)
    expect(satisfies("0.7.9", RANGE)).toBe(false)
  })

  it("accepts stable 0.9.x versions", () => {
    expect(satisfies("0.9.0", RANGE)).toBe(true)
    expect(satisfies("0.9.5", RANGE)).toBe(true)
  })

  it("accepts 0.9.0 prereleases >= beta.0 (e.g. 0.9.0-beta.6, 0.9.0-rc.0)", () => {
    expect(satisfies("0.9.0-beta.0", RANGE)).toBe(true)
    expect(satisfies("0.9.0-beta.6", RANGE)).toBe(true)
    // rc > beta at the same base, so rc prereleases are also accepted
    expect(satisfies("0.9.0-rc.0", RANGE)).toBe(true)
  })

  it("rejects 1.0.x", () => {
    expect(satisfies("1.0.0", RANGE)).toBe(false)
  })

  it("rejects 0.8.1 prereleases (different base than ^0.8.0-rc0)", () => {
    // node-semver default: prereleases only satisfy when base matches the
    // prerelease floor. ^0.8.0-rc0 allows 0.8.0-*; it does NOT allow
    // 0.8.1-* because that's a different base.
    expect(satisfies("0.8.1-rc0", RANGE)).toBe(false)
  })

  it("rejects malformed versions", () => {
    expect(satisfies("not-a-version", RANGE)).toBe(false)
    expect(satisfies("0.8", RANGE)).toBe(false)
  })
})

describe("satisfies() — caret semantics", () => {
  it("^X.Y.Z caps at next major", () => {
    expect(satisfies("1.5.0", "^1.2.3")).toBe(true)
    expect(satisfies("2.0.0", "^1.2.3")).toBe(false)
  })
  it("^0.Y.Z caps at next minor (0.x special case)", () => {
    expect(satisfies("0.2.99", "^0.2.0")).toBe(true)
    expect(satisfies("0.3.0", "^0.2.0")).toBe(false)
  })
  it("^X.Y.Z without prerelease floor does NOT match prereleases", () => {
    expect(satisfies("0.8.0-rc1", "^0.8.0")).toBe(false)
  })
})
