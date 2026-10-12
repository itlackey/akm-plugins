// Unit tests for the minimal vendored semver used by the Claude hook.
// See claude/hooks/vendor-semver.ts for the rationale (B7: marketplace
// install does not run `bun install`, so depending on the real `semver`
// package would make every hook silently no-op for users whose Bun
// auto-install is disabled).

import { describe, expect, it } from "bun:test"
import { releaseCore, valid } from "../claude/shared/vendor-semver"

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

describe("releaseCore()", () => {
  it("returns the numeric major/minor/patch and drops prerelease and build tags", () => {
    expect(releaseCore("0.10.261001")).toEqual([0, 10, 261001])
    expect(releaseCore("v0.10.261001-beta")).toEqual([0, 10, 261001])
    expect(releaseCore("1.2.3-rc.1+build.5")).toEqual([1, 2, 3])
    expect(releaseCore("0.10.26101002-alpha")).toEqual([0, 10, 26101002])
  })
  it("returns null for anything that is not semver", () => {
    expect(releaseCore("not-a-version")).toBeNull()
    expect(releaseCore("1.2")).toBeNull()
    expect(releaseCore(null)).toBeNull()
    expect(releaseCore(undefined)).toBeNull()
  })
})
