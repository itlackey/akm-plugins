// Regression suite for Item 2 of the 0.8.0 pre-production polish plan:
// the Claude hook's old `ensureAkm()` silently spawned
// `bun install -g akm-cli@…` (or npm) on every SessionStart. Starting
// with 0.8.0 we detect-and-warn instead: the hook logs the mismatch to the
// plugin state dir and surfaces the user-facing consent prompt through its
// supported output channel (SessionStart's `additionalContext`) rather than
// raw diagnostics on stderr — see AGENTS.md's logging-policy rule and
// release-0.9.0-plugin-review.md §2 ("Logging-policy violations"). These
// tests pin down both the no-silent-install behavior and the no-stderr
// behavior, and make either regression impossible to reintroduce by
// accident.
//
// 0.9.0 also drops 0.8.0 support from the accepted version range (release
// blocker #4 in the review): `akm extract --session-id` and curate
// `--detail brief` are 0.9.0-only runtime paths, so accepting 0.8.x here
// would silently pass the version gate onto a CLI the plugin no longer
// fully works with. AKM_VERSION_RANGE is now exactly
// `^0.9.0-beta.0 || ^0.9.0`.

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

// Runs the hook with `ensure-akm` (the legacy alias that still triggers
// checkAkmVersion in 0.8.0+). The PATH is reset to ONLY the sandbox bin
// directory so we never accidentally see the system's real bun/npm/akm.
// A fake `bun` and `npm` are placed on PATH; both log every invocation to
// `install.log`. If checkAkmVersion ever spawns an install, that log will
// pick it up — that is the regression-prevention assertion.
function runHookSandboxed(args: string[], opts: {
  akmVersion?: string | null
  /** Set to true to omit `bun` and `npm` shims entirely. */
  omitInstallers?: boolean
  env?: Record<string, string>
}): HookResult {
  const tempDir = makeTempDir()
  const binDir = path.join(tempDir, "bin")
  const stateDir = path.join(tempDir, "state")
  const configDir = path.join(tempDir, "config")
  const dataDir = path.join(tempDir, "data")
  const cacheDir = path.join(tempDir, "cache")
  const installLog = path.join(tempDir, "install.log")
  mkdirSync(binDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(configDir, { recursive: true })
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
    // Tripwire shims: any invocation lands in install.log. If the hook ever
    // spawns `bun install -g …` or `npm install -g …` this will catch it.
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

  // Deliberately pin PATH to ONLY the sandbox so the system's real installers
  // and akm cannot leak into the test. `/usr/bin:/bin` is appended because
  // bun (the runtime that executes the hook script) needs basic shell utils,
  // but bun/npm/akm are NOT on `/usr/bin` on any reasonable dev box.
  // Pin EVERY XDG base dir into the sandbox. getAkmConfigPath() reads
  // XDG_CONFIG_HOME — if the CI runner sets it to a config that already has
  // defaults.agent, the first-run auto-default never fires (green locally where
  // XDG_CONFIG_HOME is unset, red in CI). Pinning all of them makes config/data
  // reads hermetic regardless of the ambient environment.
  const env = {
    HOME: tempDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    XDG_STATE_HOME: stateDir,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: dataDir,
    XDG_CACHE_HOME: cacheDir,
    ...opts.env,
  }

  // Strip inherited AKM_* vars so the sandbox is truly hermetic: the hook's
  // behaviour (e.g. the AKM_PLUGIN_NO_AUTO_DEFAULT opt-out) must depend ONLY on
  // what this sandbox sets, not on the ambient/CI environment. (CI runners set
  // AKM_PLUGIN_NO_AUTO_DEFAULT=1, which previously leaked in and flipped the
  // first-run auto-default off — green locally, red in CI.)
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

describe("AKM_VERSION_RANGE contract (0.9.0: 0.8.0 support dropped)", () => {
  // Direct unit coverage of the shared contract, independent of the
  // subprocess sandbox below. This is the fast, precise pin for exactly
  // which versions the plugin accepts.
  it("is exactly the 0.9.0 (+ beta prerelease) range", () => {
    expect(AKM_VERSION_RANGE).toBe("^0.9.0-beta.0 || ^0.9.0")
  })

  it("rejects every 0.8.x build, including release candidates", () => {
    for (const v of ["0.8.0", "0.8.2", "0.8.0-rc.5"]) {
      expect(satisfiesAkmVersionRange(v)).toBe(false)
    }
  })

  it("accepts 0.9.0 betas and stable 0.9.x", () => {
    for (const v of ["0.9.0-beta.33", "0.9.0", "0.9.1"]) {
      expect(satisfiesAkmVersionRange(v)).toBe(true)
    }
  })

  it("rejects 0.7.x and 1.0.0", () => {
    for (const v of ["0.7.0", "0.7.9", "1.0.0"]) {
      expect(satisfiesAkmVersionRange(v)).toBe(false)
    }
  })

  it("excludes alpha prereleases (below the beta floor)", () => {
    expect(satisfiesAkmVersionRange("0.9.0-alpha.0")).toBe(false)
    expect(satisfiesAkmVersionRange("0.9.0-alpha.9")).toBe(false)
  })

  it("rejects malformed or missing versions", () => {
    expect(satisfiesAkmVersionRange("not-a-version")).toBe(false)
    expect(satisfiesAkmVersionRange(null)).toBe(false)
    expect(satisfiesAkmVersionRange(undefined)).toBe(false)
  })
})

describe("checkAkmVersion (Item 2: detect-and-warn, no silent install, no stderr)", () => {
  it("returns ok, logs akm_ready, and writes nothing to stderr when akm satisfies the required range", () => {
    const result = runHookSandboxed(["ensure-akm"], { akmVersion: "0.9.0" })
    expect(result.exitCode).toBe(0)
    // AGENTS.md: plugin runtime code must never write diagnostics to
    // stderr. Healthy installs (and every other checkAkmVersion path) must
    // be completely silent on stderr — the hook protocol's stdout JSON
    // envelope is the only supported output channel.
    expect(result.stderr).toBe("")
    const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("akm_ready"))).toBe(true)
    // Critical regression assertion: NO install was spawned.
    expect(result.installLog).toBe("")
  })

  it("returns ok and is silent on stderr for 0.9.x including prereleases (0.9.0-beta.6)", () => {
    for (const v of ["0.9.0", "0.9.5", "0.9.0-beta.6"]) {
      const result = runHookSandboxed(["ensure-akm"], { akmVersion: v })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.installLog).toBe("")
    }
  })

  it("rejects 0.8.x installs now that 0.8.0 support has been dropped", () => {
    for (const v of ["0.8.0", "0.8.2", "0.8.0-rc.5"]) {
      const result = runHookSandboxed(["ensure-akm"], { akmVersion: v })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
      expect(sessionLog.some((line) => line.includes("akm_version_mismatch") && line.includes(v))).toBe(true)
      expect(result.installLog).toBe("")
    }
  })

  it("accepts AKM_LOCAL_BUILD_CLI when pointed at a local dist build executed via Bun", () => {
    const tempDir = makeTempDir()
    const localCli = path.join(tempDir, "dist", "cli.js")
    mkdirSync(path.dirname(localCli), { recursive: true })
    writeFileSync(localCli, "#!/usr/bin/env bun\nif (process.argv.includes('--version')) console.log('akm 0.9.0-rc.8')\n")

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

  it("logs (not stderr) when akm is missing", () => {
    const result = runHookSandboxed(["ensure-akm"], { akmVersion: null })
    expect(result.exitCode).toBe(0)
    // No raw diagnostics on stderr — see AGENTS.md logging-policy rule.
    expect(result.stderr).toBe("")
    const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("akm_missing"))).toBe(true)
    // Critical regression assertion: NO install was spawned even though bun
    // and npm shims are on PATH and would have logged any invocation.
    expect(result.installLog).toBe("")
  })

  it("logs (not stderr) when akm is the wrong version", () => {
    const result = runHookSandboxed(["ensure-akm"], { akmVersion: "0.7.9" })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
    // The detected (wrong) version should be logged for diagnosis.
    expect(sessionLog.some((line) => line.includes("akm_version_mismatch") && line.includes("0.7.9"))).toBe(true)
    // Critical regression assertion: still no install spawn.
    expect(result.installLog).toBe("")
  })

  it("never spawns an install even when bun and npm are both on PATH and akm is missing", () => {
    // This is the headline assertion of Item 2: even with the installers
    // sitting right there, the hook MUST NOT auto-install. The previous
    // implementation would have run `bun install -g akm-cli@…` here.
    const result = runHookSandboxed(["ensure-akm"], { akmVersion: null })
    expect(result.installLog).toBe("")
    // Belt-and-braces: no argv containing `install -g akm-cli@` should
    // appear anywhere.
    expect(result.installLog).not.toContain("install\t-g\takm-cli@")
  })

  it("session-start emits a degraded context (with install hints) when akm is missing, on stdout — not stderr", () => {
    const result = runHookSandboxed(["session-start"], { akmVersion: null })
    expect(result.exitCode).toBe(0)
    // No stderr banner anymore — the consent prompt travels entirely
    // through the hook's supported stdout JSON channel.
    expect(result.stderr).toBe("")
    // The hook returns JSON additionalContext telling the agent akm is not
    // available — it does NOT silently swallow this state — and includes
    // the install hint (derived from AKM_PACKAGE_REF) that used to live
    // only in the stderr banner.
    expect(result.stdout).toContain("AKM is NOT available")
    expect(result.stdout).toContain("/akm-setup")
    expect(result.stdout).toContain("install -g akm-cli@")
    // And no install was spawned.
    expect(result.installLog).toBe("")
  })

  it("session-start runs normally when akm satisfies the range", () => {
    // Set AKM_STASH_DIR to an existing path so the stash-missing warning
    // (which lights up on missing stash regardless of akm install state)
    // does not fire. That path is exercised by its own describe() block
    // below.
    //
    // #72: also set AKM_PLUGIN_NO_AUTO_DEFAULT=1 so the new "defaults.agent
    // initialized" notice does not fire. That notice IS the intended
    // behavior on first SessionStart (we now surface the auto-write to
    // OpenCode users who install the Claude plugin); a dedicated test
    // below exercises that path.
    const stashDir = makeTempDir()
    const result = runHookSandboxed(["session-start"], {
      akmVersion: "0.9.0",
      env: { AKM_STASH_DIR: stashDir, AKM_PLUGIN_NO_AUTO_DEFAULT: "1" },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    // No degraded banner in the additionalContext either.
    expect(result.stdout).not.toContain("AKM is NOT available")
    expect(result.installLog).toBe("")
  })

  it("session-start surfaces the auto-default-agent write on first run (#72) without touching stderr", () => {
    // Without AKM_PLUGIN_NO_AUTO_DEFAULT, the first SessionStart writes
    // defaults.agent=claude AND surfaces an additionalContext notice (no
    // longer a stderr banner) so OpenCode users who install the Claude
    // plugin to experiment see that their config was modified.
    const stashDir = makeTempDir()
    const result = runHookSandboxed(["session-start"], {
      akmVersion: "0.9.0",
      env: { AKM_STASH_DIR: stashDir },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("defaults.agent=claude")
    expect(result.stdout).toContain("AKM_PLUGIN_NO_AUTO_DEFAULT=1")
    const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("agent_default_initialized"))).toBe(true)
    expect(result.installLog).toBe("")
  })

  it("session-start surfaces a stash-missing warning (additionalContext + state log, not stderr) when the configured stash dir does not exist", () => {
    // The stash-missing path is a v0.8.0 release-readiness fix for
    // visibility. It was previously mirrored to a stderr banner; 0.9.0
    // removes that duplicate stderr write (AGENTS.md logging-policy rule) —
    // the additionalContext block plus a state-dir log entry are the
    // supported channels.
    const missingStashDir = path.join(makeTempDir(), "definitely-not-here")
    const result = runHookSandboxed(["session-start"], {
      akmVersion: "0.9.0",
      env: { AKM_STASH_DIR: missingStashDir },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("AKM stash directory")
    expect(result.stdout).toContain(missingStashDir)
    expect(result.stdout).toContain("/akm-setup")
    const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("stash_missing") && line.includes(missingStashDir))).toBe(true)
  })
})

describe("/akm-setup is the canonical install consent point", () => {
  it("ships a slash command that gates the install behind explicit user confirmation", () => {
    const body = readFileSync(path.join(repoRoot, "claude/commands/akm-setup.md"), "utf8")
    // Detection step
    expect(body).toContain("akm --version")
    // Explicit consent gate (the headline behavior of Item 2). We normalize
    // whitespace because the prose may wrap the phrase across lines.
    const normalized = body.toLowerCase().replace(/\s+/g, " ")
    expect(normalized).toContain("wait for explicit confirmation")
    // Pointer at the interactive wizard for post-install configuration
    expect(body).toContain("akm setup")
  })
})
