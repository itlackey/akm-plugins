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
// supported line: `^0.9.8` admits stable 0.9.8 and later 0.9.x releases.
// 0.9.8 is the compatibility floor, and the reason is a one-way one: 0.9.8
// adds state migrations 025 and 026, so once any 0.9.8 command opens
// `state.db` an older CLI refuses to open it at all. A home these plugins
// have driven is therefore a 0.9.8+ home, and admitting 0.9.7 would point
// the gate at a CLI that cannot read it. Its ref grammar, progressive-search
// metadata, token-budgeted curate packing, workflow lifecycle, and
// task/workflow wire contracts are the ones these plugins implement.
//
// KNOWN GAP: NO prerelease satisfies this range — not 0.9.8-rc.1, and not a
// *future* line such as 0.9.9-rc.1. That is node-semver's documented behavior
// and the vendored matcher reproduces it: a prerelease only satisfies a range
// whose lower bound is a prerelease with the same major.minor.patch. Admitting
// a prerelease line again is an explicit one-clause edit here
// (`^0.9.8 || ^0.9.9-rc.1`) when such a build actually needs testing — a
// deliberate opt-in rather than a range that silently accepts untested
// prereleases.
//
// Earlier 0.9 releases are deliberately excluded as well: accepting them
// would silently pass the version gate onto a CLI with retired ref and
// workflow contracts, or one that cannot open a migrated state.db.
//
// #106 asked, as a maintainer decision, whether a caret range is the right
// matcher at all given akm's own STABILITY.md: "0.9.x patch releases may
// also contain breaking changes" while the 0.9.x line pays off technical
// debt pre-1.0. Verified against that document and against the akm 0.9.12
// branch (itlackey/akm, release/0.9.12) while checking this plugin for
// compatibility: every akm surface these plugins call is tier Stable
// (search, curate, show, info, feedback, workflow list) EXCEPT `akm proposal
// extract`, which is tier Evolving — "payload shapes may shift" — and is
// exactly the surface `extractSession()`/`lastExtractFailureWarning()` parse
// most deeply. 0.9.12 did change that envelope again (added `engine`,
// `engineKind`, `skipReasons`, and an aggregate `warnings[]` line for an
// all-skip run — see akm#912/#913) — the Evolving tag is not decorative.
// Decision: keep the caret range, not because the risk is unreal but because
// a narrower pin doesn't address it — the failure mode #106 reported was
// never "the version gate passed when it shouldn't have" (an *already
// installed* plugin at 0.9.1 would need 0.9.1 itself to have shipped a
// tighter range, which a future release cannot retroactively fix), it was
// "a breaking change degraded to silence downstream of the gate". That is
// what #107/#108/#109 fix directly: every read of the extract envelope goes
// through safeJsonParse with every field optional-chained, so an Evolving
// surface changing shape degrades to "say less" (a missing field silently
// omitted) rather than a crash or a fabricated warning. That is the
// appropriate mitigation for an Evolving dependency the gate cannot pin
// away without also rejecting users on every newer patch release.

import { satisfies } from "./vendor-semver"

export const AKM_VERSION_RANGE = "^0.9.8"

/**
 * True when `version` is a valid semver string that satisfies
 * {@link AKM_VERSION_RANGE}. Non-strings (e.g. a failed probe) return false.
 */
export function satisfiesAkmVersionRange(version: string | null | undefined): boolean {
  return typeof version === "string" && satisfies(version, AKM_VERSION_RANGE)
}
