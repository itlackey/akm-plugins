// Single source of truth for the akm-cli version contract: a minimum version.
//
// The Claude/Codex hook refuses an installed akm-cli only when it is BELOW this
// floor. Anything at or above it passes, including a later minor or major line
// (0.11, 1.0): a newer akm is never a reason to disable the plugin. OpenCode
// executes its declared akm-cli dependency in process and therefore pins one
// exact version at or above the floor in opencode/package.json; the version
// policy tests and release workflow keep those two contracts synchronized.
//
// The floor is akm 0.10.261004. The plugins pass `--detail agent`, which akm 0.9
// rejects ("Invalid value for --detail"), and a CLI older than the first monthly
// release (0.10.261001, akm#1089) also lacks the `--replace/--with/--source`
// feedback flags and the index/state migrations the plugins rely on. Before
// 0.10.261004, `akm feedback` reported ok while dropping the record when state.db
// was read-only to the process (an agent sandbox), so agents lost feedback silently.
//
// The comparison is numeric on major.minor.patch and ignores any prerelease or
// build tag on the installed version, so 0.10.261004-beta meets the floor. That
// also means a prerelease OF the floor (0.10.261004-alpha) meets it: the gate
// judges the release core, so a newer build is never refused for being a
// prerelease. The retired daily alphas (0.10.YYMMDDNN-alpha, an 8-digit patch)
// compare numerically above the floor and pass; that is accepted
// (tests/release-version.test.ts, tests/akm-version-check.test.ts).
//
// The matcher is vendored (./vendor-semver) because the Claude hook runs as a
// bare Bun script with no node_modules at hook-execution time.
//
// Moving the floor moves OpenCode's exact pins and the Windows CI install with
// it; the release workflow requires the stable pin and floor to match.

import { releaseCore, valid } from "./vendor-semver"

export const AKM_MIN_VERSION = "0.10.261004"

/**
 * True when `version` is valid semver whose release core (major.minor.patch,
 * prerelease and build tags dropped) is at or above {@link AKM_MIN_VERSION}.
 * Non-strings (e.g. a failed probe) and invalid versions return false.
 */
export function meetsAkmMinVersion(version: string | null | undefined): boolean {
  const core = typeof version === "string" && valid(version) ? releaseCore(version) : null
  const floor = releaseCore(AKM_MIN_VERSION)
  if (!core || !floor) return false
  for (let i = 0; i < 3; i++) {
    if (core[i] !== floor[i]) return core[i] > floor[i]
  }
  return true
}
