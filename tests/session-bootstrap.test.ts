import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { type FakeAkmAsset, installFakeAkm, readCallLog } from "../evals/lib/fake-akm"
import { type BootstrapRun, DUPLICATE_WINDOW_MS, RULES_LIST_LIMIT, USAGE_LIST_SIZE, claimBootstrap, loadSessionBootstrap } from "../claude/shared/session-bootstrap"
import { createSessionBootstrap } from "../opencode-shared/session-bootstrap"
import { hostEnv, installScriptedAkm, makeBinDir, runClaudeHandler, sandboxPath, itPosix, type ClaudeHandler } from "./host-runtime"

// The session bootstrap (#154): the project's rules and the assets used most in it, loaded at session
// start and after each compaction. The loader runs against the repo's fake akm, which models akm's
// project, rule and usage contract (akm#1512): `search --type rule`, `search --by-usage`, `show`
// recording a usage event unless AKM_EVENT_SOURCE says the read is not demand.

const repoRoot = path.resolve(import.meta.dir, "..")
const pluginDir = path.join(repoRoot, "claude")
const manifest = JSON.parse(readFileSync(path.join(pluginDir, ".claude-plugin/plugin.json"), "utf8"))

const tempDirs: string[] = []
function makeTempDir() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "akm-bootstrap-")))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

const rule = (name: string, bullets: string, project?: string): FakeAkmAsset => ({
  ref: `rules/${name}`,
  type: "rule",
  name,
  description: `${name} rules`,
  keywords: [],
  body: `---\ndescription: ${name} rules\n${project ? `project: ${project}\n` : ""}---\n${bullets}\n`,
  ...(project ? { project } : {}),
})
const asset = (type: string, name: string, description = `${name} description`): FakeAkmAsset => ({
  ref: `${type}s/${name}`,
  type,
  name,
  description,
  keywords: [],
})

type World = { root: string; acme: string; beta: string; elsewhere: string; binDir: string; callLog: string; akm: string; run: (cwd: string) => BootstrapRun; usageFile: string }

