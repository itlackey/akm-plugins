// The plugin must detect an unavailable or incompatible AKM CLI without
// silently installing software or writing raw diagnostics to stderr. The
// Claude hook reports degraded status through SessionStart additionalContext
// and records diagnostics in its plugin-local state log.

import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { satisfiesAkmVersionRange, AKM_VERSION_RANGE } from "../claude/shared/akm-version"
import { IS_WINDOWS, hostEnv, itPosix } from "./host-runtime"

const repoRoot = path.resolve(import.meta.dir, "..")
const hookScript = path.join(repoRoot, "claude/hooks/akm-hook.ts")

const tempDirs: string[] = []

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "akm-version-check-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  // A detached child may still hold a file for a moment, and Windows will not
  // delete an open one: retry, and a leftover temp directory is not a test failure.
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {}
  }
})

function readLogLines(filePath: string) {
  try {
    return readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean)
  } catch {
    return []
  }
}

type HookResult = { stdout: string; stderr: string; exitCode: number; installLog: string; stateDir: string }

function runHookSandboxed(args: string[], opts: {
  akmVersion?: string | null
  /** Set to true to omit `bun` and `npm` shims entirely. */
  omitInstallers?: boolean
  env?: Record<string, string>
}): HookResult {
  const tempDir = makeTempDir()
  const binDir = path.join(tempDir, "bin")
  const stateDir = path.join(tempDir, "state")
  const dataDir = path.join(tempDir, "data")
  const cacheDir = path.join(tempDir, "cache")
  const installLog = path.join(tempDir, "install.log")
  mkdirSync(binDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(cacheDir, { recursive: true })

  if (opts.akmVersion) {
    const fakeAkm = path.join(binDir, "akm")
    writeFileSync(
      fakeAkm,
      `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then
  printf 'akm ${opts.akmVersion}\\n'
  exit 0
fi
exit 0
`,
    )
    chmodSync(fakeAkm, 0o755)
  }

  if (!opts.omitInstallers) {
    const tripwire = (cmdName: string) => `#!/usr/bin/env sh
{
  printf '%s' "${cmdName}"
  for arg in "$@"; do
    printf '\\t%s' "$arg"
  done
  printf '\\n'
} >> "${installLog}"
exit 0
`
    const fakeBun = path.join(binDir, "bun")
    writeFileSync(fakeBun, tripwire("bun"))
    chmodSync(fakeBun, 0o755)
    const fakeNpm = path.join(binDir, "npm")
    writeFileSync(fakeNpm, tripwire("npm"))
    chmodSync(fakeNpm, 0o755)
  }

  const env = {
    HOME: tempDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    XDG_STATE_HOME: stateDir,
    XDG_DATA_HOME: dataDir,
    XDG_CACHE_HOME: cacheDir,
    ...opts.env,
  }

  const result = Bun.spawnSync([process.execPath, hookScript, ...args], {
    cwd: repoRoot,
    env: hostEnv(env, (key) => key.startsWith("AKM_")),
    stdio: ["ignore", "pipe", "pipe"],
  })

  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode ?? 0,
    stateDir,
    installLog: (() => {
      try {
        return readFileSync(installLog, "utf8")
      } catch {
        return ""
      }
    })(),
  }
}

