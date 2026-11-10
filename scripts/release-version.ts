// The plugin release version, derived from the akm CLI version these plugins target (akm#1089, akm#1591).
//
// akm 0.11 onward uses plain semver (0.11.0-beta.1, 0.11.0, 0.11.1). The plugins keep their own patch inside akm's
// major.minor: a stable release is 0.<minor>.<P>, P one above the highest stable patch of that minor on npm (0 if none);
// a prerelease is 0.<minor>.<P>-<stage>.<N> with the same P and N one above the highest published -<stage>.N of that
// 0.<minor>.<P> (1 if none).
//
// akm 0.10 versions its releases as 0.10.YYMMNN: YY the UTC year, MM the month and NN the release number within
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
import semver from "semver"

const MONTHLY_MINOR = 10
const MONTHLY = /^0\.(\d+)\.(\d{2})(\d{2})(\d{2})(?:-(alpha|beta|rc))?$/

const pad2 = (n: number): string => String(n).padStart(2, "0")

const minorOf = (version: string): number | undefined => {
  const m = /^0\.(\d+)/.exec(version)?.[1]
  return m === undefined ? undefined : Number(m)
}

/** An error message when `version` is not a valid monthly-build version (0.<minor>.YYMMNN[-stage]), else undefined. */
export function validateMonthly(version: string): string | undefined {
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

/** The plugin version for akm 0.11+: its own patch inside akm's 0.<minor>, a stage becoming -<stage>.<N>. */
function deriveSemver(akmVersion: string, published: readonly string[]): string {
  const akm = semver.parse(akmVersion, { loose: false })
  const stage = akm?.prerelease[0]
  if (!akm || akm.major !== 0 || akm.build.length > 0 || (akm.prerelease.length > 0 && typeof stage !== "string")) {
    throw new Error(`"${akmVersion}" is not a semver akm version 0.<minor>.<patch> with an optional -<stage>[.N] prerelease`)
  }
  const line = published.map((v) => semver.parse(v)).filter((v): v is semver.SemVer => v !== null && v.major === 0 && v.minor === akm.minor)
  const patch = Math.max(-1, ...line.filter((v) => v.prerelease.length === 0).map((v) => v.patch)) + 1
  if (typeof stage !== "string") return `0.${akm.minor}.${patch}`
  const counts = line.filter((v) => v.patch === patch && v.prerelease[0] === stage).map((v) => Number(v.prerelease[1]) || 0)
  return `0.${akm.minor}.${patch}-${stage}.${Math.max(0, ...counts) + 1}`
}

/**
 * The plugin version for `akmVersionInput`. `listPublished` returns the versions of akm-opencode on npm and is read
 * only for akm 0.10 and later.
 */
export function deriveRelease(akmVersionInput: string, now: Date, listPublished: () => readonly string[]): Derived {
  const akmVersion = akmVersionInput.replace(/\s/g, "")
  const next = akmVersion.includes("-")
  let version: string

  const minor = minorOf(akmVersion)
  if (minor !== undefined && minor > MONTHLY_MINOR) {
    version = deriveSemver(akmVersion, listPublished())
  } else if (minor === MONTHLY_MINOR) {
    const problem = validateMonthly(akmVersion)
    if (problem) throw new Error(problem)
    const [, , , , , stage] = MONTHLY.exec(akmVersion)!
    const month = `${pad2(now.getUTCFullYear() % 100)}${pad2(now.getUTCMonth() + 1)}`
    let highest = 0
    for (const published of listPublished()) {
      const m = MONTHLY.exec(published)
      if (m && Number(m[1]) === minor && `${m[2]}${m[3]}` === month) highest = Math.max(highest, Number(m[4]))
    }
    if (highest >= 99) throw new Error(`0.${minor}.${month}99 is already published: no release numbers are left for this UTC month`)
    version = `0.${minor}.${month}${pad2(highest + 1)}${stage ? `-${stage}` : ""}`
  } else if (minor === undefined) {
    throw new Error(`"${akmVersion}" is not a semver akm version 0.<minor>.<patch> with an optional -<stage>[.N] prerelease`)
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
