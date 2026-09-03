/**
 * akm-plugins#106 follow-up — the plugin must drive the NEWEST compatible akm
 * it can find, not the first one that happens to satisfy the floor.
 *
 * `AKM_REQUIRED_VERSION_RANGE` is a range (^0.9.8), so first-compatible-wins
 * bound the plugin to whatever in-range `akm` sat earliest in the candidate
 * list — for as long as that stayed true. A plugin depending on a much newer
 * akm-cli would silently drive an ancient one, which is the shape of #106.
 *
 * Both candidate sources are sandboxable: the config candidate comes from
 * `XDG_CONFIG_HOME/opencode/node_modules/.bin/akm`, and the generic candidate
 * is `akm` on `PATH`. Staging two fake CLIs that report different versions
 * makes the ordering observable.
 *
 * Runs in a SUBPROCESS for the same reason as tests/opencode-curate-floor.ts:
 * bun:test module mocks are process-global for the whole run, so importing the
 * plugin in-process here would leak into tests/opencode-plugin.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "..")
const sandboxes: string[] = []

afterEach(() => {
  while (sandboxes.length) rmSync(sandboxes.pop()!, { recursive: true, force: true })
})

/** A fake `akm` that reports `version` and echoes a marker so we can tell which ran. */
function writeFakeAkm(file: string, version: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nexit 0\n`)
  chmodSync(file, 0o755)
}

/**
 * Stage a config-dir akm and a PATH akm at the given versions, then ask the
 * plugin which one it resolved.
 */
function resolveWith(configVersion: string, pathVersion: string): { command: string; version: string } | null {
  const sandbox = mkdtempSync(path.join(tmpdir(), "akm-selection-"))
  sandboxes.push(sandbox)

  const configAkm = path.join(sandbox, "config", "opencode", "node_modules", ".bin", "akm")
  writeFakeAkm(configAkm, configVersion)
  const pathDir = path.join(sandbox, "bin")
  writeFakeAkm(path.join(pathDir, "akm"), pathVersion)

  const script = `
    const { AkmPlugin } = await import(${JSON.stringify(path.join(repoRoot, "opencode/index.ts"))})
    AkmPlugin.__resetResolvedAkmForTests?.()
    const details = AkmPlugin.__resolvedAkmDetailsForTests()
    process.stdout.write(JSON.stringify(details ? { command: details.command, version: details.version } : null))
  `
  const result = Bun.spawnSync(["bun", "-e", script], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: sandbox,
      XDG_CONFIG_HOME: path.join(sandbox, "config"),
      PATH: `${pathDir}:${process.env.PATH}`,
      // Keep the plugin's own bundled akm-cli out of the comparison so the test
      // observes exactly the two candidates it staged.
      AKM_OPENCODE_IGNORE_BUNDLED_CLI: "1",
      AKM_LOCAL_BUILD_CLI: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = result.stdout.toString()
  if (result.exitCode !== 0 || !stdout) {
    throw new Error(`resolution probe failed (exit ${result.exitCode}): ${result.stderr.toString().slice(0, 400)}`)
  }
  return JSON.parse(stdout)
}

describe("#106 akm selection picks the newest compatible candidate", () => {
  test("a newer PATH akm beats an older, earlier-listed config akm", () => {
    // The config candidate is probed FIRST. Under first-compatible-wins this
    // returned 0.9.8; the whole point of the change is that it no longer does.
    const resolved = resolveWith("0.9.8", "0.9.11")

    expect(resolved).not.toBeNull()
    expect(resolved!.version).toBe("0.9.11")
  })

  test("a newer config akm still wins when it is the newest", () => {
    const resolved = resolveWith("0.9.11", "0.9.8")

    expect(resolved!.version).toBe("0.9.11")
  })

  test("candidate order breaks ties, so an equal-version config akm is kept", () => {
    const resolved = resolveWith("0.9.11", "0.9.11")

    expect(resolved!.version).toBe("0.9.11")
    expect(resolved!.command).toContain("node_modules/.bin/akm")
  })

  test("an out-of-range candidate is skipped even when it is newest", () => {
    // 0.8.0 is below the ^0.9.8 floor: eligibility still gates selection.
    const resolved = resolveWith("0.9.9", "0.8.0")

    expect(resolved!.version).toBe("0.9.9")
  })
})
