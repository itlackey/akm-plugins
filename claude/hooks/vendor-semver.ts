// Minimal vendored semver implementation. Covers exactly the subset used by
// akm-hook.ts (`valid`, `satisfies` with caret ranges + `||` disjunction).
//
// Why vendored: the Claude plugin ships via `/plugin marketplace add` which
// just clones the repo — `node_modules` is gitignored and no install runs on
// the user's machine. Relying on Bun's auto-install for `semver` makes every
// hook silently no-op when auto-install is disabled, offline, or rate-limited.
// Vendoring this ~80 LOC removes the runtime dependency entirely.

type Parsed = {
  major: number
  minor: number
  patch: number
  prerelease: Array<string | number>
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parse(input: string): Parsed | null {
  const m = String(input).trim().replace(/^v/, "").match(SEMVER_RE)
  if (!m) return null
  const [, maj, min, pat, pre] = m
  const prerelease = pre ? pre.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : []
  return { major: Number(maj), minor: Number(min), patch: Number(pat), prerelease }
}

export function valid(input: string | null | undefined): string | null {
  if (!input) return null
  if (!parse(input)) return null
  return String(input).trim().replace(/^v/, "")
}

function cmp(a: Parsed, b: Parsed): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  // A version without prerelease has HIGHER precedence than one with.
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const n = Math.min(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < n; i++) {
    const ai = a.prerelease[i]
    const bi = b.prerelease[i]
    const aNum = typeof ai === "number"
    const bNum = typeof bi === "number"
    if (aNum && !bNum) return -1
    if (!aNum && bNum) return 1
    if (aNum && bNum) {
      if (ai !== bi) return (ai as number) < (bi as number) ? -1 : 1
    } else {
      const s = String(ai)
      const t = String(bi)
      if (s !== t) return s < t ? -1 : 1
    }
  }
  if (a.prerelease.length !== b.prerelease.length) return a.prerelease.length < b.prerelease.length ? -1 : 1
  return 0
}

type CaretRange = { min: Parsed; maxExclusive: Parsed; allowPrereleases: boolean }

function parseCaretRange(token: string): CaretRange | null {
  const m = token.trim().match(/^\^(.+)$/)
  if (!m) return null
  const min = parse(m[1])
  if (!min) return null
  let maxExclusive: Parsed
  if (min.major > 0) {
    maxExclusive = { major: min.major + 1, minor: 0, patch: 0, prerelease: [] }
  } else if (min.minor > 0) {
    maxExclusive = { major: 0, minor: min.minor + 1, patch: 0, prerelease: [] }
  } else {
    maxExclusive = { major: 0, minor: 0, patch: min.patch + 1, prerelease: [] }
  }
  return { min, maxExclusive, allowPrereleases: min.prerelease.length > 0 }
}

export function satisfies(version: string, range: string): boolean {
  const v = parse(version)
  if (!v) return false
  const branches = range.split("||").map((s) => s.trim())
  for (const branch of branches) {
    const tokens = branch.split(/\s+/).filter(Boolean)
    let ok = true
    for (const t of tokens) {
      const r = parseCaretRange(t)
      if (!r) {
        ok = false
        break
      }
      if (cmp(v, r.min) < 0 || cmp(v, r.maxExclusive) >= 0) {
        ok = false
        break
      }
      // node-semver default: prereleases only satisfy a range whose lower
      // bound also has a prerelease AND shares the same major.minor.patch.
      if (v.prerelease.length > 0) {
        if (!r.allowPrereleases) {
          ok = false
          break
        }
        if (v.major !== r.min.major || v.minor !== r.min.minor || v.patch !== r.min.patch) {
          ok = false
          break
        }
      }
    }
    if (ok) return true
  }
  return false
}
