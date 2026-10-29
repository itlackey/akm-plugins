// The plugin release version, derived from the akm CLI version these plugins target (akm#1089).
//
// akm 0.10 onward versions its releases as 0.10.YYMMNN: YY the UTC year, MM the month and NN the release number within
// that month (01 to 99), two digits each, with -alpha, -beta or -rc for a prerelease and no ".N". Every release, whatever
// its stage, consumes a new NN. The plugins use the same scheme with their own counter: for akm_version 0.10.261001 or
// 0.10.261001-beta the plugins release as 0.10.<this UTC month's YYMM><NN>[-<the same stage>], NN being one above the
// highest 6-digit build of that month already on npm as akm-opencode (the stage of a published build is ignored).
//
// The earlier daily scheme, 0.10.YYMMDDNN (8-digit patch), is retired: such an akm_version is rejected, and published
// 8-digit builds are ignored when counting. Semver compares the patch numerically, so every 6-digit build sorts below
// them; that is a known, accepted break (see README "Versioning").
//
// The akm 0.9 line keeps the old scheme: <akm_version><UTC yyyymmddhhmm> for a stable akm, <akm_version>.<yyyymmddhhmm>
// for a prerelease. That scheme cannot continue into 0.10: 261001 followed by 12 digits is 18 digits, above
// Number.MAX_SAFE_INTEGER, which node-semver (and so npm) rejects.
//
//   AKM_VERSION=0.10.261001-beta bun scripts/release-version.ts derive >> "$GITHUB_OUTPUT"

import { execFileSync } from "node:child_process"

const FIRST_MONTHLY_MINOR = 10
const MONTHLY = /^0\.(\d+)\.(\d{2})(\d{2})(\d{2})(?:-(alpha|beta|rc))?$/
const LEGACY_DAILY = /^0\.(\d+)\.\d{8}(?:-(?:alpha|beta|rc))?$/

const pad2 = (n: number): string => String(n).padStart(2, "0")

export function usesMonthlyBuilds(version: string): boolean {
  const minor = /^0\.(\d+)\./.exec(version)?.[1]
  return minor !== undefined && Number(minor) >= FIRST_MONTHLY_MINOR
}

/** An error message when `version` is not a valid monthly-build version (0.<minor>.YYMMNN[-stage]), else undefined. */
export function validateMonthly(version: string): string | undefined {
  if (LEGACY_DAILY.test(version)) {
    return `"${version}" is a retired daily build (0.<minor>.YYMMDDNN); akm now releases 0.<minor>.YYMMNN (UTC year, month, release number of the month), e.g. 0.10.261001-beta`
  }
  const m = MONTHLY.exec(version)
  if (!m) {
    return `"${version}" is not 0.<minor>.YYMMNN with an optional -alpha, -beta or -rc (two digits each for YY, MM, NN)`
  }
  const [, , yy, mm, nn] = m
  if (Number(mm) < 1 || Number(mm) > 12) return `"${version}": ${mm} is not a month (YYMMNN)`
  if (Number(nn) < 1) return `"${version}": the release number NN is 01 to 99`
  return undefined
}

export interface Derived {
  akmVersion: string
  /** True for an akm prerelease: published under the npm `next` tag. */
  next: boolean
  version: string
}

/**
 * The plugin version for `akmVersionInput`. `listPublished` returns the versions of akm-opencode on npm and is read
 * only for a monthly-build akm (0.10+).
 */
export function deriveRelease(akmVersionInput: string, now: Date, listPublished: () => readonly string[]): Derived {
  const akmVersion = akmVersionInput.replace(/\s/g, "")
  const next = akmVersion.includes("-")
  let version: string

  if (usesMonthlyBuilds(akmVersion)) {
    const problem = validateMonthly(akmVersion)
    if (problem) throw new Error(problem)
    const [, minor, , , , stage] = MONTHLY.exec(akmVersion)!
    const month = `${pad2(now.getUTCFullYear() % 100)}${pad2(now.getUTCMonth() + 1)}`
    let highest = 0
    for (const published of listPublished()) {
      const m = MONTHLY.exec(published)
      if (m && m[1] === minor && `${m[2]}${m[3]}` === month) highest = Math.max(highest, Number(m[4]))
    }
    if (highest >= 99) throw new Error(`0.${minor}.${month}99 is already published: no release numbers are left for this UTC month`)
    version = `0.${minor}.${month}${pad2(highest + 1)}${stage ? `-${stage}` : ""}`
  } else {
    // The 0.9 line and older: the timestamp is glued onto the patch (stable) or added as a prerelease identifier.
    const stamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}`
    version = next ? `${akmVersion}.${stamp}` : `${akmVersion}${stamp}`
  }

  // A patch above Number.MAX_SAFE_INTEGER is not valid semver; fail before anything is tagged.
  const patch = /^\d+\.\d+\.(\d+)/.exec(version)?.[1]
  if (patch === undefined || !Number.isSafeInteger(Number(patch))) {
    throw new Error(`derived version "${version}" has a patch number npm and node-semver reject (above Number.MAX_SAFE_INTEGER)`)
  }
  return { akmVersion, next, version }
}

/** Versions of akm-opencode on npm; none when it has never been published. */
function npmVersions(): string[] {
  try {
    const out = execFileSync("npm", ["view", "akm-opencode", "versions", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    const parsed: unknown = out.trim() === "" ? [] : JSON.parse(out)
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)]
  } catch (err) {
    if (String((err as { stderr?: unknown }).stderr ?? "").includes("E404")) return []
    throw err
  }
}

if (import.meta.main) {
  if (process.argv[2] !== "derive") {
    console.error("usage: AKM_VERSION=<akm version> release-version.ts derive")
    process.exit(2)
  }
  try {
    const { akmVersion, next, version } = deriveRelease(process.env.AKM_VERSION ?? "", new Date(), npmVersions)
    console.log(`akm_version=${akmVersion}\nnext=${next}\nversion=${version}`)
    console.error(`Targeting akm ${akmVersion}; releasing plugins as ${version}`)
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}
