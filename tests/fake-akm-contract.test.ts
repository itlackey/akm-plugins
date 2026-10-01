import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { installFakeAkm, type FakeAkmAsset } from "../evals/lib/fake-akm"
import { validateRefCandidates } from "../claude/shared/ref-extraction"

// Pins evals/lib/fake-akm.ts's envelopes for the verbs the plugin hooks
// actually invoke (search, curate, info, workflow list --active, proposal
// list, proposal extract) against a REAL akm binary, so a real 0.9 envelope shape change
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
// PATH `akm` is not assumed to exist in every environment this test runs in.
// Prefer the normal package-manager shim, but also support the linked
// akm-cli package used by release validation before npm has published the new
// floor. The CLI is launched through the current Bun runtime so this contract
// test needs no globally installed Node executable.
const repoRoot = path.resolve(import.meta.dir, "..")
const REAL_AKM = [
  path.join(repoRoot, "opencode/node_modules/.bin/akm"),
  path.join(repoRoot, "opencode/node_modules/akm-cli/dist/akm"),
].find(existsSync) ?? path.join(repoRoot, "opencode/node_modules/.bin/akm")
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
  const result = spawnSync(process.execPath, [REAL_AKM, ...args], realAkmEnv(cwd))
  if (result.exitCode !== 0) {
    throw new Error(`akm ${args.join(" ")} exited ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

function runFake(akmPath: string, args: string[]): unknown {
  const result = spawnSync(akmPath, args)
  if (result.exitCode !== 0) {
    throw new Error(`fake akm ${args.join(" ")} exited ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  }
  return JSON.parse(result.stdout)
}

