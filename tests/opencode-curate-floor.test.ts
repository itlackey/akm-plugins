/**
 * #110 — the OpenCode side of the curate relevance floor and type filter.
 *
 * `AKM_CURATE_MIN_SCORE` and `AKM_CURATE_TYPE` are read into module-level
 * consts when `opencode/index.ts` is imported, so covering the env -> behaviour
 * wiring means importing that module afresh under a chosen environment.
 *
 * Doing that in-process is not safe here. `tests/opencode-plugin.test.ts`
 * registers `mock.module("node:child_process", ...)` at module scope, and
 * bun:test module mocks are process-global for an entire `bun test tests/`
 * run rather than scoped to the file that registered them — the same hazard
 * documented at the top of tests/fake-akm-contract.test.ts. A second in-process
 * importer of opencode/index.ts leaks into that file's fixtures (observed:
 * 27 unrelated failures).
 *
 * So each case runs in a SUBPROCESS, which shares no module registry with the
 * rest of the suite. The subprocess imports the plugin under the environment
 * for that case, calls the two seams through the module's existing
 * `__…ForTests` convention, and prints JSON for assertion here.
 */
import { describe, expect, test } from "bun:test"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "..")

/** Curate response shaped like `akm curate --format json`: mixed scores and types. */
const CURATE_JSON = JSON.stringify({
  items: [
    { ref: "lessons/a-lesson", type: "lesson", name: "a-lesson", score: 9 },
    { ref: "knowledge/wikis/articles/raw/youtube-abc", type: "website", name: "yt", score: 8 },
    { ref: "memories/a-memory", type: "memory", name: "a-memory", score: 3 },
    { ref: "docs//docs/en/best-practices", type: "website", name: "docs", score: 1 },
  ],
})

type Probe = { args: string[]; rendered: string | null }

/**
 * Import the plugin under `env` in a subprocess and exercise both seams.
 * Returns the built curate argv and the rendered curated block (or null).
 */
function probe(env: Record<string, string>): Probe {
  const script = `
    const { AkmPlugin } = await import(${JSON.stringify(path.join(repoRoot, "opencode/index.ts"))})
    const args = AkmPlugin.__buildCurateArgsForTests("some prompt text")
    const rendered = AkmPlugin.__renderCuratedJsonResponseForTests(${JSON.stringify(CURATE_JSON)}, "some prompt text")
    process.stdout.write(JSON.stringify({ args, rendered }))
  `
  const result = Bun.spawnSync(["bun", "-e", script], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = result.stdout.toString()
  if (result.exitCode !== 0 || !stdout) {
    throw new Error(`probe failed (exit ${result.exitCode}): ${result.stderr.toString().slice(0, 400)}`)
  }
  return JSON.parse(stdout) as Probe
}

describe("#110 opencode curate floor and type filter", () => {
  test("default (unset) sends the long-standing text argv and does not filter", () => {
    const { args } = probe({ AKM_CURATE_MIN_SCORE: "", AKM_CURATE_TYPE: "" })

    // The pre-#110 argv, unchanged: no --type, and text rather than json.
    expect(args).toContain("--format")
    expect(args[args.indexOf("--format") + 1]).toBe("text")
    expect(args).not.toContain("--type")
  })

  test("a floor switches the request to json, because scores are only needed then", () => {
    const { args } = probe({ AKM_CURATE_MIN_SCORE: "5" })

    expect(args[args.indexOf("--format") + 1]).toBe("json")
  })

  test("AKM_CURATE_TYPE is passed through to akm as --type", () => {
    const { args } = probe({ AKM_CURATE_TYPE: "lesson" })

    expect(args).toContain("--type")
    expect(args[args.indexOf("--type") + 1]).toBe("lesson")
  })

  test("the floor drops items scoring below it", () => {
    const { rendered } = probe({ AKM_CURATE_MIN_SCORE: "5" })

    expect(rendered).toBeTruthy()
    expect(rendered).toContain("lessons/a-lesson")       // score 9, kept
    expect(rendered).toContain("youtube-abc")            // score 8, kept
    expect(rendered).not.toContain("memories/a-memory")  // score 3, dropped
    expect(rendered).not.toContain("best-practices")     // score 1, dropped
  })

  test("nothing clearing the floor renders NO curated block at all", () => {
    // The point of the floor: a channel that speaks on every turn regardless of
    // relevance is one the reader learns to skip.
    const { rendered } = probe({ AKM_CURATE_MIN_SCORE: "50" })

    expect(rendered).toBeNull()
  })

  test("authored assets outrank scraped snapshots at equal-or-lower score", () => {
    const { rendered } = probe({ AKM_CURATE_MIN_SCORE: "1" })

    expect(rendered).toBeTruthy()
    // memory (score 3) must precede the higher-scoring website (score 8):
    // authored-type-first ranking is the whole point of the #110 change.
    const memoryAt = rendered!.indexOf("memories/a-memory")
    const websiteAt = rendered!.indexOf("youtube-abc")
    expect(memoryAt).toBeGreaterThanOrEqual(0)
    expect(websiteAt).toBeGreaterThanOrEqual(0)
    expect(memoryAt).toBeLessThan(websiteAt)
  })

  test("a malformed curate response renders nothing rather than throwing", () => {
    const script = `
      const { AkmPlugin } = await import(${JSON.stringify(path.join(repoRoot, "opencode/index.ts"))})
      const out = AkmPlugin.__renderCuratedJsonResponseForTests("{not json", "q")
      process.stdout.write(JSON.stringify({ rendered: out }))
    `
    const result = Bun.spawnSync(["bun", "-e", script], {
      cwd: repoRoot,
      env: { ...process.env, AKM_CURATE_MIN_SCORE: "5" },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout.toString()).rendered).toBeNull()
  })
})