describe("AKM_VERSION_RANGE contract", () => {
  it("is a single caret clause anchored at the stable 0.9.29 release", () => {
    expect(AKM_VERSION_RANGE).toBe("^0.9.29")
  })

  it("accepts every build whose release core is in the 0.9 line at or above the floor, prerelease or not", () => {
    for (const version of ["0.9.29", "0.9.30", "0.9.29-rc.1", "0.9.30-alpha.3", "0.9.30-20260929.1", "0.9.30+build.5"]) {
      expect(satisfiesAkmVersionRange(version)).toBe(true)
    }
  })

  it("rejects releases below the floor or outside the 0.9 line, prerelease or not", () => {
    // 0.9.28 was the floor before 0.9.29, and so is the stable release just below it.
    for (const version of ["0.8.9", "0.9.0", "0.9.7", "0.9.8", "0.9.9", "0.9.19", "0.9.20", "0.9.21", "0.9.24", "0.9.27", "0.9.28", "0.9.28-rc.1", "1.0.0", "1.0.0-rc.1", "0.10.0", "0.10.0-beta.1"]) {
      expect(satisfiesAkmVersionRange(version)).toBe(false)
    }
  })

  it("never refuses a newer akm for being a prerelease", () => {
    // node-semver's default, reproduced by ./vendor-semver: no prerelease
    // satisfies a stable range. That refused an installed 0.9.17-alpha.3
    // against ^0.9.16 and disabled akm for the whole session ("version-
    // mismatch") although it is newer than the floor. The gate therefore
    // judges the release core only; floor and ceiling still apply to it.
    // 0.9.17-alpha.3 is now below the floor, so the same shape is asserted one
    // patch above it.
    expect(satisfiesAkmVersionRange("0.9.30-alpha.3")).toBe(true)
    expect(satisfiesAkmVersionRange("0.9.15-rc.1")).toBe(false)
    // The ceiling is the versioning policy (plugin MAJOR.MINOR tracks akm's):
    // a prerelease of the next minor line is that line, refused like 0.10.0
    // itself until a 0.10.x plugin ships with a new floor.
    expect(satisfiesAkmVersionRange("0.10.0-beta.1")).toBe(false)
  })

  it("rejects malformed or missing versions", () => {
    expect(satisfiesAkmVersionRange("not-a-version")).toBe(false)
    expect(satisfiesAkmVersionRange(null)).toBe(false)
    expect(satisfiesAkmVersionRange(undefined)).toBe(false)
  })
})

