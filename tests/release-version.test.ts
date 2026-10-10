// scripts/release-version.ts: the plugin release version for an akm version (akm#1089).
//
// From akm 0.10 the plugins release as 0.10.YYMMDDNN[-stage] with their own daily counter. The akm 0.9 line keeps
// <akm_version><yyyymmddhhmm>, which for 0.10 would be a 20-digit patch above Number.MAX_SAFE_INTEGER that
// node-semver and npm reject.

import { describe, expect, test } from "bun:test"

import { satisfies, valid } from "../claude/shared/vendor-semver"
import { deriveRelease } from "../scripts/release-version"

const at = (iso: string): Date => new Date(iso)
const derive = (akm: string, iso: string, published: string[] = []) => deriveRelease(akm, at(iso), () => published)
const order = (a: string, b: string): number => Bun.semver.order(a, b)
const patchOf = (version: string): string => version.split("-")[0].split(".")[2]

describe("akm 0.10: daily builds", () => {
  test("the first plugin build of the UTC day is 01, whatever akm's own build number is", () => {
    expect(derive("0.10.26101001", "2026-10-10T04:00:00Z").version).toBe("0.10.26101001")
    expect(derive("0.10.26100501", "2026-10-10T04:00:00Z").version).toBe("0.10.26101001")
  })

  test("NN is one above the highest akm-opencode build already published that UTC day on that line", () => {
    const published = ["0.9.30202610090106", "0.10.26100901", "0.10.26101001", "0.10.26101002-alpha", "0.11.26101005"]
    expect(derive("0.10.26101001", "2026-10-10T23:59:00Z", published).version).toBe("0.10.26101003")
  })

  test("a build promoted through its stages counts once, and a gap is never reused", () => {
    const stages = ["0.10.26101001-alpha", "0.10.26101001-beta", "0.10.26101001-rc", "0.10.26101001"]
    expect(derive("0.10.26101001", "2026-10-10T05:00:00Z", stages).version).toBe("0.10.26101002")
    expect(derive("0.10.26101001", "2026-10-10T05:00:00Z", ["0.10.26101004"]).version).toBe("0.10.26101005")
  })

  test("the UTC day decides, across a month and a year boundary", () => {
    expect(derive("0.10.26101001", "2026-10-31T23:59:59Z").version).toBe("0.10.26103101")
    expect(derive("0.10.26101001", "2026-11-01T00:00:00Z", ["0.10.26103101"]).version).toBe("0.10.26110101")
    expect(derive("0.10.26101001", "2026-12-31T23:59:59Z").version).toBe("0.10.26123101")
    expect(derive("0.10.26101001", "2027-01-01T00:00:00Z", ["0.10.26123101"]).version).toBe("0.10.27010101")
  })

  test("an akm stage is copied, makes it a next release, and sorts below the stable build of the same day", () => {
    const alpha = derive("0.10.26101001-alpha", "2026-10-10T05:00:00Z")
    expect(alpha).toEqual({ akmVersion: "0.10.26101001-alpha", next: true, version: "0.10.26101001-alpha" })
    const rc = derive("0.10.26101001-rc", "2026-10-10T06:00:00Z", [alpha.version])
    expect(rc.version).toBe("0.10.26101002-rc")
    const stable = derive("0.10.26101001", "2026-10-10T07:00:00Z", [alpha.version, rc.version])
    expect(stable).toEqual({ akmVersion: "0.10.26101001", next: false, version: "0.10.26101003" })
    expect(order(rc.version, stable.version)).toBe(-1)
    expect(order("0.10.26101001-alpha", "0.10.26101001-beta")).toBe(-1)
    expect(order("0.10.26101001-beta", "0.10.26101001-rc")).toBe(-1)
  })

  test("every derived version is valid semver with a safe patch, never the 20-digit concatenation", () => {
    for (const day of ["2026-01-01", "2026-09-09", "2026-12-31", "2027-01-01", "2028-02-29", "2099-12-31"]) {
      for (const akm of ["0.10.26101001", "0.10.26101001-alpha", "0.10.26101001-beta", "0.10.26101001-rc", "0.11.27010101"]) {
        const published: string[] = []
        let previous = ""
        for (let build = 1; build <= 99; build++) {
          const { version } = derive(akm, `${day}T12:00:00Z`, published)
          expect(valid(version)).toBe(version)
          expect(patchOf(version)).toHaveLength(8)
          expect(Number.isSafeInteger(Number(patchOf(version)))).toBe(true)
          if (previous) expect(order(version.replace(/-.*/, ""), previous)).toBe(1)
          published.push(version)
          previous = version.replace(/-.*/, "")
        }
      }
    }
  })

  test("a plugin build sorts above every 0.9 plugin build and satisfies a caret floor on its own line", () => {
    const version = derive("0.10.26101001", "2026-10-10T04:00:00Z").version
    expect(order(version, "0.9.30202610090106")).toBe(1)
    expect(satisfies("0.10.26101002", "^0.10.26101001")).toBe(true)
    expect(satisfies("0.10.26101001", "^0.10.26101001")).toBe(true)
    expect(satisfies("0.10.26100901", "^0.10.26101001")).toBe(false)
    expect(satisfies("0.11.27010101", "^0.10.26101001")).toBe(false)
  })

  test("a malformed akm version, or a day with no build numbers left, fails before anything is tagged", () => {
    for (const bad of [
      "0.10.0",
      "0.10.261010",
      "0.10.26101000",
      "0.10.26133101",
      "0.10.25022901",
      "0.10.26101001-alpha.1",
      "0.10.26101001-gamma",
      "0.10.26101001+build",
      "0.10.010901",
    ]) {
      expect(() => derive(bad, "2026-10-10T04:00:00Z")).toThrow()
    }
    expect(() => derive("0.10.26101001", "2026-10-10T04:00:00Z", ["0.10.26101099"])).toThrow(/no build numbers/)
  })

  test("npm is read only for a daily-build akm", () => {
    const listPublished = () => {
      throw new Error("npm was read")
    }
    expect(() => deriveRelease("0.10.26101001", at("2026-10-10T04:00:00Z"), listPublished)).toThrow("npm was read")
    expect(deriveRelease("0.9.30", at("2026-10-10T04:00:00Z"), listPublished).version).toBe("0.9.30202610100400")
  })
})

describe("akm 0.9: the old scheme still releases", () => {
  test("stable is <akm_version><yyyymmddhhmm> and next is <akm_version>.<yyyymmddhhmm>", () => {
    expect(derive("0.9.30", "2026-10-09T01:06:59Z")).toEqual({ akmVersion: "0.9.30", next: false, version: "0.9.30202610090106" })
    expect(derive(" 0.9.31-alpha.4\n", "2026-10-08T05:12:00Z")).toEqual({
      akmVersion: "0.9.31-alpha.4",
      next: true,
      version: "0.9.31-alpha.4.202610080512",
    })
    expect(valid("0.9.31-alpha.4.202610080512")).toBe("0.9.31-alpha.4.202610080512")
  })
})