/** A fake akm with two projects (acme, beta) and a default bundle named "bundle". */
function makeWorld(options: { assets?: FakeAkmAsset[]; usage?: Array<{ ref: string; project?: string; source?: string }>; defaultBundle?: string | null } = {}): World {
  const root = makeTempDir()
  const acme = path.join(root, "work", "acme")
  const beta = path.join(root, "work", "beta")
  const elsewhere = path.join(root, "elsewhere")
  for (const dir of [acme, beta, elsewhere]) mkdirSync(dir, { recursive: true })
  const binDir = makeBinDir(root)
  const callLog = path.join(root, "calls", "akm.log")
  const assets = options.assets ?? [
    rule("shared", "- Use tabs"),
    rule("acme-only", "- Acme: no force pushes", "acme"),
    rule("beta-only", "- Beta: squash merges", "beta"),
    asset("skill", "deploy"),
    asset("skill", "review"),
    asset("knowledge", "runbook"),
  ]
  const usage = options.usage ?? [
    { ref: "skills/deploy", project: "acme" },
    { ref: "skills/deploy", project: "acme" },
    { ref: "skills/review", project: "acme" },
    { ref: "knowledge/runbook", project: "beta" },
    { ref: "knowledge/runbook", project: "beta" },
    { ref: "skills/review", project: "beta" },
    { ref: "skills/review" },
    { ref: "skills/review" },
    { ref: "skills/review" },
  ]
  const fake = installFakeAkm({
    binDir,
    callLog,
    assets,
    usage,
    projects: { acme: { paths: [acme] }, beta: { paths: [beta] } },
  })
  mkdirSync(path.dirname(callLog), { recursive: true })
  if (options.defaultBundle !== null) writeFileSync(path.join(path.dirname(callLog), "akm-config-store.json"), JSON.stringify({ defaultBundle: options.defaultBundle ?? "bundle" }))
  const run = (cwd: string): BootstrapRun => async (args, env) => {
    const child = Bun.spawn([fake.akmPath, ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
    const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    return (await child.exited) === 0 ? stdout : ""
  }
  return { root, acme, beta, elsewhere, binDir, callLog, akm: fake.akmPath, run, usageFile: path.join(path.dirname(callLog), "akm-usage-events.json") }
}

const calls = (world: World) => readCallLog(world.callLog).map((call) => call.argv)
const BIG = 100_000

describe("loadSessionBootstrap", () => {
  it("gives the project's rules in full under their refs, then its most used assets, refs and descriptions only", async () => {
    const world = makeWorld()
    const text = await loadSessionBootstrap(world.run(world.acme), { budgetChars: BIG })
    expect(text).toContain("# AKM rules for this session")
    expect(text).toContain("## rules/shared\n- Use tabs")
    expect(text).toContain("## rules/acme-only\n- Acme: no force pushes")
    expect(text).not.toContain("beta-only")
    expect(text).not.toContain("description:") // frontmatter is not rule text
    // Rule text first, then the list; most used first; a line is the ref and its description.
    expect(text.indexOf("## rules/acme-only")).toBeLessThan(text.indexOf("# AKM assets used most here"))
    expect(text).toContain("- skills/deploy — deploy description\n- skills/review — review description")
    expect(text).not.toContain("knowledge/runbook") // beta's, never leaked into acme's list
    // No counts or ranking evidence reach the agent.
    expect(text).not.toMatch(/\b\d+ (times|shows|events)\b|count|score/i)
  })

  it("the directory-selected project and an explicit override select the same rules and usage", async () => {
    const world = makeWorld()
    const byDirectory = await loadSessionBootstrap(world.run(world.acme), { budgetChars: BIG })
    const byOverride = await loadSessionBootstrap(world.run(world.elsewhere), { project: "acme", budgetChars: BIG })
    expect(byOverride).toBe(byDirectory)
    // The override is passed to akm as `--project`, on the reads too.
    const argv = calls(world)
    expect(argv.some((a) => a[0] === "search" && a.includes("--by-usage") && a.join(" ").endsWith("--project acme"))).toBe(true)
    expect(argv.some((a) => a[0] === "show" && a.includes("--project") && a.includes("acme"))).toBe(true)
  })

  it("two projects with different usage get different lists and their own rules", async () => {
    const world = makeWorld()
    const acme = await loadSessionBootstrap(world.run(world.acme), { budgetChars: BIG })
    const beta = await loadSessionBootstrap(world.run(world.beta), { budgetChars: BIG })
    expect(acme).not.toBe(beta)
    expect(beta).toContain("rules/beta-only")
    expect(beta).not.toContain("rules/acme-only")
    expect(beta.indexOf("knowledge/runbook")).toBeLessThan(beta.indexOf("skills/review"))
    expect(beta).not.toContain("skills/deploy")
  })

  it("with no project, reads only the default bundle, with no selection filters or preferences", async () => {
    const world = makeWorld()
    const text = await loadSessionBootstrap(world.run(world.elsewhere), { budgetChars: BIG })
    expect(text).toContain("rules/shared")
    expect(text).not.toContain("acme-only")
    expect(text).not.toContain("beta-only")
    // Every show counts without a project, so review (5) leads deploy (2) and runbook (2).
    expect(text.indexOf("skills/review")).toBeLessThan(text.indexOf("skills/deploy"))
    const fallbacks = calls(world).filter((a) => a[0] === "search" && a.includes("--project") && a.includes("none"))
    expect(fallbacks).toHaveLength(2) // the rules listing and the usage list
    for (const argv of fallbacks) {
      expect(argv.join(" ")).toContain("--project none --from bundle")
      expect(argv).not.toContain("--filter")
      expect(argv).not.toContain("--prefer")
    }
    expect(calls(world).some((a) => a[0] === "config" && a.includes("defaultBundle"))).toBe(true)
  })

  it("with no project and no default bundle configured, passes `--project none` and no `--from`", async () => {
    const world = makeWorld({ defaultBundle: null })
    const text = await loadSessionBootstrap(world.run(world.elsewhere), { budgetChars: BIG })
    expect(text).toContain("rules/shared")
    const fallbacks = calls(world).filter((a) => a[0] === "search" && a.includes("none"))
    expect(fallbacks).toHaveLength(2)
    for (const argv of fallbacks) expect(argv).not.toContain("--from")
  })

  it("a project with rules and no usage history still gets its rules, and no list that implies a history", async () => {
    const world = makeWorld({ usage: [] })
    const text = await loadSessionBootstrap(world.run(world.acme), { budgetChars: BIG })
    expect(text).toContain("## rules/acme-only")
    expect(text).not.toContain("used most")
  })

  it("a project with usage and no rules gets the list alone", async () => {
    const world = makeWorld({ assets: [asset("skill", "deploy")], usage: [{ ref: "skills/deploy", project: "acme" }] })
    const text = await loadSessionBootstrap(world.run(world.acme), { budgetChars: BIG })
    expect(text).not.toContain("# AKM rules")
    expect(text).toContain("- skills/deploy — deploy description")
  })

  it("has nothing to say with no rules and no history", async () => {
    const world = makeWorld({ assets: [asset("skill", "deploy")], usage: [] })
    expect(await loadSessionBootstrap(world.run(world.acme), { budgetChars: BIG })).toBe("")
  })

  it("reading the rules and the list does not count as demand", async () => {
    const world = makeWorld()
    await loadSessionBootstrap(world.run(world.acme), { budgetChars: BIG })
    await loadSessionBootstrap(world.run(world.acme), { budgetChars: BIG })
    // The `show`s ran (the rule bodies) and recorded nothing.
    expect(calls(world).filter((a) => a[0] === "show").length).toBeGreaterThan(0)
    expect(existsSync(world.usageFile)).toBe(false)
    // A user's own show does count, so the fake would have caught a missing AKM_EVENT_SOURCE.
    Bun.spawnSync([world.akm, "show", "skills/review", "--format", "json"], { cwd: world.acme })
    expect(existsSync(world.usageFile)).toBe(true)
  })

  it("leaves out whole rules that do not fit and says how many, never clipping one", async () => {
    const rules = Array.from({ length: 6 }, (_, n) => rule(`r${n}`, `- ${"x".repeat(100)} rule ${n}`))
    const world = makeWorld({ assets: rules, usage: [] })
    const text = await loadSessionBootstrap(world.run(world.acme), { budgetChars: 700 })
    const shown = [...text.matchAll(/^## rules\/r(\d)\n- x{100} rule \1$/gm)]
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThan(6)
    expect(text).toContain(`Not every rule is shown: ${6 - shown.length} of 6 left out`)
    expect(text).toContain('akm search "" --type rule')
    expect(text.length).toBeLessThanOrEqual(700)
  })

  it("a full rule list is not annotated, and one cut at akm's limit says so", async () => {
    const few = makeWorld({ assets: [rule("a", "- one"), rule("b", "- two")], usage: [] })
    expect(await loadSessionBootstrap(few.run(few.acme), { budgetChars: BIG })).not.toContain("Not every rule")

    const many = makeWorld({ assets: Array.from({ length: RULES_LIST_LIMIT + 5 }, (_, n) => rule(`r${String(n).padStart(3, "0")}`, "- x")), usage: [] })
    const text = await loadSessionBootstrap(many.run(many.acme), { budgetChars: BIG })
    expect(text).toContain(`akm listed no more than ${RULES_LIST_LIMIT}`)
  })

  it("puts rule text before the list and cuts the list to what is left, saying so", async () => {
    const usage = Array.from({ length: 6 }, (_, n) => ({ ref: `skills/s${n}`, project: "acme" }))
    const world = makeWorld({ assets: [rule("a", "- keep"), ...usage.map((u, n) => asset("skill", `s${n}`, "d".repeat(80)))], usage })
    const text = await loadSessionBootstrap(world.run(world.acme), { budgetChars: 500 })
    expect(text).toContain("## rules/a\n- keep")
    expect(text).toContain("(The list was cut to fit the context budget.)")
    expect(text.length).toBeLessThanOrEqual(500)
  })

  it("lists at most USAGE_LIST_SIZE assets", async () => {
    const usage = Array.from({ length: USAGE_LIST_SIZE + 4 }, (_, n) => ({ ref: `skills/s${String(n).padStart(2, "0")}`, project: "acme" }))
    const world = makeWorld({ assets: usage.map((u, n) => asset("skill", `s${String(n).padStart(2, "0")}`)), usage })
    const text = await loadSessionBootstrap(world.run(world.acme), { budgetChars: BIG })
    expect(text.split("\n").filter((line) => line.startsWith("- skills/"))).toHaveLength(USAGE_LIST_SIZE)
  })

  it("returns nothing, and does not throw, when akm fails or has no room", async () => {
    expect(await loadSessionBootstrap(async () => "", { budgetChars: BIG })).toBe("")
    expect(await loadSessionBootstrap(async () => "not json", { budgetChars: BIG })).toBe("")
    expect(await loadSessionBootstrap(async () => { throw new Error("spawn failed") }, { budgetChars: BIG })).toBe("")
    const world = makeWorld()
    expect(await loadSessionBootstrap(world.run(world.acme), { budgetChars: 0 })).toBe("")
  })

  it("keeps the other half when one lookup fails", async () => {
    const world = makeWorld()
    const real = world.run(world.acme)
    const noList: BootstrapRun = async (args, env) => (args.includes("--by-usage") ? "" : real(args, env))
    const text = await loadSessionBootstrap(noList, { budgetChars: BIG })
    expect(text).toContain("## rules/acme-only")
    expect(text).not.toContain("used most")
  })
})

describe("claimBootstrap", () => {
  it("lets one callback per event through, and a later event of the same kind once the window has passed", () => {
    const seen: Record<string, number> = {}
    expect(claimBootstrap(seen, "s1:compact", 1_000)).toBe(true)
    expect(claimBootstrap(seen, "s1:compact", 1_000 + DUPLICATE_WINDOW_MS - 1)).toBe(false)
    expect(claimBootstrap(seen, "s1:start", 1_005)).toBe(true) // another kind
    expect(claimBootstrap(seen, "s2:compact", 1_005)).toBe(true) // another session
    expect(claimBootstrap(seen, "s1:compact", 1_000 + DUPLICATE_WINDOW_MS + 1)).toBe(true)
  })
})

describe("createSessionBootstrap (OpenCode)", () => {
  function holder() {
    const loads: string[] = []
    let next = "rules v1"
    let release: (() => void) | undefined
    let gate: Promise<void> | undefined
    const bootstrap = createSessionBootstrap(async (sessionID) => {
      loads.push(sessionID)
      if (gate) await gate
      return next
    })
    return {
      bootstrap,
      loads,
      setNext: (text: string) => void (next = text),
      hold: () => void (gate = new Promise<void>((resolve) => (release = resolve))),
      release: () => release?.(),
    }
  }

  it("loads once when a session starts, however often it is asked and however many callbacks arrive", async () => {
    const h = holder()
    await Promise.all([h.bootstrap.ensure("s1"), h.bootstrap.ensure("s1")])
    await h.bootstrap.ensure("s1") // every later request
    expect(h.loads).toEqual(["s1"])
    expect(await h.bootstrap.text("s1")).toBe("rules v1")
  })

  it("reloads after a compaction, once per event, and the next request waits for it", async () => {
    const h = holder()
    await h.bootstrap.ensure("s1")
    h.setNext("rules v2")
    h.hold()
    const compacted = h.bootstrap.compacted("s1")
    const duplicate = h.bootstrap.compacted("s1") // the duplicate callback shares the load
    const pending = h.bootstrap.text("s1")
    h.release()
    await Promise.all([compacted, duplicate])
    expect(await pending).toBe("rules v2")
    expect(h.loads).toEqual(["s1", "s1"])
  })

  it("keeps what a session holds when a reload finds nothing, and forgets a session on clear", async () => {
    const h = holder()
    await h.bootstrap.ensure("s1")
    h.setNext("")
    await h.bootstrap.compacted("s1") // a failed or empty lookup
    expect(await h.bootstrap.text("s1")).toBe("rules v1")
    h.bootstrap.clear("s1")
    expect(await h.bootstrap.text("s1")).toBe("")
  })

  it("a session the plugin first sees later (a resumed one) is loaded on first use", async () => {
    const h = holder()
    expect(await h.bootstrap.text("resumed")).toBe("") // nothing is loaded by merely asking
    await h.bootstrap.ensure("resumed")
    expect(await h.bootstrap.text("resumed")).toBe("rules v1")
  })
})

// --- the Claude Code / Codex hook -----------------------------------------------------------------

describe("session-start hook", () => {
  const handler = manifest.hooks.SessionStart[0].hooks[0] as ClaudeHandler
  const SESSION = "bootstrap-session-1"

  function startHook(world: World, input: Record<string, unknown>, env: Record<string, string> = {}) {
    const stateHome = path.join(world.root, "xdg-state")
    const home = path.join(world.root, "home")
    mkdirSync(home, { recursive: true })
    const inputPath = path.join(world.root, `stdin-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(inputPath, JSON.stringify({ session_id: SESSION, cwd: world.acme, ...input }))
    const result = runClaudeHandler(handler, {
      pluginRoot: pluginDir,
      cwd: world.acme,
      env: hostEnv({ HOME: home, XDG_STATE_HOME: stateHome, PATH: sandboxPath(world.binDir), AKM_AUTO_LEARNING: "0", ...env }, (name) => /^(AKM_|XDG_|CLAUDE_PLUGIN_|PLUGIN_)/.test(name)),
      stdin: Bun.file(inputPath),
    })
    expect(result.exitCode).toBe(0)
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string
    return { context, stateDir: path.join(stateHome, "akm-claude") }
  }
  const bootstrapCalls = (world: World) => calls(world).filter((a) => a[0] === "search" && a.includes("--by-usage")).length

  itPosix("a fresh session starts with the rules and the most used list in its context, ahead of the closing note", () => {
    const world = makeWorld()
    const { context } = startHook(world, { source: "startup" })
    expect(context).toContain("## rules/acme-only\n- Acme: no force pushes")
    expect(context).toContain("- skills/deploy — deploy description")
    expect(context.indexOf("# AKM rules for this session")).toBeLessThan(context.indexOf("# AKM assets used most here"))
    expect(context.indexOf("# AKM assets used most here")).toBeLessThan(context.indexOf("The public plugin surface"))
  })

  itPosix("a missing source is a start, and AKM_AUTO_CURATE=0 does not switch the bootstrap off", () => {
    const world = makeWorld()
    const { context } = startHook(world, {}, { AKM_AUTO_CURATE: "0" })
    expect(context).toContain("## rules/acme-only")
    expect(calls(world).some((a) => a[0] === "curate")).toBe(false)
  })

  itPosix("a compaction reloads both into the new context, each time", () => {
    const world = makeWorld()
    const first = startHook(world, { source: "startup" })
    const second = startHook(world, { source: "compact" })
    expect(second.context).toContain("## rules/acme-only")
    expect(second.context).toContain("# AKM assets used most here")
    expect(bootstrapCalls(world)).toBe(2)
    // A later compaction of the same session is a new event once the duplicate window has passed.
    const marker = path.join(first.stateDir, "bootstrap", `${SESSION}.compact`)
    const aged = new Date(Date.now() - 2 * DUPLICATE_WINDOW_MS)
    utimesSync(marker, aged, aged)
    const third = startHook(world, { source: "compact" })
    expect(third.context).toContain("## rules/acme-only")
    expect(bootstrapCalls(world)).toBe(3)
  })

  itPosix("a duplicate callback for the same start or compaction adds nothing", () => {
    const world = makeWorld()
    startHook(world, { source: "startup" })
    const duplicate = startHook(world, { source: "startup" })
    expect(duplicate.context).not.toContain("# AKM rules")
    expect(duplicate.context).not.toContain("used most")
    startHook(world, { source: "compact" })
    expect(startHook(world, { source: "compact" }).context).not.toContain("# AKM rules")
    expect(bootstrapCalls(world)).toBe(2)
  })

  itPosix("a fork carries the transcript, so it does not reload either", () => {
    const world = makeWorld()
    expect(startHook(world, { source: "fork" }).context).not.toContain("# AKM rules")
    expect(bootstrapCalls(world)).toBe(0)
  })

  itPosix("with many rules the context stays whole: no clipped note, no dangling provenance banner", () => {
    const rules = Array.from({ length: 8 }, (_, n) => rule(`r${n}`, `- ${"y".repeat(400)}`))
    const usage = Array.from({ length: 10 }, (_, n) => ({ ref: `skills/s${n}`, project: "acme" }))
    const world = makeWorld({ assets: [...rules, ...usage.map((u, n) => asset("skill", `s${n}`, "d".repeat(100)))], usage })
    writeFileSync(path.join(world.acme, "package.json"), JSON.stringify({ name: "acme-app", description: "acme app" }))
    const { context } = startHook(world, { source: "startup" })
    expect(context).not.toContain("[truncated for context]")
    expect(context.length).toBeLessThanOrEqual(4000)
    // Rules keep priority; the curation is whole (banner, a hit, tip) or absent.
    expect(context).toContain("## rules/r0")
    expect(context.split("<!-- AKM PROVENANCE").length).toBe(context.split("Tip: call `akm show <ref>`").length)
    expect(context).toContain("The public plugin surface")
  })

  itPosix("a resume without compaction does not reload", () => {
    const world = makeWorld()
    const { context } = startHook(world, { source: "resume" })
    expect(context).not.toContain("# AKM rules")
    expect(bootstrapCalls(world)).toBe(0)
  })

  itPosix("prompt-time curate neither reloads the bootstrap nor repeats the rules akm leads curate with", () => {
    const world = makeWorld()
    startHook(world, { source: "startup" })
    const before = bootstrapCalls(world)
    const prompt = "help me deploy the acme review runbook before the release cut this afternoon"
    const inputPath = path.join(world.root, "prompt.json")
    writeFileSync(inputPath, JSON.stringify({ session_id: SESSION, cwd: world.acme, prompt }))
    const promptHandler = manifest.hooks.UserPromptSubmit[0].hooks[0] as ClaudeHandler
    const result = runClaudeHandler(promptHandler, {
      pluginRoot: pluginDir,
      cwd: world.acme,
      env: hostEnv({ HOME: path.join(world.root, "home"), XDG_STATE_HOME: path.join(world.root, "xdg-state"), PATH: sandboxPath(world.binDir), AKM_AUTO_LEARNING: "0" }, (name) => /^(AKM_|XDG_|CLAUDE_PLUGIN_|PLUGIN_)/.test(name)),
      stdin: Bun.file(inputPath),
    })
    expect(result.exitCode).toBe(0)
    expect(bootstrapCalls(world)).toBe(before)
    const curate = calls(world).find((a) => a[0] === "curate" && a[1] === prompt)
    expect(curate).toBeDefined()
    // Asked for a page twice the limit (default 5), because rules lead the page in akm.
    expect(curate?.join(" ")).toContain("--limit 10")
    const injected = result.stdout ? (JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string) : ""
    expect(injected).not.toContain("rules/")
    for (const ref of ["skills/deploy", "skills/review"]) expect(injected).toContain(ref)
  })

  itPosix("a failing akm leaves the session usable: the primer still arrives", () => {
    const world = makeWorld()
    installScriptedAkm(
      world.binDir,
      `if (args[0] === "--version") { console.log("akm 0.10.26101002"); process.exit(0) }
if (args[0] === "search" || args[0] === "show" || args[0] === "config") { process.stderr.write(JSON.stringify({ ok: false, error: "boom" })); process.exit(1) }
process.exit(0)`,
    )
    const { context, stateDir } = startHook(world, { source: "startup" })
    expect(context).toContain("# AKM is available in this session")
    expect(context).not.toContain("# AKM rules")
    expect(readFileSync(path.join(stateDir, "session.log"), "utf8")).toContain("akm_failed")
    expect(readdirSync(path.join(stateDir, "bootstrap")).length).toBe(1)
  })
})

describe("loadSessionBootstrap: failures, sources and time", () => {
  it("a failed listing in a project is not read as 'no project': nothing is loaded rather than the default bundle's", async () => {
    const world = makeWorld()
    const real = world.run(world.acme)
    // The project listings fail (a locked database); the later `--project none` calls would work.
    const flaky: BootstrapRun = async (args, env) => (args[0] === "search" && !args.includes("none") ? "" : real(args, env))
    expect(await loadSessionBootstrap(flaky, { budgetChars: BIG })).toBe("")
    expect(calls(world).some((a) => a.includes("none"))).toBe(false)
  })

  it("an explicit override akm rejects takes the same path", async () => {
    const world = makeWorld()
    const real = world.run(world.elsewhere)
    const rejecting: BootstrapRun = async (args, env) => (args.includes("bogus") ? "" : real(args, env))
    expect(await loadSessionBootstrap(rejecting, { project: "bogus", budgetChars: BIG })).toBe("")
    expect(calls(world).some((a) => a.includes("none"))).toBe(false)
  })

  it("with no project, assets of other bundles are not read, only the default bundle's", async () => {
    const other = (a: FakeAkmAsset): FakeAkmAsset => ({ ...a, bundle: "other" })
    const world = makeWorld({
      assets: [rule("shared", "- Use tabs"), { ...rule("elsewhere", "- Other bundle rule"), bundle: "other" }, asset("skill", "mine"), other(asset("skill", "theirs"))],
      usage: [{ ref: "skills/mine" }, { ref: "skills/theirs" }, { ref: "skills/theirs" }],
    })
    const text = await loadSessionBootstrap(world.run(world.elsewhere), { budgetChars: BIG })
    expect(text).toContain("rules/shared")
    expect(text).toContain("skills/mine")
    expect(text).not.toContain("elsewhere")
    expect(text).not.toContain("skills/theirs")
  })

  it("stops after a batch in which no rule can be read, instead of trying all of them", async () => {
    const world = makeWorld({ assets: Array.from({ length: 200 }, (_, n) => rule(`r${String(n).padStart(3, "0")}`, "- x")), usage: [] })
    const real = world.run(world.acme)
    const noShow: BootstrapRun = async (args, env) => (args[0] === "show" ? "" : real(args, env))
    const text = await loadSessionBootstrap(noShow, { budgetChars: BIG })
    expect(calls(world).filter((a) => a[0] === "show").length).toBeLessThanOrEqual(8)
    expect(text).toContain("200 of the first 200 left out")
  })

  it("reads no more rules once its deadline has passed", async () => {
    const world = makeWorld()
    const text = await loadSessionBootstrap(world.run(world.acme), { budgetChars: BIG, deadlineMs: 0 })
    expect(calls(world).filter((a) => a[0] === "show")).toHaveLength(0)
    expect(text).toContain("Not every rule is shown")
  })

  it("says when the list was left out because no line fit", async () => {
    const world = makeWorld({ assets: [rule("a", "- keep"), asset("skill", "deploy", "d".repeat(160))], usage: [{ ref: "skills/deploy", project: "acme" }] })
    const tight = await loadSessionBootstrap(world.run(world.acme), { budgetChars: 340 })
    expect(tight).toContain("## rules/a")
    expect(tight).toContain("The list of most-used assets was left out")
  })

  it("lists rules with the command that returns all of them", async () => {
    const world = makeWorld({ assets: Array.from({ length: 4 }, (_, n) => rule(`r${n}`, `- ${"x".repeat(200)}`)), usage: [] })
    const text = await loadSessionBootstrap(world.run(world.acme), { budgetChars: 500 })
    expect(text).toContain('akm search "" --type rule --limit 200')
  })
})

describe("createSessionBootstrap: a slow akm does not hold a request back", () => {
  it("returns what is held once the wait has passed, and the load finishes for the next request", async () => {
    let finish!: (text: string) => void
    const bootstrap = createSessionBootstrap(() => new Promise<string>((resolve) => (finish = resolve)), 30)
    void bootstrap.ensure("s1")
    const started = Date.now()
    expect(await bootstrap.text("s1")).toBe("")
    expect(Date.now() - started).toBeLessThan(500)
    finish("late rules")
    await Bun.sleep(10)
    expect(await bootstrap.text("s1")).toBe("late rules")
  })
})
