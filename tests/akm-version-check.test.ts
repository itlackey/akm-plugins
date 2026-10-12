// The plugin must detect an unavailable or incompatible AKM CLI without
// silently installing software or writing raw diagnostics to stderr. The
// Claude hook reports degraded status through SessionStart additionalContext
// and records diagnostics in its plugin-local state log.

import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { meetsAkmMinVersion, AKM_MIN_VERSION } from "../claude/shared/akm-version"
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

describe("AKM_MIN_VERSION contract", () => {
  it("is a single minimum version, the first monthly build 0.10.261001", () => {
    expect(AKM_MIN_VERSION).toBe("0.10.261001")
  })

  it("accepts the floor itself and every later build, prerelease or not", () => {
    // 0.10 patches are 6-digit monthly release numbers (YYMMNN), compared as numbers. A prerelease of the floor
    // (0.10.261001-beta, -alpha) meets it: the gate compares the release core and ignores the tag.
    for (const version of ["0.10.261001", "0.10.261001-beta", "0.10.261001-alpha", "0.10.261002-rc", "0.10.261003", "0.10.261144", "0.10.261201-alpha", "0.10.270101", "0.10.991299", "0.10.261001+build.5", "v0.10.261001"]) {
      expect(meetsAkmMinVersion(version)).toBe(true)
    }
  })

  it("accepts the next minor and later majors: a newer akm is never an error", () => {
    for (const version of ["0.11.0", "0.11.0-beta.1", "0.11.261001", "0.12.3", "1.0.0", "1.0.0-rc.1", "2.5.7"]) {
      expect(meetsAkmMinVersion(version)).toBe(true)
    }
  })

  it("also accepts the retired daily alphas, which sort higher than every monthly build (accepted)", () => {
    // 0.10.YYMMDDNN has an 8-digit patch, so it compares above the floor in the 6-digit scheme (akm#1089).
    for (const version of ["0.10.26101001-alpha", "0.10.26101002-alpha", "0.10.26101201-alpha"]) {
      expect(meetsAkmMinVersion(version)).toBe(true)
    }
  })

  it("rejects only builds below the floor, prerelease or not", () => {
    // The plugins pass --detail agent, which akm 0.9 rejects, so every 0.9 release is refused.
    for (const version of ["0.8.9", "0.9.0", "0.9.30", "0.9.31", "0.9.31-alpha.3", "0.10.0", "0.10.0-beta.1", "0.10.260901", "0.10.260999-rc", "0.10.261000", "0.10.261000-beta"]) {
      expect(meetsAkmMinVersion(version)).toBe(false)
    }
  })

  it("rejects malformed or missing versions", () => {
    expect(meetsAkmMinVersion("not-a-version")).toBe(false)
    expect(meetsAkmMinVersion("0.10")).toBe(false)
    expect(meetsAkmMinVersion(null)).toBe(false)
    expect(meetsAkmMinVersion(undefined)).toBe(false)
  })
})

// Driven through `session-start`, the hook command the manifest actually wires
// and the one on which checkAkmVersion() runs. The former `ensure-akm` /
// `check-akm` entry points existed only for these tests.
describe("checkAkmVersion", () => {
  itPosix("returns ok, logs readiness, and stays silent on stderr for a compatible CLI", () => {
    const result = runHookSandboxed(["session-start"], { akmVersion: "0.10.261001-beta" })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("akm_ready"))).toBe(true)
    expect(result.installLog).toBe("")
  })

  itPosix("accepts 0.10 monthly builds at or above the floor, prerelease included", () => {
    for (const version of ["0.10.261001-beta", "0.10.261001", "0.10.261002-rc", "0.10.261101"]) {
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

  itPosix("accepts a later minor or major line", () => {
    for (const version of ["0.11.0", "0.11.0-beta.1", "1.2.0"]) {
      const result = runHookSandboxed(["session-start"], { akmVersion: version })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
      expect(sessionLog.some((line) => line.includes("akm_ready") && line.includes(version))).toBe(true)
      expect(sessionLog.some((line) => line.includes("akm_version_mismatch"))).toBe(false)
      expect(result.stdout).not.toContain("not available")
      expect(result.stdout).not.toContain("too old")
    }
  })

  itPosix("rejects every tested build below the floor", () => {
    for (const version of ["0.8.3", "0.9.0", "0.9.30", "0.9.31-alpha.3", "0.10.0-beta.1", "0.10.260901"]) {
      const result = runHookSandboxed(["session-start"], { akmVersion: version })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
      expect(sessionLog.some((line) => line.includes("akm_version_mismatch") && line.includes(version))).toBe(true)
      expect(result.installLog).toBe("")
    }
  })

  it("accepts AKM_LOCAL_BUILD_CLI when a local build reports a supported 0.10 build", () => {
    const tempDir = makeTempDir()
    const localCli = path.join(tempDir, "dist", "cli.js")
    mkdirSync(path.dirname(localCli), { recursive: true })
    writeFileSync(localCli, "#!/usr/bin/env bun\nif (process.argv.includes('--version')) console.log('akm 0.10.26101002')\n")

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

  itPosix("a too-old CLI gets an actionable message that does not forbid running akm", () => {
    // Old akm is installed, so the agent's own `akm curate/show` still run; only the hook-driven features
    // (which pass `--detail agent`) are off. The message names the installed version, the floor and the upgrade.
    const result = runHookSandboxed(["session-start"], { akmVersion: "0.9.31" })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const payload = JSON.parse(result.stdout.trim())
    const context = payload.hookSpecificOutput.additionalContext as string
    expect(context).toContain("akm is too old")
    expect(context).toContain("0.9.31")
    expect(context).toContain("0.10.261001")
    expect(context).toContain("npm install -g \"akm-cli@>=0.10.261001-0\"")
    expect(context).not.toContain("Do not call any `akm` Bash command")
    expect(payload.systemMessage).toContain("older than the required 0.10.261001")
    expect(payload.systemMessage).toContain("bun install -g \"akm-cli@>=0.10.261001-0\"")
    expect(result.installLog).toBe("")
  })

  itPosix("logs an incompatible CLI without writing to stderr", () => {
    const result = runHookSandboxed(["session-start"], { akmVersion: "0.9.30" })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("akm_version_mismatch") && line.includes("0.9.30"))).toBe(true)
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
    expect(result.stdout).toContain("Do not call any `akm` Bash command")
    expect(result.stdout).toContain("0.10.261001")
    expect(result.stdout).toContain("akm-cli@>=0.10.261001-0")
    expect(result.installLog).toBe("")
    // additionalContext reaches the model, which cannot install anything.
    // systemMessage is the channel to the person who can, so it has to carry
    // the concrete command rather than a pointer to the model's context.
    const payload = JSON.parse(result.stdout.trim())
    expect(payload.systemMessage).toContain("AKM is unavailable this session")
    expect(payload.systemMessage).toContain("bun install -g \"akm-cli@>=0.10.261001-0\"")
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
      akmVersion: "0.10.26101002",
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
      akmVersion: "0.10.26101002",
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
