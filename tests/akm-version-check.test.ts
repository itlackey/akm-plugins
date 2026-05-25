// Regression suite for Item 2 of the 0.8.0 pre-production polish plan:
// the Claude hook's old `ensureAkm()` silently spawned
// `bun install -g akm-cli@^0.8.0` (or npm) on every SessionStart. Starting
// with 0.8.0 we detect-and-warn instead: a stderr banner that points the
// user at `/akm-setup` for an explicit-consent install. These tests pin
// down the new behavior and make the regression (silent global install)
// impossible to reintroduce by accident.

import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

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

type HookResult = { stdout: string; stderr: string; exitCode: number; installLog: string }

// Runs the hook with `ensure-akm` (the legacy alias that still triggers
// checkAkmVersion in 0.8.0). The PATH is reset to ONLY the sandbox bin
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
  const installLog = path.join(tempDir, "install.log")
  mkdirSync(binDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })

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
  const env = {
    HOME: tempDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    XDG_STATE_HOME: stateDir,
    ...opts.env,
  }

  const result = Bun.spawnSync([process.execPath, hookScript, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })

  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode ?? 0,
    installLog: (() => {
      try {
        return readFileSync(installLog, "utf8")
      } catch {
        return ""
      }
    })(),
  }
}

describe("checkAkmVersion (Item 2: detect-and-warn, no silent install)", () => {
  it("returns ok and is silent on stderr when akm satisfies the required range", () => {
    const result = runHookSandboxed(["ensure-akm"], { akmVersion: "0.8.3" })
    expect(result.exitCode).toBe(0)
    // Banner is reserved for the failure path. Healthy installs emit no
    // user-visible warning.
    expect(result.stderr).not.toContain("akm-plugin:")
    // Critical regression assertion: NO install was spawned.
    expect(result.installLog).toBe("")
  })

  it("writes a stderr banner pointing at /akm-setup when akm is missing", () => {
    const result = runHookSandboxed(["ensure-akm"], { akmVersion: null })
    expect(result.exitCode).toBe(0)
    // Banner content
    expect(result.stderr).toContain("akm-plugin: akm CLI not installed or wrong version")
    expect(result.stderr).toContain("(not found on PATH)")
    expect(result.stderr).toContain("/akm-setup")
    // Install hints
    expect(result.stderr).toContain("bun install -g akm-cli@^0.8.0")
    expect(result.stderr).toContain("npm install -g akm-cli@^0.8.0")
    // Critical regression assertion: NO install was spawned even though bun
    // and npm shims are on PATH and would have logged any invocation.
    expect(result.installLog).toBe("")
  })

  it("writes a stderr banner pointing at /akm-setup when akm is the wrong version", () => {
    const result = runHookSandboxed(["ensure-akm"], { akmVersion: "0.7.9" })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("akm-plugin: akm CLI not installed or wrong version")
    // The detected (wrong) version should be quoted back to the user.
    expect(result.stderr).toContain("0.7.9")
    expect(result.stderr).toContain("/akm-setup")
    expect(result.stderr).toContain("bun install -g akm-cli@^0.8.0")
    // Critical regression assertion: still no install spawn.
    expect(result.installLog).toBe("")
  })

  it("never spawns an install even when bun and npm are both on PATH and akm is missing", () => {
    // This is the headline assertion of Item 2: even with the installers
    // sitting right there, the hook MUST NOT auto-install. The previous
    // implementation would have run `bun install -g akm-cli@^0.8.0` here.
    const result = runHookSandboxed(["ensure-akm"], { akmVersion: null })
    expect(result.installLog).toBe("")
    // Belt-and-braces: no argv containing `install -g akm-cli@` should
    // appear anywhere.
    expect(result.installLog).not.toContain("install\t-g\takm-cli@")
  })

  it("session-start emits a degraded context when akm is missing rather than crashing", () => {
    const result = runHookSandboxed(["session-start"], { akmVersion: null })
    expect(result.exitCode).toBe(0)
    // Banner still printed.
    expect(result.stderr).toContain("/akm-setup")
    // The hook returns JSON additionalContext telling the agent akm is not
    // available — it does NOT silently swallow this state.
    expect(result.stdout).toContain("AKM is NOT available")
    expect(result.stdout).toContain("/akm-setup")
    // And no install was spawned.
    expect(result.installLog).toBe("")
  })

  it("session-start runs normally when akm satisfies the range", () => {
    // Set AKM_STASH_DIR to an existing path so the stash-missing banner
    // (which lights up on missing stash regardless of akm install state)
    // does not fire. The banner is a separate signal exercised by its own
    // describe() block below.
    const stashDir = makeTempDir()
    const result = runHookSandboxed(["session-start"], {
      akmVersion: "0.8.3",
      env: { AKM_STASH_DIR: stashDir },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).not.toContain("akm-plugin:")
    // No degraded banner in the additionalContext either.
    expect(result.stdout).not.toContain("AKM is NOT available")
    expect(result.installLog).toBe("")
  })

  it("session-start emits a stash-missing stderr banner when the configured stash dir does not exist", () => {
    // The stash-missing path is the v0.8.0 release-readiness fix for
    // visibility — the prior implementation only added a warning to
    // `additionalContext`, which Claude routinely ignored or compacted
    // away. We mirror the akm-missing path and write the banner to stderr
    // so the user sees it in their terminal even when the agent ignores
    // the additionalContext block.
    const missingStashDir = path.join(makeTempDir(), "definitely-not-here")
    const result = runHookSandboxed(["session-start"], {
      akmVersion: "0.8.3",
      env: { AKM_STASH_DIR: missingStashDir },
    })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("akm-plugin: AKM stash directory missing")
    expect(result.stderr).toContain(missingStashDir)
    expect(result.stderr).toContain("/akm-setup")
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
    // The two installer commands the user is offered
    expect(body).toContain("bun install -g akm-cli@^0.8.0")
    expect(body).toContain("npm install -g akm-cli@^0.8.0")
    // Pointer at the interactive wizard for post-install configuration
    expect(body).toContain("akm setup")
  })
})
