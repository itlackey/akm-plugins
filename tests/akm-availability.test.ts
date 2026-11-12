// The plugin runs the akm-cli it carries (node_modules/akm-cli under the plugin root). When that is missing it
// must say so without installing software or writing raw diagnostics to stderr: the Claude hook reports the
// degraded status through SessionStart additionalContext and records diagnostics in its plugin-local state log.

import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PLUGIN_DIR, hostEnv, itPosix } from "./host-runtime"

const repoRoot = path.resolve(import.meta.dir, "..")

const tempDirs: string[] = []

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "akm-availability-"))
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
  /** False runs the hook from a plugin copy that carries no akm-cli, with an akm on PATH that must not be used. */
  bundled?: boolean
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

  // The fake akm the bridged akm-cli hands its arguments to (see PLUGIN_DIR).
  const fakeAkm = path.join(binDir, "akm")
  // Answers `info` from AKM_BUNDLE_DIR, as the real akm does: the hook takes the bundle root from `akm info`.
  writeFileSync(fakeAkm, `#!/usr/bin/env sh\nif [ "$1" = "doctor" ] && [ "$2" = "info" ]; then printf '{"bundleDir":"%s"}\\n' "$AKM_BUNDLE_DIR"; fi\nexit 0\n`)
  chmodSync(fakeAkm, 0o755)

  let pluginRoot = PLUGIN_DIR
  if (opts.bundled === false) {
    pluginRoot = path.join(tempDir, "plugin")
    cpSync(PLUGIN_DIR, pluginRoot, { recursive: true, filter: (source) => !source.includes("node_modules") })
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

  const result = Bun.spawnSync([process.execPath, path.join(pluginRoot, "hooks/akm-hook.ts"), ...args], {
    cwd: repoRoot,
    env: hostEnv(env, (key) => key.startsWith("AKM_") || key === "CLAUDE_PLUGIN_ROOT" || key === "PLUGIN_ROOT"),
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

describe("the plugin's akm-cli", () => {
  it("logs a missing akm-cli without writing to stderr, and never spawns an installer", () => {
    const result = runHookSandboxed(["session-start"], { bundled: false })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    const sessionLog = readLogLines(path.join(result.stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("akm_missing"))).toBe(true)
    expect(result.installLog).toBe("")
  })

  it("session-start reports a missing akm-cli through additionalContext, not stderr", () => {
    const result = runHookSandboxed(["session-start"], { bundled: false })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("AKM is NOT available")
    expect(result.stdout).toContain("Do not call any `akm` Bash command")
    expect(result.stdout).toContain("update or reinstall the AKM plugin")
    expect(result.installLog).toBe("")
    // additionalContext reaches the model, which cannot reinstall anything.
    // systemMessage is the channel to the person who can, so it has to say what to do.
    const payload = JSON.parse(result.stdout.trim())
    expect(payload.systemMessage).toContain("AKM is unavailable this session")
    expect(payload.systemMessage).toContain("Update or reinstall the AKM plugin")
  })

  itPosix("session-start ships the header and footer on a healthy CLI with a completely quiet stash", () => {
    // The most common profile there is: akm available, bundle
    // present, but nothing curated and no pending proposals. This
    // test used to assert only that stdout did NOT contain "AKM is NOT
    // available" — which the empty string satisfies, and the empty string is
    // exactly what this path emitted. SessionStart's whole job (tell the agent
    // akm exists, which lookup verb to reach for, how wide the surface is) was
    // unreachable on a fresh install. Assert the header actually ships.
    const bundleDir = makeTempDir()
    const result = runHookSandboxed(["session-start"], {
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

// Where Claude Code (or `bun install` in claude/) puts the akm-cli the plugin declares. Present on a machine that has
// installed claude/'s dependencies, as the CI jobs that run this file do.
const INSTALLED_CLI = path.join(repoRoot, "claude/node_modules/akm-cli/dist/cli.js")

describe.skipIf(!existsSync(INSTALLED_CLI))("the akm-cli the plugin declares", () => {
  it("is the exact version claude/package.json pins, and the hook starts it from the plugin root with no akm on PATH", () => {
    const pin = JSON.parse(readFileSync(path.join(repoRoot, "claude/package.json"), "utf8")).dependencies["akm-cli"]
    const home = makeTempDir()
    const env = hostEnv(
      {
        HOME: home,
        PATH: path.dirname(process.execPath),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        XDG_STATE_HOME: path.join(home, "state"),
        AKM_BUNDLE_DIR: path.join(home, "bundle"),
      },
      (key) => key.startsWith("AKM_") || key.startsWith("XDG_") || key === "CLAUDE_PLUGIN_ROOT" || key === "PLUGIN_ROOT",
    )
    mkdirSync(path.join(home, "bundle"), { recursive: true })

    const version = Bun.spawnSync([process.execPath, INSTALLED_CLI, "--version"], { env, stdio: ["ignore", "pipe", "pipe"] })
    expect(version.stdout.toString()).toContain(pin)

    // The repository's own hook, so the plugin root is claude/ and the akm-cli is the one just installed.
    const hook = Bun.spawnSync([process.execPath, path.join(repoRoot, "claude/hooks/akm-hook.ts"), "session-start"], { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] })
    expect(hook.exitCode).toBe(0)
    expect(JSON.parse(hook.stdout.toString().trim()).hookSpecificOutput.additionalContext).toContain("# AKM is available in this session")
    expect(readLogLines(path.join(home, "state/akm-claude/session.log"))[0]).toContain(`akm_ready\tpath\t${INSTALLED_CLI}`)
  })
})
