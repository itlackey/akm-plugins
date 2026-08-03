import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { installFakeAkm } from "../evals/lib/fake-akm"

// Pins evals/lib/fake-akm.ts's envelopes for the verbs the plugin hooks
// actually invoke (workflow list --active, proposal list, proposal extract)
// against a REAL akm binary, so a real 0.9 envelope shape change
// would fail this test instead of passing every eval/unit test silently
// (the failure mode called out in docs/reviews/release-0.9.0-plugin-review.md
// §7 "Three independent fake-akm implementations, none contract-tested").
//
// Uses Bun.spawnSync rather than node:child_process's execFileSync
// deliberately: tests/opencode-plugin.test.ts calls `mock.module("node:
// child_process", ...)` at module scope, and bun:test module mocks are
// process-global for the whole `bun test tests/` run (not scoped to the
// file that registered them) — importing the real execFileSync here would
// silently bind to that mock when this file runs alongside it. Bun.spawnSync
// is a separate, unmocked code path.
//
// PATH `akm` is not assumed to exist in every environment this test runs in;
// we use the bundled binary at opencode/node_modules/.bin/akm (installed by
// `bun install` in opencode/, which both tests.yml and evals.yml do before
// running `bun test tests/`). When that binary isn't present — e.g. a
// checkout that skipped `bun install` — the whole suite is skipped with a
// clear reason rather than failing.
const repoRoot = path.resolve(import.meta.dir, "..")
const REAL_AKM = path.join(repoRoot, "opencode/node_modules/.bin/akm")
const akmAvailable = existsSync(REAL_AKM)

if (!akmAvailable) {
  console.warn(
    `[fake-akm-contract] skipping: no real akm binary at ${path.relative(repoRoot, REAL_AKM)}. ` +
      `Run \`bun install\` in opencode/ to pull in the bundled akm-cli and re-run.`,
  )
}

/**
 * Shape fingerprint used for comparison: sorted top-level keys for a JSON
 * object, or a type sentinel for scalars/arrays/null (real akm returns a
 * bare JSON scalar for leaf `config get` calls — there are no keys to
 * compare, so the fingerprint falls back to the JS type).
 */
function envelopeShape(value: unknown): string[] {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>).sort()
  }
  return [`<${value === null ? "null" : typeof value}>`]
}

type SpawnResult = { exitCode: number; stdout: string; stderr: string }

