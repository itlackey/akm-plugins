// Spin up an isolated sandbox for running the plugin hooks during evals.
// The hook script writes to $XDG_STATE_HOME/akm-claude and consults $AKM_BUNDLE_DIR
// — both must point at temp directories so concurrent evals don't collide
// and so each scenario starts from a clean slate.
//
// The sandbox exports the AKM 0.9.14 bundle-root environment variable only.

import { mkdtempSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { installFakeAkm, type FakeAkmAsset } from "./fake-akm"

export type SandboxOptions = {
  // Source stash to copy into the sandbox. Defaults to the bundled fixture.
  sourceStash?: string
  // Override which assets the fake akm sees (defaults to scanning sourceStash).
  fakeAssets?: FakeAkmAsset[]
  // Skip installing fake-akm (eval will run with real akm on PATH).
  realAkm?: boolean
  // Extra env to merge in.
  env?: Record<string, string>
}

export type Sandbox = {
  root: string
  binDir: string
  stateDir: string
  stashDir: string
  callLog: string
  env: Record<string, string>
  cleanup: () => void
}

export function createSandbox(opts: SandboxOptions = {}): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "akm-eval-"))
  const binDir = path.join(root, "bin")
  const stateDir = path.join(root, "state")
  const stashDir = path.join(root, "stash")
  const configDir = path.join(root, "config")
  const cacheDir = path.join(root, "cache")
  mkdirSync(binDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  mkdirSync(cacheDir, { recursive: true })

  if (opts.sourceStash && existsSync(opts.sourceStash)) {
    cpSync(opts.sourceStash, stashDir, { recursive: true })
  } else {
    mkdirSync(stashDir, { recursive: true })
  }

  const callLog = path.join(stateDir, "akm-calls.log")

  if (!opts.realAkm) {
    installFakeAkm({
      binDir,
      callLog,
      assets: opts.fakeAssets ?? { stashDir },
    })
  }

  const env: Record<string, string> = {
    HOME: root,
    PATH: opts.realAkm
      ? (process.env.PATH ?? "/usr/bin:/bin")
      : `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    XDG_STATE_HOME: stateDir,
    XDG_CONFIG_HOME: configDir,
    XDG_CACHE_HOME: cacheDir,
    // Bundle-root override for the fake akm and akm 0.10 (newer akm no longer
    // reads it). The plugins no longer read it themselves: they take the bundle
    // root from `akm info` (claude/hooks/akm-hook.ts resolveStashRoots(),
    // opencode/index.ts getAkmBundleDir()), which answers from this variable.
    // Ref validation early-returns [] when no bundle root resolves, so an unset
    // AKM_BUNDLE_DIR silently disables ALL ref extraction — and therefore all
    // auto-feedback.
    AKM_BUNDLE_DIR: stashDir,
    // Point the OpenCode plugin at the deterministic shim instead of the
    // akm-cli dependency it would otherwise resolve. Claude's hook reaches the
    // same shim through the bridged plugin root (evals/lib/plugin-root.ts) and
    // the sandbox PATH.
    ...(opts.realAkm ? {} : { AKM_OPENCODE_CLI: path.join(binDir, "akm") }),
    ...opts.env,
  }

  return {
    root,
    binDir,
    stateDir,
    stashDir,
    callLog,
    env,
    cleanup() {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {}
    },
  }
}
