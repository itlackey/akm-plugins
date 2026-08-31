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
// A single caret clause anchored at the stable release covers the whole
// supported line: `^0.9.7` admits stable 0.9.7 and later 0.9.x releases.
// 0.9.7 is the compatibility floor: its ref grammar, progressive-search
// metadata, token-budgeted curate packing, workflow lifecycle, and task/workflow
// wire contracts are the ones these plugins implement.
//
// KNOWN GAP: NO prerelease satisfies this range — not 0.9.7-rc.1, and not a
// *future* line such as 0.9.8-rc.1. That is node-semver's documented behavior
// and the vendored matcher reproduces it: a prerelease only satisfies a range
// whose lower bound is a prerelease with the same major.minor.patch. Admitting
// a prerelease line again is an explicit one-clause edit here
// (`^0.9.7 || ^0.9.8-rc.1`) when such a build actually needs testing — a
// deliberate opt-in rather than a range that silently accepts untested
// prereleases.
//
// Earlier 0.9 releases are deliberately excluded as well: accepting them
// would silently pass the version gate onto a CLI with retired ref and
// workflow contracts.

import { satisfies } from "./vendor-semver"

export const AKM_VERSION_RANGE = "^0.9.7"

/**
 * True when `version` is a valid semver string that satisfies
 * {@link AKM_VERSION_RANGE}. Non-strings (e.g. a failed probe) return false.
 */
export function satisfiesAkmVersionRange(version: string | null | undefined): boolean {
  return typeof version === "string" && satisfies(version, AKM_VERSION_RANGE)
}
