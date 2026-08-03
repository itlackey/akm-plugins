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
// Stable carets do not match prereleases, so the current RC floor is explicit.
//
// 0.8.0 support was dropped for the 0.9.0 release: 0.9.0-only runtime paths
// (`akm extract --session-id`, curate `--detail brief`) fail against 0.8.x,
// so accepting 0.8.x here would silently pass the version gate onto a CLI
// the plugin no longer fully works with.

import { satisfies } from "./vendor-semver"

export const AKM_VERSION_RANGE = "^0.9.0-rc.14 || ^0.9.0"

/**
 * True when `version` is a valid semver string that satisfies
 * {@link AKM_VERSION_RANGE}. Non-strings (e.g. a failed probe) return false.
 */
export function satisfiesAkmVersionRange(version: string | null | undefined): boolean {
  return typeof version === "string" && satisfies(version, AKM_VERSION_RANGE)
}
