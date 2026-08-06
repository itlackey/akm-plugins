// The plugin must detect an unavailable or incompatible AKM CLI without
// silently installing software or writing raw diagnostics to stderr. The
// Claude hook reports degraded status through SessionStart additionalContext
// and records diagnostics in its plugin-local state log.

import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { satisfiesAkmVersionRange, AKM_VERSION_RANGE } from "../claude/shared/akm-version"

const repoRoot = path.resolve(import.meta.dir, "..")
const hookScript = path.join(repoRoot, "claude/hooks/akm-hook.ts")

const tempDirs: string[] = []

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "akm-version-check-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
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

  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AKM_")))
  const result = Bun.spawnSync([process.execPath, hookScript, ...args], {
    cwd: repoRoot,
    env: { ...baseEnv, ...env },
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
  it("is a single caret clause anchored at the stable 0.9.0 release", () => {
    // The RC floor (`^0.9.0-rc.14`) was retired when akm-cli 0.9.0 stable
    // shipped: release candidates are dead once the release exists.
    expect(AKM_VERSION_RANGE).toBe("^0.9.0")
  })

  it("accepts stable 0.9.x builds", () => {
    for (const version of ["0.9.0", "0.9.1", "0.9.5"]) {
      expect(satisfiesAkmVersionRange(version)).toBe(true)
    }
  })

  it("rejects every prerelease and versions outside 0.9", () => {
    for (const version of ["0.8.9", "0.9.0-beta.33", "0.9.0-rc.14", "0.9.0-rc.15", "1.0.0", "0.10.0"]) {
      expect(satisfiesAkmVersionRange(version)).toBe(false)
    }
  })

  it("documents that a 0.9.x prerelease line needs its own explicit clause", () => {
    // node-semver behavior, reproduced by ./vendor-semver: a prerelease only
    // satisfies a range whose lower bound is a prerelease with the same
    // major.minor.patch. Any 0.9.x RC line therefore trips the gate until an
    // explicit `|| ^0.9.N-rc.N` clause is added. Pinned so re-admitting a
    // prerelease line is a deliberate edit rather than a surprise.
    expect(satisfiesAkmVersionRange("0.9.1-rc.1")).toBe(false)
    // ...while the stable release on that same line is already accepted.
    expect(satisfiesAkmVersionRange("0.9.1")).toBe(true)
  })

  it("rejects malformed or missing versions", () => {
    expect(satisfiesAkmVersionRange("not-a-version")).toBe(false)
    expect(satisfiesAkmVersionRange(null)).toBe(false)
    expect(satisfiesAkmVersionRange(undefined)).toBe(false)
  })
})

describe("checkAkmVersion", () => {
  it("returns ok, logs readiness, and stays silent on stderr for a compatible CLI", () => {
    const result = runHookSandboxed(["ensure-akm"], { akmVersion: "0.9.0" })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("akm_ready"))).toBe(true)
    expect(result.installLog).toBe("")
  })

  it("accepts stable 0.9.x", () => {
    for (const version of ["0.9.0", "0.9.5"]) {
      const result = runHookSandboxed(["ensure-akm"], { akmVersion: version })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.installLog).toBe("")
    }
  })

  it("rejects every tested build below the stable floor", () => {
    for (const version of ["0.8.3", "0.9.0-beta.6", "0.9.0-rc.15"]) {
      const result = runHookSandboxed(["ensure-akm"], { akmVersion: version })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
      expect(sessionLog.some((line) => line.includes("akm_version_mismatch") && line.includes(version))).toBe(true)
      expect(result.installLog).toBe("")
    }
  })

  it("accepts AKM_LOCAL_BUILD_CLI when a local build reports a stable 0.9.x", () => {
    const tempDir = makeTempDir()
    const localCli = path.join(tempDir, "dist", "cli.js")
    mkdirSync(path.dirname(localCli), { recursive: true })
    writeFileSync(localCli, "#!/usr/bin/env bun\nif (process.argv.includes('--version')) console.log('akm 0.9.0')\n")

    const result = runHookSandboxed(["ensure-akm"], {
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
    const result = runHookSandboxed(["ensure-akm"], { akmVersion: null })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("akm_missing"))).toBe(true)
    expect(result.installLog).toBe("")
  })

  it("logs an incompatible CLI without writing to stderr", () => {
    const result = runHookSandboxed(["ensure-akm"], { akmVersion: "0.9.0-rc.15" })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("akm_version_mismatch") && line.includes("0.9.0-rc.15"))).toBe(true)
    expect(result.installLog).toBe("")
  })

  it("never spawns an installer when AKM is missing", () => {
    const result = runHookSandboxed(["ensure-akm"], { akmVersion: null })
    expect(result.installLog).toBe("")
    expect(result.installLog).not.toContain("install\t-g\takm-cli@")
  })

  it("session-start reports missing AKM through additionalContext, not stderr", () => {
    const result = runHookSandboxed(["session-start"], { akmVersion: null })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("AKM is NOT available")
    expect(result.stdout).toContain("^0.9.0")
    expect(result.stdout).toContain("akm-cli@^0.9.0")
    expect(result.stdout).not.toContain("rc.14")
    expect(result.installLog).toBe("")
  })

  it("session-start runs normally with a compatible CLI and existing bundle", () => {
    const bundleDir = makeTempDir()
    const result = runHookSandboxed(["session-start"], {
      akmVersion: "0.9.0",
      env: { AKM_BUNDLE_DIR: bundleDir },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).not.toContain("AKM is NOT available")
    expect(result.installLog).toBe("")
  })

  it("session-start reports a missing bundle through context and the state log, not stderr", () => {
    const missingBundleDir = path.join(makeTempDir(), "definitely-not-here")
    const result = runHookSandboxed(["session-start"], {
      akmVersion: "0.9.0",
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
