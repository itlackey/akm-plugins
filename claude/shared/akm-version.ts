// Single source of truth for the akm-cli version contract.
//
// The Claude hook validates the user's installed akm-cli against this exact
// range. OpenCode executes its declared akm-cli dependency in process and
// therefore pins the range floor exactly in opencode/package.json; the version
// policy tests and release workflow keep those two contracts synchronized.
//
// The matcher is the vendored `satisfies()` rather than the npm `semver`
// package because the Claude hook runs as a bare Bun script with no
// node_modules at hook-execution time.
//
// A single caret clause anchored at the stable release covers the supported
// public CLI line: `^0.9.14` admits stable 0.9.14 and later 0.9.x releases.
// 0.9.14 is a required compatibility floor, not a marketing version. It moves
// the shared derived index from generation 22 to 23 for lexical Markdown
// fragments. A 0.9.13 reader correctly refuses that index, while older 0.9.x
// binaries can also reject state migration 027. Once 0.9.14 touches a home,
// admitting an older binary leaves the plugin inactive against that home.
//
// KNOWN GAP: NO prerelease satisfies this range — not 0.9.14-rc.1, and not a
// *future* line such as 0.9.15-rc.1. That is node-semver's documented behavior
// and the vendored matcher reproduces it: a prerelease only satisfies a range
// whose lower bound is a prerelease with the same major.minor.patch. Admitting
// a prerelease line again is an explicit one-clause edit here
// (`^0.9.14 || ^0.9.15-rc.1`) when such a build actually needs testing — a
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
// The 0.9.14 compatibility review makes the split explicit: keep the caret
// range for Claude's stable CLI calls, but exact-pin OpenCode's package because
// it imports private in-process modules and shares AKM's databases. The
// #107/#108/#109 envelope hardening remains necessary on both surfaces: every
// read of the Evolving extract envelope goes through safeJsonParse with every
// field optional-chained, so an additive shape change degrades to "say less"
// rather than a crash or fabricated warning.

import { satisfies } from "./vendor-semver"

export const AKM_VERSION_RANGE = "^0.9.14"

/**
 * True when `version` is a valid semver string that satisfies
 * {@link AKM_VERSION_RANGE}. Non-strings (e.g. a failed probe) return false.
 */
export function satisfiesAkmVersionRange(version: string | null | undefined): boolean {
  return typeof version === "string" && satisfies(version, AKM_VERSION_RANGE)
}
