// scripts/release-version.ts: the plugin release version for an akm version (akm#1089).
//
// From akm 0.10 the plugins release as 0.10.YYMMNN[-stage] with their own monthly counter: every release consumes the
// next NN of the UTC month, whatever its stage. The akm 0.9 line keeps <akm_version><yyyymmddhhmm>, which for 0.10 would
// be an 18-digit patch above Number.MAX_SAFE_INTEGER that node-semver and npm reject.

import { describe, expect, test } from "bun:test"

import { meetsAkmMinVersion } from "../claude/shared/akm-version"
import { valid } from "../claude/shared/vendor-semver"
import { deriveRelease } from "../scripts/release-version"

const at = (iso: string): Date => new Date(iso)
const derive = (akm: string, iso: string, published: string[] = []) => deriveRelease(akm, at(iso), () => published)
const order = (a: string, b: string): number => Bun.semver.order(a, b)
const patchOf = (version: string): string => version.split("-")[0].split(".")[2]

describe("akm 0.10: monthly release numbers", () => {
  test("the first plugin release of the UTC month is 01, whatever akm's own number is", () => {
    expect(derive("0.10.261001-beta", "2026-10-12T04:00:00Z")).toEqual({ akmVersion: "0.10.261001-beta", next: true, version: "0.10.261001-beta" })
    expect(derive("0.10.260501", "2026-10-12T04:00:00Z").version).toBe("0.10.261001")
  })

  test("NN is one above the highest 6-digit akm-opencode version published for the current UTC month on that line", () => {
    const published = ["0.9.30202610090106", "0.10.260999", "0.10.261001-beta", "0.10.261002", "0.11.261005", "0.10.261103"]
    expect(derive("0.10.261001", "2026-10-31T23:59:00Z", published).version).toBe("0.10.261003")
  })

  test("every release consumes a number, whatever its stage, and a gap is never reused", () => {
    const stages = ["0.10.261001-alpha", "0.10.261002-beta", "0.10.261003-rc", "0.10.261004"]
    expect(derive("0.10.261003", "2026-10-12T05:00:00Z", stages).version).toBe("0.10.261005")
    expect(derive("0.10.261003", "2026-10-12T05:00:00Z", ["0.10.261044"]).version).toBe("0.10.261045")
    expect(derive("0.10.261144", "2026-11-12T05:00:00Z", ["0.10.261143-rc", "0.10.261144"]).version).toBe("0.10.261145")
    expect(derive("0.10.261145-alpha", "2026-11-12T05:00:00Z", ["0.10.261144"]).version).toBe("0.10.261145-alpha")
  })

  test("the retired 8-digit daily builds on npm are ignored when counting", () => {
    const legacy = ["0.10.26101001-alpha", "0.10.26101002-alpha", "0.10.26101201-alpha"]
    expect(derive("0.10.261001-beta", "2026-10-12T04:00:00Z", legacy).version).toBe("0.10.261001-beta")
    expect(derive("0.10.261002", "2026-10-12T04:00:00Z", [...legacy, "0.10.261001-beta"]).version).toBe("0.10.261002")
  })

  test("the UTC month decides, across a month and a year boundary", () => {
    expect(derive("0.10.261001", "2026-10-31T23:59:59Z").version).toBe("0.10.261001")
    expect(derive("0.10.261001", "2026-11-01T00:00:00Z", ["0.10.261044"]).version).toBe("0.10.261101")
    expect(derive("0.10.261001", "2026-12-31T23:59:59Z", ["0.10.261101"]).version).toBe("0.10.261201")
    expect(derive("0.10.261001", "2027-01-01T00:00:00Z", ["0.10.261201"]).version).toBe("0.10.270101")
  })

  test("an akm stage is copied, makes it a next release, and sorts below the stable build of the same number", () => {
    const beta = derive("0.10.261001-beta", "2026-10-12T05:00:00Z")
    expect(beta).toEqual({ akmVersion: "0.10.261001-beta", next: true, version: "0.10.261001-beta" })
    const rc = derive("0.10.261002-rc", "2026-10-12T06:00:00Z", [beta.version])
    expect(rc).toEqual({ akmVersion: "0.10.261002-rc", next: true, version: "0.10.261002-rc" })
    const stable = derive("0.10.261003", "2026-10-12T07:00:00Z", [beta.version, rc.version])
    expect(stable).toEqual({ akmVersion: "0.10.261003", next: false, version: "0.10.261003" })
    expect(order(rc.version, "0.10.261002")).toBe(-1)
    expect(order("0.10.261001-alpha", "0.10.261001-beta")).toBe(-1)
    expect(order("0.10.261001-beta", "0.10.261001-rc")).toBe(-1)
    expect(order(stable.version, rc.version)).toBe(1)
  })

  test("every derived version is valid semver with a safe 6-digit patch, never the 18-digit concatenation", () => {
    for (const month of ["2026-01", "2026-09", "2026-12", "2027-01", "2028-02", "2099-12"]) {
      for (const akm of ["0.10.261001", "0.10.261001-alpha", "0.10.261001-beta", "0.10.261001-rc", "0.11.270101"]) {
        const published: string[] = []
        let previous = ""
        for (let release = 1; release <= 99; release++) {
          const { version } = derive(akm, `${month}-15T12:00:00Z`, published)
          expect(valid(version)).toBe(version)
          expect(patchOf(version)).toHaveLength(6)
          expect(Number.isSafeInteger(Number(patchOf(version)))).toBe(true)
          if (previous) expect(order(version.replace(/-.*/, ""), previous)).toBe(1)
          published.push(version)
          previous = version.replace(/-.*/, "")
        }
      }
    }
  })

  test("a plugin build sorts above every 0.9 plugin build and meets the akm floor", () => {
    const version = derive("0.10.261001", "2026-10-12T04:00:00Z").version
    expect(order(version, "0.9.30202610090106")).toBe(1)
    expect(meetsAkmMinVersion("0.10.261005")).toBe(true)
    expect(meetsAkmMinVersion("0.10.261004")).toBe(true)
    expect(meetsAkmMinVersion("0.10.261003")).toBe(false)
    expect(meetsAkmMinVersion("0.10.260901")).toBe(false)
    expect(meetsAkmMinVersion("0.11.270101")).toBe(true)
  })

  test("KNOWN, ACCEPTED: every monthly build sorts below the retired 8-digit daily alphas (akm#1089)", () => {
    // Semver compares the patch numerically, so 0.10.26101002-alpha (patch 26101002) outranks 0.10.261144 (patch 261144).
    // Anyone on a daily alpha installs the first monthly build explicitly once; `akm upgrade` does not offer it. This
    // pins the fact so nobody "fixes" it by accident (by reusing a daily-looking number, say).
    for (const legacy of ["0.10.26101001-alpha", "0.10.26101002-alpha", "0.10.26101201-alpha"]) {
      for (const monthly of ["0.10.261001-beta", "0.10.261001", "0.10.261144", "0.10.991299"]) {
        expect(order(monthly, legacy)).toBe(-1)
      }
    }
  })

  test("a malformed akm version, or a month with no numbers left, fails before anything is tagged", () => {
    for (const bad of [
      "0.10.0",
      "0.10.2610",
      "0.10.261000",
      "0.10.261301",
      "0.10.260001",
      "0.10.261001-alpha.1",
      "0.10.261001-gamma",
      "0.10.261001+build",
      "0.10.01091",
    ]) {
      expect(() => derive(bad, "2026-10-12T04:00:00Z")).toThrow()
    }
    expect(() => derive("0.10.261001", "2026-10-12T04:00:00Z", ["0.10.261099"])).toThrow(/no release numbers/)
  })

  test("a retired 8-digit daily akm version is rejected with a message that names the new form", () => {
    for (const legacy of ["0.10.26101001", "0.10.26101002-alpha", "0.10.26101201-rc"]) {
      expect(() => derive(legacy, "2026-10-12T04:00:00Z")).toThrow(/retired daily build.*YYMMNN/)
    }
  })

  test("npm is read only for a monthly-build akm", () => {
    const listPublished = () => {
      throw new Error("npm was read")
    }
    expect(() => deriveRelease("0.10.261001", at("2026-10-12T04:00:00Z"), listPublished)).toThrow("npm was read")
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
