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
// public CLI line: `^0.9.17` admits stable 0.9.17 and later 0.9.x releases.
// 0.9.17 is a required compatibility floor, not a marketing version. The
// OpenCode plugin runs akm-cli in-process against the same `index.db` and
// `state.db` as the installed CLI, and 0.9.17 migrates both forward (index
// layout 26, the improve-ledger state migrations); an older in-process
// akm-cli keeps writing to them on its own older schema. Before 0.9.16,
// bundle activation and executable authority were not yet host-owned, so an
// older binary would also restore a different trust model. Nothing this
// plugin reads was removed in 0.9.17 (the LLM entity graph, LLM metadata
// enrichment, and `akm show`'s `related` list).
//
// The gate reads the RELEASE CORE (major.minor.patch) and ignores a prerelease
// tag. node-semver's default rule, which the vendored matcher reproduces, is
// that no prerelease satisfies a stable range — so an installed 0.9.17-alpha.3
// was refused against ^0.9.16 and akm was disabled for the whole session
// ("version-mismatch") although it is a NEWER build than the floor. A newer
// akm must never be refused here. Floor and ceiling still apply to the core:
// 0.9.15-rc.1 is below the floor, and 0.10.0-beta.1 is the next minor line —
// on 0.x the next plugin line (see tests/version-policy.test.ts).
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
// The 0.9.17 compatibility review keeps the split explicit: keep the caret
// range for Claude's stable CLI calls, but exact-pin OpenCode's package because
// it imports private in-process modules and shares AKM's databases. The
// #107/#108/#109 envelope hardening remains necessary on both surfaces: every
// read of the Evolving extract envelope goes through safeJsonParse with every
// field optional-chained, so an additive shape change degrades to "say less"
// rather than a crash or fabricated warning.

import { satisfies, valid } from "./vendor-semver"

export const AKM_VERSION_RANGE = "^0.9.17"

/**
 * True when `version` is a valid semver string whose release core
 * (major.minor.patch, prerelease and build tags dropped) satisfies
 * {@link AKM_VERSION_RANGE}. Non-strings (e.g. a failed probe) return false.
 */
export function satisfiesAkmVersionRange(version: string | null | undefined): boolean {
  const normalized = typeof version === "string" ? valid(version) : null
  if (!normalized) return false
  return satisfies(normalized.replace(/[-+].*$/, ""), AKM_VERSION_RANGE)
}