/** The same as spawnSync(), for a test that probes many refs and runs them side by side. */
async function runAsync(cmd: string, args: string[], env?: Record<string, string | undefined>): Promise<SpawnResult> {
  const proc = Bun.spawn([cmd, ...args], { env: env ?? process.env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}

/**
 * Raw spawn for verbs whose FAILURE path is the contract. Returns the exit
 * code and both streams unparsed so a test can pin which stream the envelope
 * arrived on — `envelopeShape()` alone cannot catch a fake that writes the
 * right keys to the wrong stream with the wrong exit code.
 */
function runRaw(cmd: string, args: string[], env?: Record<string, string | undefined>): SpawnResult {
  return spawnSync(cmd, args, env)
}

describe("fake-akm envelope contract", () => {
  test.skipIf(!akmAvailable)("search envelope matches real akm, including the results alias", () => {
    const real = makeRealEnv()
    const fake = makeFakeEnv()
    try {
      const args = ["--format", "json", "--shape", "agent", "-q", "search", "contract-no-match", "--from", "local"]
      const realEnvelope = runReal(real, args) as Record<string, unknown>
      const fakeEnvelope = runFake(fake.akmPath, args) as Record<string, unknown>
      expect(envelopeShape(fakeEnvelope)).toEqual(envelopeShape(realEnvelope))
      expect(realEnvelope.hits).toEqual(realEnvelope.results)
      expect(fakeEnvelope.hits).toEqual(fakeEnvelope.results)
    } finally {
      cleanup(real)
      cleanup(fake)
    }
  })

  test.skipIf(!akmAvailable)("curate envelope matches real akm, including the results alias", () => {
    const real = makeRealEnv()
    const fake = makeFakeEnv()
    try {
      const args = ["--format", "json", "--shape", "agent", "-q", "curate", "contract-no-match", "--from", "local", "--limit", "5"]
      const realEnvelope = runReal(real, args) as Record<string, unknown>
      const fakeEnvelope = runFake(fake.akmPath, args) as Record<string, unknown>
      expect(envelopeShape(fakeEnvelope)).toEqual(envelopeShape(realEnvelope))
      expect(realEnvelope.items).toEqual(realEnvelope.results)
      expect(fakeEnvelope.items).toEqual(fakeEnvelope.results)
    } finally {
      cleanup(real)
      cleanup(fake)
    }
  })

  // `info` gates ALL ref validation on both plugins: they resolve their
  // bundle root from $AKM_BUNDLE_DIR, else `akm info --format json` →
  // .bundleDir (claude/hooks/akm-hook.ts resolveStashRoots(),
  // opencode/index.ts getAkmBundleDir()). With no bundle root,
  // validateRefCandidates() early-returns [] and auto-feedback silently
  // never fires — which is exactly how tier-2's feedback recall went 1 → 0
  // when the fake shim didn't model this verb at all.
  test.skipIf(!akmAvailable)("info envelope matches real akm", () => {
    const real = makeRealEnv()
    const fake = makeFakeEnv()
    try {
      const realEnvelope = runReal(real, ["--format", "json", "-q", "info"]) as Record<string, unknown>
      const fakeEnvelope = runFake(fake.akmPath, ["--format", "json", "-q", "info"]) as Record<string, unknown>
      expect(envelopeShape(fakeEnvelope)).toEqual(envelopeShape(realEnvelope))
      // The two fields the plugins actually consume: .bundleDir (the bundle
      // root every ref resolves against) and .assetTypes (the 0.9 asset-type
      // vocabulary the concept-root lists in ref-extraction derive from).
      expect(typeof fakeEnvelope.bundleDir).toBe("string")
      expect(realEnvelope.bundleDir).toBe(real.AKM_BUNDLE_DIR)
      expect(fakeEnvelope.assetTypes).toEqual(realEnvelope.assetTypes)
    } finally {
      cleanup(real)
      cleanup(fake)
    }
  })

  // The hook's quality probe (`akm show <ref>`) and the validator in front of it
  // (claude/shared/ref-extraction.ts) both assume real akm's ref grammar, so it
  // is pinned here instead of inferred from logs: a concept ID resolves, a file
  // path that merely exists does not, and a refusal leaves stdout empty, which
  // is how autoFeedback() reads "akm cannot resolve this ref".
  test.skipIf(!akmAvailable)("show and feedback resolve concept IDs, not file paths, and refuse with an empty stdout", () => {
    const real = makeRealEnv()
    try {
      const write = (file: string, body: string) => {
        mkdirSync(path.dirname(path.join(real.AKM_BUNDLE_DIR, file)), { recursive: true })
        writeFileSync(path.join(real.AKM_BUNDLE_DIR, file), body)
      }
      write("knowledge/guide.md", "# Guide\n")
      write("tasks/nightly.yml", "version: 4\nname: nightly\nrun: echo hi\n")
      write("skills/rollout/SKILL.md", "---\nname: rollout\ndescription: Roll out\nwhen_to_use: Rolling out\n---\n# Rollout\n")
      write("skills/rollout/scripts/run.py", "print('hi')\n")
      runReal(real, ["--format", "json", "-q", "index"])

      const run = (...args: string[]) => runRaw(process.execPath, [REAL_AKM, ...args], realAkmEnv(real))
      for (const ref of ["knowledge/guide", "knowledge/guide.md", "tasks/nightly", "skills/rollout"]) {
        const shown = run("--format", "json", "-q", "show", ref)
        expect(shown.exitCode).toBe(0)
        expect(typeof (JSON.parse(shown.stdout) as { ref?: unknown }).ref).toBe("string")
      }
      for (const ref of ["tasks/nightly.yml", "skills/rollout/SKILL.md", "skills/rollout/scripts/run.py"]) {
        const shown = run("--format", "json", "-q", "show", ref)
        expect(shown.exitCode).not.toBe(0)
        expect(shown.stdout.trim()).toBe("")
        expect(run("feedback", ref, "--positive", "--format", "json", "-q").exitCode).not.toBe(0)
      }
    } finally {
      cleanup(real)
    }
  })

  // The ref validator (claude/shared/ref-extraction.ts) is a path rule: a concept
  // ID is the file's path with the extension its type owns dropped. Its source
  // of truth is akm, so it is pinned here type by type against the real binary:
  // `show` and `feedback` accept the canonical ref of every asset type, both
  // refuse the spellings that merely name a file, and the validator says the same
  // about every one of them (checked against 0.9.20).
  test.skipIf(!akmAvailable)("show and feedback accept the canonical ref of every asset type, and the validator agrees", async () => {
    const real = makeRealEnv()
    try {
      const bundle = real.AKM_BUNDLE_DIR
      const write = (file: string, body: string) => {
        mkdirSync(path.dirname(path.join(bundle, file)), { recursive: true })
        writeFileSync(path.join(bundle, file), body)
      }
      // A new bundle git-ignores env/ and secrets/, and akm indexes what git
      // lists, so a stash that keeps them (the documented opt-in) un-ignores them.
      writeFileSync(path.join(bundle, ".gitignore"), "")
      write("agents/reviewer.md", "---\ndescription: Reviewer\n---\nReview.\n")
      write("commands/ship.md", "---\ndescription: Ship\n---\nShip it.\n")
      write("env/staging.env", "STAGING_KEY=1\n")
      write("env/.env", "DEFAULT_KEY=1\n")
      write("env/team/.env", "TEAM_KEY=1\n")
      write("facts/pricing.md", "---\ndescription: Pricing\n---\nTiers.\n")
      write("instructions/review.md", "---\ndescription: Review\n---\nReview PRs.\n")
      write("knowledge/guide.md", "# Guide\n")
      write("knowledge/guide.md.bak", "# Guide\n")
      write("lessons/rollback.md", "---\ndescription: Rollback\nwhen_to_use: Rolling back\n---\nRoll back.\n")
      write("memories/notes.md", "---\ndescription: Notes\n---\nNotes.\n")
      write("memories/solo.derived.md", "---\ndescription: Derived\n---\nDerived.\n")
      write("scripts/deploy.sh", "echo deploy\n")
      write("scripts/team/tool.py", "print('tool')\n")
      write("scripts/page.html", "<html></html>\n")
      write("scripts/data.json", "{}\n")
      write("secrets/api-token", "token\n")
      write("secrets/tls.pem", "pem\n")
      write("secrets/old.lock", "lock\n")
      write("sessions/retro.md", "---\ndescription: Retro\n---\nRetro.\n")
      write("skills/rollout/SKILL.md", "---\nname: rollout\ndescription: Roll out\nwhen_to_use: Rolling out\n---\n# Rollout\n")
      write("skills/rollout/scripts/run.py", "print('hi')\n")
      write("tasks/nightly.yml", "version: 4\nname: nightly\nrun: echo hi\n")
      write("tasks/legacy.yaml", "version: 4\nname: legacy\nrun: echo hi\n")
      write("workflows/release.md", "---\ntype: workflow\ndescription: Release\nsteps:\n  - id: one\n---\n\n# Release\n\n## one\n\nDo one thing.\n")
      write("workflows/ship.yml", "name: Ship\non:\n  workflow_dispatch: {}\njobs:\n  main:\n    runs-on: [self-hosted]\n    steps:\n      - id: one\n        run: echo hi\n")
      runReal(real, ["--format", "json", "-q", "index"])

      // One ref per type, in the spelling akm itself prints (plus `.md` where akm
      // tolerates it), and a derived memory by its own ID.
      const canonical = [
        "agents/reviewer",
        "commands/ship",
        "env/default",
        "env/staging",
        "env/team/default",
        "facts/pricing",
        "instructions/review",
        "knowledge/guide",
        "knowledge/guide.md",
        "lessons/rollback",
        "memories/notes",
        "memories/solo.derived",
        "scripts/deploy.sh",
        "scripts/team/tool.py",
        "secrets/api-token",
        "secrets/tls.pem",
        "sessions/retro",
        "skills/rollout",
        "tasks/nightly",
        "workflows/release",
        "workflows/release.md",
        "workflows/ship",
      ]
      // Each of these names a file akm has, and akm refuses it: `show` fails, or
      // answers without a ref, or `feedback` fails (workflows/ship.yml).
      const refused = [
        "env/.env",
        "env/staging.env",
        "env/team/.env",
        "knowledge/guide.md.bak",
        "knowledge/missing",
        "memories/solo",
        "scripts/data.json",
        "scripts/deploy",
        "scripts/page.html",
        "secrets/old.lock",
        "skills/rollout/SKILL.md",
        "skills/rollout/scripts/run.py",
        "tasks/legacy",
        "tasks/legacy.yaml",
        "tasks/nightly.yml",
        "workflows/ship.yml",
      ]

      const accepts = async (ref: string) => {
        const show = await runAsync(process.execPath, [REAL_AKM, "--format", "json", "-q", "show", ref], realAkmEnv(real))
        const named = show.exitCode === 0 && typeof (JSON.parse(show.stdout) as { ref?: unknown }).ref === "string"
        if (!named) return false
        return (await runAsync(process.execPath, [REAL_AKM, "feedback", ref, "--positive", "--format", "json", "-q"], realAkmEnv(real))).exitCode === 0
      }
      const accepted = new Map<string, boolean>()
      const queue = [...canonical, ...refused]
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          for (let ref = queue.shift(); ref !== undefined; ref = queue.shift()) accepted.set(ref, await accepts(ref))
        }),
      )

      expect(canonical.filter((ref) => !accepted.get(ref))).toEqual([])
      expect(refused.filter((ref) => accepted.get(ref))).toEqual([])
      expect(validateRefCandidates([...canonical, ...refused], [bundle])).toEqual([...canonical].sort())
    } finally {
      cleanup(real)
    }
  }, 60_000)

  // The hook's quality probe (refQuality in claude/hooks/akm-hook.ts) treats a
  // show response without `ref` as "not an asset". That rests on this: a file
  // under scripts/ whose extension is not a script extension is never indexed, so
  // `show` reads it off disk and exits 0 with an envelope that names no `ref`,
  // while `feedback` refuses it (checked against 0.9.20).
  test.skipIf(!akmAvailable)("show answers a file that is no asset without a ref, and feedback refuses it", () => {
    const real = makeRealEnv()
    try {
      mkdirSync(path.join(real.AKM_BUNDLE_DIR, "scripts"), { recursive: true })
      writeFileSync(path.join(real.AKM_BUNDLE_DIR, "scripts/health-report-template.html"), "<html></html>\n")
      writeFileSync(path.join(real.AKM_BUNDLE_DIR, "scripts/real.sh"), "echo hi\n")
      runReal(real, ["--format", "json", "-q", "index"])

      const run = (...args: string[]) => runRaw(process.execPath, [REAL_AKM, ...args], realAkmEnv(real))
      const asset = run("--format", "json", "-q", "show", "scripts/real.sh")
      expect(asset.exitCode).toBe(0)
      expect((JSON.parse(asset.stdout) as { ref?: unknown }).ref).toBe("scripts/real.sh")

      const file = run("--format", "json", "-q", "show", "scripts/health-report-template.html")
      expect(file.exitCode).toBe(0)
      const shown = JSON.parse(file.stdout) as Record<string, unknown>
      expect(shown.type).toBe("script")
      expect(shown.ref).toBeUndefined()
      expect(run("feedback", "scripts/health-report-template.html", "--positive", "--format", "json", "-q").exitCode).not.toBe(0)
    } finally {
      cleanup(real)
    }
  })

  // The same probe against the fake the tier-2 evals run the hook with: a ref it
  // resolves comes back as an envelope that names it, and one it cannot resolve
  // exits non-zero with nothing on stdout, exactly as real akm answers. A fake
  // that acked every show with no `ref` read as "not an asset" and silently
  // switched the hook's auto-feedback off (tier-2 claude_recall 1 -> 0).
  test.skipIf(!akmAvailable)("show envelope names the asset like real akm, and refuses an unknown ref with an empty stdout", () => {
    const real = makeRealEnv()
    const fake = makeFakeEnv([
      { ref: "knowledge/guide", type: "knowledge", name: "guide", description: "A guide", keywords: [] },
    ])
    try {
      mkdirSync(path.join(real.AKM_BUNDLE_DIR, "knowledge"), { recursive: true })
      writeFileSync(path.join(real.AKM_BUNDLE_DIR, "knowledge/guide.md"), "# Guide\n")
      runReal(real, ["--format", "json", "-q", "index"])

      const showArgs = (ref: string) => ["--format", "json", "-q", "show", ref]
      const resolves = (ref: string) => ({
        real: runRaw(process.execPath, [REAL_AKM, ...showArgs(ref)], realAkmEnv(real)),
        fake: runRaw(fake.akmPath, showArgs(ref)),
      })

      const known = resolves("knowledge/guide")
      for (const run of [known.real, known.fake]) {
        expect(run.exitCode).toBe(0)
        const shown = JSON.parse(run.stdout) as { type?: unknown; name?: unknown; ref?: unknown }
        expect([shown.type, shown.name, shown.ref]).toEqual(["knowledge", "guide", "knowledge/guide"])
      }

      const unknown = resolves("knowledge/missing")
      expect(unknown.real.exitCode).not.toBe(0)
      expect(unknown.fake.exitCode).toBe(unknown.real.exitCode)
      expect(unknown.real.stdout.trim()).toBe("")
      expect(unknown.fake.stdout.trim()).toBe("")
    } finally {
      cleanup(real)
      cleanup(fake)
    }
  })

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
      // A freshly-created bundle (like these temp fixtures, and like tier-2's
      // fixtures) has no LLM engine configured, so a direct `akm proposal
      // extract` deterministically fails — that failure IS the contract.
      //
      // Both plugins now capture and report this envelope rather than
      // discarding it (SessionEnd harvest was a silent no-op on every
      // un-configured install). Three properties are load-bearing for that
      // reporting path, so all three are pinned on BOTH sides rather than
      // just the key set: the stream the envelope arrives on, the exit code,
      // and the machine-readable `code`. A fake that emitted these keys on
      // stdout with exit 0 — which is what it did before — would let a
      // regression in the reporting path pass this test silently.
      const args = [
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
      ]
      const realRun = runRaw(process.execPath, [REAL_AKM, ...args], realAkmEnv(real))
      const fakeRun = runRaw(fake.akmPath, args)

      // 1. Envelope goes to stderr; stdout stays empty.
      expect(realRun.stdout.trim()).toBe("")
      expect(fakeRun.stdout.trim()).toBe("")

      // 2. Non-zero exit, and the fake matches it exactly (78 = akm's
      //    documented "config error" code).
      expect(realRun.exitCode).not.toBe(0)
      expect(fakeRun.exitCode).toBe(realRun.exitCode)

      // 3. Same envelope shape and same machine-readable failure code.
      const realEnvelope = JSON.parse(realRun.stderr) as Record<string, unknown>
      const fakeEnvelope = JSON.parse(fakeRun.stderr) as Record<string, unknown>
      expect(envelopeShape(fakeEnvelope)).toEqual(envelopeShape(realEnvelope))
      expect(realEnvelope.ok).toBe(false)
      expect(fakeEnvelope.ok).toBe(false)
      expect(fakeEnvelope.code).toBe(realEnvelope.code)
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
  const init = spawnSync(process.execPath, [REAL_AKM, "bundle", "create", "--dir", env.AKM_BUNDLE_DIR, "--set-default"], realAkmEnv(env))
  if (init.exitCode !== 0) {
    throw new Error(`akm bundle create failed: exit ${init.exitCode}\nstdout: ${init.stdout}\nstderr: ${init.stderr}`)
  }
  return env
}

function makeFakeEnv(assets: FakeAkmAsset[] = []) {
  const root = mkdtempSync(path.join(tmpdir(), "akm-contract-fake-"))
  const binDir = path.join(root, "bin")
  const callLog = path.join(root, "calls.log")
  const fake = installFakeAkm({ binDir, callLog, assets })
  return { ...fake, root }
}

function cleanup(env: { root: string }) {
  try {
    rmSync(env.root, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}