// Driven through `session-start`, the hook command the manifest actually wires
// and the one on which checkAkmVersion() runs. The former `ensure-akm` /
// `check-akm` entry points existed only for these tests.
describe("checkAkmVersion", () => {
  itPosix("returns ok, logs readiness, and stays silent on stderr for a compatible CLI", () => {
    const result = runHookSandboxed(["session-start"], { akmVersion: "0.9.29" })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("akm_ready"))).toBe(true)
    expect(result.installLog).toBe("")
  })

  itPosix("accepts 0.9.x at or above the floor, prerelease included", () => {
    for (const version of ["0.9.29", "0.9.30", "0.9.30-alpha.3"]) {
      const result = runHookSandboxed(["session-start"], { akmVersion: version })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.installLog).toBe("")
      // The mismatch path also exits 0 with a quiet stderr, so only the log
      // line proves the gate passed.
      const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
      expect(sessionLog.some((line) => line.includes("akm_ready") && line.includes(version))).toBe(true)
      expect(sessionLog.some((line) => line.includes("akm_version_mismatch"))).toBe(false)
    }
  })

  itPosix("rejects every tested build outside the range", () => {
    for (const version of ["0.8.3", "0.9.0", "0.9.7", "0.9.8", "0.9.9", "0.9.19", "0.9.20", "0.9.21", "0.9.24", "0.9.27", "0.9.28", "0.9.28-rc.1", "0.10.0-beta.1"]) {
      const result = runHookSandboxed(["session-start"], { akmVersion: version })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
      expect(sessionLog.some((line) => line.includes("akm_version_mismatch") && line.includes(version))).toBe(true)
      expect(result.installLog).toBe("")
    }
  })

  it("accepts AKM_LOCAL_BUILD_CLI when a local build reports a supported stable 0.9.x", () => {
    const tempDir = makeTempDir()
    const localCli = path.join(tempDir, "dist", "cli.js")
    mkdirSync(path.dirname(localCli), { recursive: true })
    writeFileSync(localCli, "#!/usr/bin/env bun\nif (process.argv.includes('--version')) console.log('akm 0.9.29')\n")

    const result = runHookSandboxed(["session-start"], {
      akmVersion: null,
      env: {
        AKM_LOCAL_BUILD_CLI: localCli,
        BUN: process.execPath,
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.installLog).toBe("")
  })

  it("logs a missing CLI without writing to stderr", () => {
    const result = runHookSandboxed(["session-start"], { akmVersion: null })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("akm_missing"))).toBe(true)
    expect(result.installLog).toBe("")
  })

  itPosix("logs an incompatible CLI without writing to stderr", () => {
    const result = runHookSandboxed(["session-start"], { akmVersion: "0.9.28" })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("akm_version_mismatch") && line.includes("0.9.28"))).toBe(true)
    expect(result.installLog).toBe("")
  })

  it("never spawns an installer when AKM is missing", () => {
    const result = runHookSandboxed(["session-start"], { akmVersion: null })
    expect(result.installLog).toBe("")
    expect(result.installLog).not.toContain("install\t-g\takm-cli@")
  })

  it("session-start reports missing AKM through additionalContext, not stderr", () => {
    const result = runHookSandboxed(["session-start"], { akmVersion: null })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("AKM is NOT available")
    expect(result.stdout).toContain("^0.9.29")
    expect(result.stdout).toContain("akm-cli@^0.9.29")
    expect(result.installLog).toBe("")
    // additionalContext reaches the model, which cannot install anything.
    // systemMessage is the channel to the person who can, so it has to carry
    // the concrete command rather than a pointer to the model's context.
    const payload = JSON.parse(result.stdout.trim())
    expect(payload.systemMessage).toContain("AKM is unavailable this session")
    expect(payload.systemMessage).toContain("bun install -g akm-cli@^0.9.29")
  })

  itPosix("session-start ships the header and footer on a healthy CLI with a completely quiet stash", () => {
    // The most common profile there is: akm installed and in range, bundle
    // present, but nothing curated, no hints and no pending proposals. This
    // test used to assert only that stdout did NOT contain "AKM is NOT
    // available" — which the empty string satisfies, and the empty string is
    // exactly what this path emitted. SessionStart's whole job (tell the agent
    // akm exists, which lookup verb to reach for, how wide the surface is) was
    // unreachable on a fresh install. Assert the header actually ships.
    const bundleDir = makeTempDir()
    const result = runHookSandboxed(["session-start"], {
      akmVersion: "0.9.29",
      env: { AKM_BUNDLE_DIR: bundleDir },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.installLog).toBe("")

    const context = JSON.parse(result.stdout.trim()).hookSpecificOutput.additionalContext as string
    expect(context).toContain("# AKM is available in this session")
    expect(context).toContain('akm curate "<task>"')
    expect(context).toContain("The public plugin surface is limited to search, show, curate, feedback, and remember.")
    expect(context).not.toContain("AKM is NOT available")
    // Negative feedback flags an asset and lowers its ranking; a verified fix is attached with --replace/--with/--source.
    expect(context).toContain("that flags it and lowers its ranking")
    expect(context).toContain("--replace")
    expect(context).toContain("--with")
    expect(context).toContain("--source")
    expect(context).not.toContain("triggers a review and fix")
    // Negative feedback is only for wrong or stale content; an asset that merely did not fit the task records nothing.
    expect(context).toContain("only when an asset's content is wrong or stale")
    expect(context).toContain("is not negative feedback: record nothing")
    expect(context).not.toMatch(/incomplete|unhelpful/)
  })

  itPosix("session-start reports a missing bundle through context and the state log, not stderr", () => {
    const missingBundleDir = path.join(makeTempDir(), "definitely-not-here")
    const result = runHookSandboxed(["session-start"], {
      akmVersion: "0.9.29",
      env: { AKM_BUNDLE_DIR: missingBundleDir },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("AKM bundle directory")
    expect(result.stdout).toContain(missingBundleDir)
    const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("bundle_missing") && line.includes(missingBundleDir))).toBe(true)
  })
})
