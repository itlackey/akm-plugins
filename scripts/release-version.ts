// The plugin release version, derived from the akm CLI version these plugins target (akm#1089).
//
// akm 0.10 onward versions its releases as daily builds, 0.10.YYMMDDNN: YY the UTC year, MM the month, DD the day and
// NN the build that day (01 to 99), two digits each, with -alpha, -beta or -rc for a prerelease and no ".N". The
// plugins use the same scheme with their own daily counter: for akm_version 0.10.26101001 or 0.10.26101001-alpha the
// plugins release as 0.10.<today UTC YYMMDD><NN>[-<the same stage>], NN being one above the highest build of that day
// already on npm as akm-opencode.
//
// The akm 0.9 line keeps the old scheme: <akm_version><UTC yyyymmddhhmm> for a stable akm, <akm_version>.<yyyymmddhhmm>
// for a prerelease. That scheme cannot continue into 0.10: 26101001 followed by 12 digits is 20 digits, above
// Number.MAX_SAFE_INTEGER, which node-semver (and so npm) rejects.
//
//   AKM_VERSION=0.10.26101001 bun scripts/release-version.ts derive >> "$GITHUB_OUTPUT"

import { execFileSync } from "node:child_process"

const FIRST_DAILY_MINOR = 10
const DAILY = /^0\.(\d+)\.(\d{2})(\d{2})(\d{2})(\d{2})(?:-(alpha|beta|rc))?$/

const pad2 = (n: number): string => String(n).padStart(2, "0")

export function usesDailyBuilds(version: string): boolean {
  const minor = /^0\.(\d+)\./.exec(version)?.[1]
  return minor !== undefined && Number(minor) >= FIRST_DAILY_MINOR
}

/** An error message when `version` is not a valid daily-build version (0.<minor>.YYMMDDNN[-stage]), else undefined. */
export function validateDaily(version: string): string | undefined {
  const m = DAILY.exec(version)
  if (!m) {
    return `"${version}" is not 0.<minor>.YYMMDDNN with an optional -alpha, -beta or -rc (two digits each for YY, MM, DD, NN)`
  }
  const [, , yy, mm, dd, nn] = m
  const date = new Date(Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd)))
  if (date.getUTCFullYear() !== 2000 + Number(yy) || date.getUTCMonth() !== Number(mm) - 1 || date.getUTCDate() !== Number(dd)) {
    return `"${version}": ${yy}${mm}${dd} is not a calendar date (YYMMDD)`
  }
  if (Number(nn) < 1) return `"${version}": the build number NN is 01 to 99`
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
 * only for a daily-build akm (0.10+).
 */
export function deriveRelease(akmVersionInput: string, now: Date, listPublished: () => readonly string[]): Derived {
  const akmVersion = akmVersionInput.replace(/\s/g, "")
  const next = akmVersion.includes("-")
  let version: string

  if (usesDailyBuilds(akmVersion)) {
    const problem = validateDaily(akmVersion)
    if (problem) throw new Error(problem)
    const [, minor, , , , , stage] = DAILY.exec(akmVersion)!
    const day = `${pad2(now.getUTCFullYear() % 100)}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`
    let highest = 0
    for (const published of listPublished()) {
      const m = DAILY.exec(published)
      if (m && m[1] === minor && `${m[2]}${m[3]}${m[4]}` === day) highest = Math.max(highest, Number(m[5]))
    }
    if (highest >= 99) throw new Error(`0.${minor}.${day}99 is already published: no build numbers are left for this UTC day`)
    version = `0.${minor}.${day}${pad2(highest + 1)}${stage ? `-${stage}` : ""}`
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