function spawnSync(cmd: string, args: string[], env?: Record<string, string | undefined>): SpawnResult {
  const result = Bun.spawnSync([cmd, ...args], {
    env: env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  }
}

function realAkmEnv(cwd: RealEnv): Record<string, string | undefined> {
  return {
    ...process.env,
    HOME: cwd.HOME,
    XDG_CONFIG_HOME: cwd.XDG_CONFIG_HOME,
    AKM_BUNDLE_DIR: cwd.AKM_BUNDLE_DIR,
    AKM_FORCE_INIT_TMP_STASH: "1",
    // akm-cli refuses to resolve a data/state directory under `bun test`
    // unless these are explicitly pointed at a temp dir (guards against
    // tests touching the developer's real ~/.local/share|state/akm).
    XDG_DATA_HOME: cwd.XDG_DATA_HOME,
    XDG_STATE_HOME: cwd.XDG_STATE_HOME,
  }
}

function runReal(cwd: RealEnv, args: string[]): unknown {
  const result = spawnSync(REAL_AKM, args, realAkmEnv(cwd))
  if (result.exitCode !== 0) {
    throw new Error(`akm ${args.join(" ")} exited ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

function runRealAllowError(cwd: RealEnv, args: string[]): unknown {
  const result = spawnSync(REAL_AKM, args, realAkmEnv(cwd))
  // akm's own error envelopes (e.g. extract with no LLM configured) exit
  // non-zero and print JSON to stderr; success envelopes print to stdout.
  const body = [result.stdout, result.stderr].find((s) => s.trim())
  if (!body) throw new Error(`akm ${args.join(" ")} exited ${result.exitCode} with no output on stdout or stderr`)
  return JSON.parse(body)
}

function runFake(akmPath: string, args: string[]): unknown {
  const result = spawnSync(akmPath, args)
  if (result.exitCode !== 0) {
    throw new Error(`fake akm ${args.join(" ")} exited ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

describe("fake-akm envelope contract", () => {
  test.skipIf(!akmAvailable)("workflow list --active envelope matches real akm", () => {
    const real = makeRealEnv()
    const fake = makeFakeEnv()
    try {
      const realEnvelope = runReal(real, ["--format", "json", "-q", "workflow", "list", "--active"])
      const fakeEnvelope = runFake(fake.akmPath, ["--format", "json", "-q", "workflow", "list", "--active"])
      expect(envelopeShape(fakeEnvelope)).toEqual(envelopeShape(realEnvelope))
    } finally {
      cleanup(real)
      cleanup(fake)
    }
  })

  test.skipIf(!akmAvailable)("proposal list envelope matches real akm", () => {
    const real = makeRealEnv()
    const fake = makeFakeEnv()
    try {
      const realEnvelope = runReal(real, ["proposal", "list", "--status", "pending", "--format", "json"])
      const fakeEnvelope = runFake(fake.akmPath, ["proposal", "list", "--status", "pending", "--format", "json"])
      expect(envelopeShape(fakeEnvelope)).toEqual(envelopeShape(realEnvelope))
    } finally {
      cleanup(real)
      cleanup(fake)
    }
  })

  test.skipIf(!akmAvailable)("extract envelope matches real akm with no LLM configured", () => {
    const real = makeRealEnv()
    const fake = makeFakeEnv()
    try {
      // A freshly-init'd stash (like these temp fixtures, and like tier-2's
      // fixtures) has no LLM connection configured, so a direct `akm
      // extract` deterministically returns the config-error envelope —
      // that's the shape pinned here.
      const realEnvelope = runRealAllowError(real, [
        "--format",
        "json",
        "-q",
        "proposal",
        "extract",
        "--type",
        "opencode",
        "--session-id",
        "contract-test",
        "--dry-run",
      ])
      const fakeEnvelope = runFake(fake.akmPath, [
        "--format",
        "json",
        "-q",
        "proposal",
        "extract",
        "--type",
        "opencode",
        "--session-id",
        "contract-test",
        "--dry-run",
      ])
      expect(envelopeShape(fakeEnvelope)).toEqual(envelopeShape(realEnvelope))
      expect((fakeEnvelope as { ok: boolean }).ok).toBe(false)
      expect((realEnvelope as { ok: boolean }).ok).toBe(false)
    } finally {
      cleanup(real)
      cleanup(fake)
    }
  })
})

type RealEnv = {
  HOME: string
  XDG_CONFIG_HOME: string
  AKM_BUNDLE_DIR: string
  XDG_DATA_HOME: string
  XDG_STATE_HOME: string
  root: string
}

function makeRealEnv(): RealEnv {
  const root = mkdtempSync(path.join(tmpdir(), "akm-contract-real-"))
  const env: RealEnv = {
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    AKM_BUNDLE_DIR: path.join(root, "bundle"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    root,
  }
  mkdirSync(env.AKM_BUNDLE_DIR, { recursive: true })
  const init = spawnSync(REAL_AKM, ["bundle", "create", "--dir", env.AKM_BUNDLE_DIR, "--set-default"], realAkmEnv(env))
  if (init.exitCode !== 0) {
    throw new Error(`akm bundle create failed: exit ${init.exitCode}\nstdout: ${init.stdout}\nstderr: ${init.stderr}`)
  }
  return env
}

function makeFakeEnv() {
  const root = mkdtempSync(path.join(tmpdir(), "akm-contract-fake-"))
  const binDir = path.join(root, "bin")
  const callLog = path.join(root, "calls.log")
  const fake = installFakeAkm({ binDir, callLog, assets: [] })
  return { ...fake, root }
}

function cleanup(env: { root: string }) {
  try {
    rmSync(env.root, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}
