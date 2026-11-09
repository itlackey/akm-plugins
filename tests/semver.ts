// The semver.org grammar, for tests that check a version string the way npm will: `valid()` returns the version
// when it is MAJOR.MINOR.PATCH with an optional prerelease and build tag, else null.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function valid(version: string | null | undefined): string | null {
  return version && SEMVER.test(version) ? version : null
}
