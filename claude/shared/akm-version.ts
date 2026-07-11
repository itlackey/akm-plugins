// Single source of truth for the akm-cli version contract.
//
// Both the Claude hook (claude/hooks/akm-hook.ts) and the OpenCode plugin
// (opencode/index.ts) validate the user's installed akm-cli against this exact
// range. Keeping it here — alongside the vendored semver matcher — means a
// version bump is a one-line change in one file instead of three drifting
// copies (a hand-rolled `minor === 8` check previously diverged here).
//
// The matcher is the vendored `satisfies()` rather than the npm `semver`
// package because the Claude hook runs as a bare Bun script with no
// node_modules at hook-execution time. This module is vendored into the
// published OpenCode tarball by opencode/scripts/vendor-shared.mjs, so the
// same code path runs on both sides.
//
// Prerelease note: stable carets (`^0.9.0`) do NOT match prereleases, so each
// supported prerelease line needs an explicit floor (`^0.9.0-beta.0`). akm
// publishes beta/rc prereleases; alpha (< beta) is intentionally excluded.

import { satisfies } from "./vendor-semver"

export const AKM_VERSION_RANGE = "^0.8.0-rc.0 || ^0.8.0 || ^0.9.0-beta.0 || ^0.9.0"

/**
 * True when `version` is a valid semver string that satisfies
 * {@link AKM_VERSION_RANGE}. Non-strings (e.g. a failed probe) return false.
 */
export function satisfiesAkmVersionRange(version: string | null | undefined): boolean {
  return typeof version === "string" && satisfies(version, AKM_VERSION_RANGE)
}
