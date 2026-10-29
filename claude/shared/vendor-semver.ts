// Minimal vendored semver helpers. Covers exactly what the akm version floor
// check needs: `valid` and the numeric release core of a version.
//
// Why vendored: the Claude plugin ships via `/plugin marketplace add` which
// just clones the repo — `node_modules` is gitignored and no install runs on
// the user's machine. Relying on Bun's auto-install for `semver` makes every
// hook silently no-op when auto-install is disabled, offline, or rate-limited.
// Vendoring these few lines removes the runtime dependency entirely.

type Parsed = {
  major: number
  minor: number
  patch: number
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parse(input: string): Parsed | null {
  const m = String(input).trim().replace(/^v/, "").match(SEMVER_RE)
  if (!m) return null
  const [, maj, min, pat] = m
  return { major: Number(maj), minor: Number(min), patch: Number(pat) }
}

export function valid(input: string | null | undefined): string | null {
  if (!input) return null
  if (!parse(input)) return null
  return String(input).trim().replace(/^v/, "")
}

/** The release core of a valid semver string as [major, minor, patch]; prerelease and build tags are dropped. */
export function releaseCore(input: string | null | undefined): [number, number, number] | null {
  const parsed = input ? parse(input) : null
  return parsed ? [parsed.major, parsed.minor, parsed.patch] : null
}
