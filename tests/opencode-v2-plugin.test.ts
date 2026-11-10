import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { type FakeAkmConfig, installFakeAkm, readCallLog } from "../evals/lib/fake-akm"
import { makeBinDir, installScriptedAkm } from "./host-runtime"
import { type CurateFn, setCurateForTests } from "../opencode-shared/akm-api"
import { resetWriteGateForTests } from "../opencode-shared/write-gate"
import { LEARNING_OFF, makeConfigDir } from "./host-runtime"
import { startPlugin, type HostFake } from "../opencode-v2/testing"

// Drives the real `akm-opencode-v2` entrypoint (`Plugin.define`, effect API of
// @opencode/plugin 2.1.4) against a fake OpenCode context and the repo's fake
// `akm` executable (evals/lib/fake-akm.ts). The shared helpers spawn real child
// processes: tests/opencode-plugin.test.ts mocks node:child_process for the whole
// run but delegates to the real functions outside its own tests.

const root = mkdtempSync(path.join(tmpdir(), "akm-opencode-v2-test-"))
const project = path.join(root, "project")
mkdirSync(project, { recursive: true })
writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "fixture-project", description: "nginx reverse proxy deployment" }))

const assets = [
  { ref: "skills/nginx-proxy", type: "skill", name: "nginx-proxy", description: "Configure an nginx reverse proxy for deployment", keywords: ["nginx", "reverse", "proxy", "deployment", "config"] },
  { ref: "knowledge/inkwell", type: "knowledge", name: "inkwell", description: "The inkwell service manifest format", keywords: ["inkwell"] },
  { ref: "knowledge/deploy-notes", type: "knowledge", name: "deploy-notes", description: "Deployment notes", keywords: ["deployment", "notes"] },
]

let counter = 0
function freshFakeAkm(extra: Partial<FakeAkmConfig> = {}) {
  const dir = path.join(root, `fake-${++counter}`)
  const fake = installFakeAkm({ binDir: dir, callLog: path.join(dir, "calls.log"), assets, ...extra })
  return { ...fake, calls: () => readCallLog(fake.callLog).map((call) => call.argv) }
}

const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))
const PROMPT = "How do I configure the nginx reverse proxy for the deployment of this service?"

// Automatic recall is in-process (`akm-cli/api`). This fake honours that contract:
// it resolves to the text `akm curate` prints, and rejects with an Error carrying
// the CLI's error code. Every call is recorded.
const curateCalls: Array<{ query: string; options: Parameters<CurateFn>[1] }> = []
const defaultCurate: CurateFn = async (query) => {
  const words = query.toLowerCase().split(/\W+/)
  const hit = assets.filter((a) => a.keywords.some((k) => words.includes(k)))
  return hit.length === 0 ? "" : ["# AKM curated", ...hit.map((a) => `- ${a.ref} (${a.type}): ${a.description}`)].join("\n")
}

let curateImpl: CurateFn = defaultCurate
let host: HostFake | undefined
let fake: ReturnType<typeof freshFakeAkm>
const ENV_KEYS = ["AKM_OPENCODE_CLI", "AKM_CONFIG_DIR", "AKM_BUNDLE_DIR", "XDG_STATE_HOME"]
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  curateCalls.length = 0
  curateImpl = defaultCurate
  setCurateForTests((query, options) => {
    curateCalls.push({ query, options })
    return curateImpl(query, options)
  })
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  process.env.XDG_STATE_HOME = path.join(root, `state-${++counter}`)
  resetWriteGateForTests()
  fake = freshFakeAkm()
  process.env.AKM_OPENCODE_CLI = fake.akmPath
})

/** Make `config` the akm config.json the plugin reads when it starts (restored after the test). */
function useConfig(config: Record<string, unknown>) {
  process.env.AKM_CONFIG_DIR = makeConfigDir(config)
}

afterEach(async () => {
  setCurateForTests(undefined)
  await host?.unload()
  host = undefined
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("akm-opencode-v2 plugin", () => {
  it("is a Plugin.define entrypoint with a stable id", async () => {
    const mod = await import("../opencode-v2/index")
    expect(Object.keys(mod)).toEqual(["default"])
    expect((mod.default as { id: string }).id).toBe("akm-opencode-v2")
    expect(typeof (mod.default as { effect: unknown }).effect).toBe("function")
  })

  it("registers the five tools with schemas", async () => {
    host = await startPlugin(project)
    expect([...host.tools.keys()].sort()).toEqual(["akm_curate", "akm_feedback", "akm_remember", "akm_search", "akm_show"])
    for (const tool of host.tools.values()) {
      expect(tool.description.length).toBeGreaterThan(40)
      expect(tool.input.type).toBe("object")
      expect(tool.input.additionalProperties).toBe(false)
    }
    // Offered as ordinary tool calls, not hidden behind the V2 `execute` (codemode) script tool.
    for (const tool of host.tools.values()) expect(tool.options).toEqual({ codemode: false })
    expect(host.tools.get("akm_curate").input.required).toEqual(["query"])
    expect(host.tools.get("akm_show").input.required).toEqual(["ref"])
    expect(host.tools.get("akm_feedback").input.required).toEqual(["ref", "sentiment"])
    expect(host.tools.get("akm_search").input.properties.type.enum).toContain("skill")
    // Both plugins describe the tools from the one shared spec.
    const { TOOL_SPECS } = await import("../opencode-shared/tools")
    expect(host.tools.get("akm_feedback").description).toBe(TOOL_SPECS.akm_feedback.description)
  })

  it("executes search, show and curate through the public CLI as JSON", async () => {
    host = await startPlugin(project)
    const search = await host.callTool("akm_search", { query: "nginx", type: "any", limit: 3, include_proposed: true })
    expect(search.metadata?.ok).toBe(true)
    expect(JSON.parse(search.content).results[0].ref).toBe("skills/nginx-proxy")
    const show = await host.callTool("akm_show", { ref: "skills/nginx-proxy", detail: "full" })
    expect(JSON.parse(show.content).ref).toBe("skills/nginx-proxy")
    const curate = await host.callTool("akm_curate", { query: "configure nginx proxy", limit: 2 })
    expect(JSON.parse(curate.content).results[0].ref).toBe("skills/nginx-proxy")

    const argv = fake.calls()
    const searchArgv = argv.find((a) => a[0] === "search")!
    expect(searchArgv).toEqual(expect.arrayContaining(["search", "nginx", "--limit", "3", "--include-proposed", "--detail", "full", "--format", "json"]))
    expect(searchArgv).not.toContain("--type") // "any" is a sentinel, never sent
    expect(argv.find((a) => a[0] === "show")).toEqual(["show", "skills/nginx-proxy", "--detail", "full", "--format", "json"])
    expect(argv.find((a) => a[0] === "curate" && a.includes("--limit") && a.includes("2"))).toBeTruthy()
  })

  it("executes remember and feedback, refusing an unpaired fix without starting akm", async () => {
    host = await startPlugin(project)
    expect(JSON.parse((await host.callTool("akm_remember", { content: "use port 8443", name: "port-note" })).content).ok).toBe(true)
    expect(JSON.parse((await host.callTool("akm_feedback", { ref: "skills/nginx-proxy", sentiment: "positive" })).content).ok).toBe(true)
    const argv = fake.calls()
    expect(argv.find((a) => a[0] === "remember")).toEqual(["remember", "use port 8443", "--name", "port-note", "--format", "json"])
    expect(argv.find((a) => a[0] === "feedback")).toEqual(expect.arrayContaining(["feedback", "skills/nginx-proxy", "--positive"]))

    const before = fake.calls().length
    const refused = await host.callTool("akm_feedback", { ref: "skills/x", sentiment: "negative", replace: ["a"], with: [] })
    expect(JSON.parse(refused.content)).toEqual({ ok: false, error: "Each replace needs one with (got 1 replace and 0 with)." })
    expect(fake.calls().length).toBe(before)
  })

  it("injects recall into the next request: curated block with provenance, standing rules, deduped", async () => {
    host = await startPlugin(project)
    await host.runPrompt("ses_a", PROMPT)
    const system = await host.runContext("ses_a", [{ type: "text", text: "You are an agent." }])
    expect(system).toHaveLength(1) // merged into the host's last part, not a second system entry
    const text = system[0].text
    expect(text.startsWith("You are an agent.")).toBe(true)
    expect(text).toContain("AKM PROVENANCE")
    expect(text).toContain("skills/nginx-proxy")
    expect(text).toContain("AKM is available in this session")
    // The curated block precedes the standing rules, so the budget never starves it.
    expect(text.indexOf("AKM PROVENANCE")).toBeLessThan(text.indexOf("AKM is available in this session"))

    // The same prompt again does not run akm curate again.
    const curates = () => curateCalls.length
    const once = curates()
    await host.runPrompt("ses_a", PROMPT)
    expect(curates()).toBe(once)
    // A different session recalls independently.
    await host.runPrompt("ses_b", PROMPT)
    expect(curates()).toBe(once + 1)
    const other = await host.runContext("ses_c", [])
    expect(other).toHaveLength(1)
    expect(other[0].text).not.toContain("AKM PROVENANCE") // nothing recalled for ses_c: rules only
  })

  it("does not curate a prompt that is not a task", async () => {
    host = await startPlugin(project)
    await host.runPrompt("ses_off", "thanks")
    expect(curateCalls).toHaveLength(0)
  })

  it("asks curate for plugins.curateLimit results", async () => {
    useConfig({ plugins: { curateLimit: 9 } })
    host = await startPlugin(project)
    await host.runPrompt("ses_limit", PROMPT)
    expect(curateCalls[0].options).toEqual({ limit: 9, format: "text", cwd: project })
  })

  it("a wrong plugins value keeps its default and a retired AKM_* variable is ignored, each said once in the host's log", async () => {
    useConfig({ plugins: { curateLimit: 99 } })
    process.env.AKM_CURATE_TIMEOUT = "30"
    try {
      host = await startPlugin(project)
      await settle(100)
      const warnings = host.logs.filter((line) => line.message.startsWith("AKM plugin settings:")).map((line) => line.message)
      expect(warnings.filter((m) => m.includes("plugins.curateLimit must be a whole number from 1 to 25"))).toHaveLength(1)
      expect(warnings.filter((m) => m.includes("AKM_CURATE_TIMEOUT is retired"))).toHaveLength(1)
      await host.runPrompt("ses_default_limit", PROMPT)
      expect(curateCalls[0].options).toEqual({ limit: 5, format: "text", cwd: project })
    } finally {
      delete process.env.AKM_CURATE_TIMEOUT
    }
  })

  it("session start curates for the project, lists active workflows, never runs hints, and cleans up on delete", async () => {
    host = await startPlugin(project)
    await host.subscribed
    await host.emit({ type: "session.created", data: { sessionID: "ses_s", location: { directory: project } }, location: { directory: project } })
    await settle(400)
    const argv = fake.calls()
    expect(argv.some((a) => a.includes("workflow"))).toBe(true)
    expect(argv.some((a) => a.includes("hints"))).toBe(false)
    expect(curateCalls.some((c) => c.query.includes("fixture-project"))).toBe(true)
    const withState = await host.runContext("ses_s", [])
    expect(withState[0].text).toContain("AKM PROVENANCE")

    await host.emit({ type: "session.deleted", data: { sessionID: "ses_s" }, location: { directory: project } })
    await settle()
    const afterDelete = await host.runContext("ses_s", [])
    expect(afterDelete[0].text).not.toContain("AKM PROVENANCE")
  })

  it("invokes the public extraction flow once per interval and logs its failure instead of throwing", async () => {
    host = await startPlugin(project)
    await host.subscribed
    const event = { type: "session.execution.succeeded", data: { sessionID: "ses_x" }, location: { directory: project } }
    await host.emit(event)
    await settle(500)
    const extract = () => fake.calls().filter((a) => a[0] === "proposal" && a[1] === "extract")
    expect(extract()).toHaveLength(1)
    expect(extract()[0]).toEqual(expect.arrayContaining(["proposal", "extract", "--type", "opencode", "--session-id", "ses_x"]))
    // The fake akm answers like an install with no LLM engine: exit 78, LLM_NOT_CONFIGURED.
    const failure = host.logs.find((line) => line.message === "AKM extract failed")
    expect(failure?.level).toBe("Warn")
    expect(failure?.annotations).toMatchObject({ sessionID: "ses_x", akmCode: "LLM_NOT_CONFIGURED", subsystem: "extract" })

    await host.emit(event) // every turn fires this event; the interval gate collapses them
    await settle(300)
    expect(extract()).toHaveLength(1)
  })

  it("gives a subagent's child session no session-start work, recall or extraction of its own", async () => {
    host = await startPlugin(project)
    await host.subscribed
    const at = { location: { directory: project } }
    await host.emit({ type: "session.created", data: { sessionID: "ses_child", parentID: "ses_parent" }, ...at })
    await settle(300)
    await host.runPrompt("ses_child", PROMPT)
    await host.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_child" }, ...at })
    await settle(400)
    expect(fake.calls().some((a) => a.includes("workflow"))).toBe(false)
    expect(curateCalls).toHaveLength(0)
    expect(fake.calls().some((a) => a[1] === "extract")).toBe(false)

    // The parent still gets all of it.
    await host.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_parent" }, ...at })
    await settle(400)
    expect(fake.calls().filter((a) => a[1] === "extract")).toHaveLength(1)
  })

  it("ignores events from other projects", async () => {
    host = await startPlugin(project)
    await host.subscribed
    await host.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_o" }, location: { directory: "/somewhere/else" } })
    await settle(300)
    expect(fake.calls().some((a) => a[1] === "extract")).toBe(false)
  })

  it("logs failures as structured results and never throws out of a hook, tool or event", async () => {
    process.env.AKM_OPENCODE_CLI = path.join(root, "does-not-exist")
    host = await startPlugin(project)
    await host.subscribed

    const result = await host.callTool("akm_search", { query: "nginx" })
    expect(result.metadata?.ok).toBe(false)
    expect(JSON.parse(result.content).ok).toBe(false)

    await host.runPrompt("ses_f", PROMPT) // resolves; recall just yields nothing
    const system = await host.runContext("ses_f", [{ type: "text", text: "base" }])
    expect(system[0].text).toContain("AKM is available in this session")

    await host.emit({ type: "session.created", data: { sessionID: "ses_f" }, location: { directory: project } })
    await host.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_f" }, location: { directory: project } })
    await host.emit({ type: "session.execution.succeeded" }) // malformed: no session id
    await settle(300)

    const errors = host.logs.filter((line) => line.level === "Error")
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].annotations).toMatchObject({ service: "akm-opencode-v2", toolName: "akm_search" })
    expect(host.logs.some((line) => line.message === "AKM helper failed")).toBe(true)
  })

  it("redacts secrets in what it logs", async () => {
    process.env.AKM_OPENCODE_CLI = path.join(root, "does-not-exist")
    host = await startPlugin(project)
    await host.callTool("akm_feedback", { ref: "skills/x", sentiment: "negative", replace: ["a"], with: [], note: "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" })
    await settle()
    const serialized = JSON.stringify(host.logs)
    expect(serialized).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789")
  })

  it("unloading the plugin drops session state and stops serving", async () => {
    host = await startPlugin(project)
    await host.runPrompt("ses_u", PROMPT)
    const loaded = host
    await loaded.unload()
    host = undefined
    const afterUnload = await loaded.callTool("akm_search", { query: "nginx" })
    expect(JSON.parse(afterUnload.content)).toEqual({ ok: false, error: "The AKM plugin has been unloaded." })
    expect((await loaded.runContext("ses_u", []))).toEqual([])
  })

  it("tool hook records only the plugin's own tools", async () => {
    host = await startPlugin(project)
    await host.runToolHook("execute.after", { tool: "bash", sessionID: "s", id: "c", status: "completed" })
    await host.runToolHook("execute.after", { tool: "akm_show", sessionID: "s", id: "c", status: "error" })
    await settle(50)
    const observed = host.logs.filter((line) => line.message === "AKM tool result observed")
    expect(observed).toHaveLength(1)
    expect(observed[0].annotations).toMatchObject({ toolName: "akm_show", status: "error" })
  })

  describe("automatic recall through akm-cli/api", () => {
    it("asks the in-process curate for the contract's options: limit, text format and the session directory", async () => {
      host = await startPlugin(project)
      await host.runPrompt("ses_opts", PROMPT)
      expect(curateCalls).toHaveLength(1)
      expect(curateCalls[0].options).toEqual({ limit: 5, format: "text", cwd: project })
      // Recall starts no `akm curate` process: the in-process call replaced it.
      expect(fake.calls().some((a) => a.includes("curate"))).toBe(false)
    })

    it("stops waiting at the timeout, logs it, and drops the late result", async () => {
      useConfig({ plugins: { curateTimeoutSeconds: 1 } })
      let finish!: (text: string) => void
      curateImpl = () => new Promise<string>((resolve) => (finish = resolve))
      host = await startPlugin(project)
      const started = Date.now()
      await host.runPrompt("ses_slow", PROMPT)
      expect(Date.now() - started).toBeLessThan(2500) // the prompt hook gave up on the slow curate at plugins.curateTimeoutSeconds
      await settle(1300)
      const failure = host.logs.find((line) => line.message === "AKM recall failed")
      expect(failure?.level).toBe("Warn")
      expect(String(failure?.annotations.error)).toContain("timed out")
      finish("# AKM curated\n- skills/late")
      await settle(50)
      const system = await host.runContext("ses_slow", [{ type: "text", text: "base" }])
      expect(system[0].text).not.toContain("skills/late")
      expect(system[0].text).toContain("AKM is available in this session") // the rules still go out
    })

    it("abandons an in-flight recall when the session is deleted, without a failure log", async () => {
      let finish!: (text: string) => void
      curateImpl = () => new Promise<string>((resolve) => (finish = resolve))
      host = await startPlugin(project)
      await host.subscribed
      await host.runPrompt("ses_gone", PROMPT) // waits out the 3 s recall wait, then the curate is still in flight
      await host.emit({ type: "session.deleted", data: { sessionID: "ses_gone" }, location: { directory: project } })
      await settle(100)
      finish("# AKM curated\n- skills/after-delete")
      await settle(50)
      expect(host.logs.some((line) => line.message === "AKM recall failed")).toBe(false)
      expect((await host.runContext("ses_gone", []))[0].text).not.toContain("skills/after-delete")
    })

    it("degrades to no recall and logs the API error and its code", async () => {
      curateImpl = async () => {
        throw Object.assign(new Error("No default bundle configured"), { code: "NO_BUNDLE" })
      }
      host = await startPlugin(project)
      await host.runPrompt("ses_err", PROMPT) // resolves
      const failure = host.logs.find((line) => line.message === "AKM recall failed")
      expect(failure?.level).toBe("Warn")
      expect(String(failure?.annotations.error)).toContain("No default bundle configured")
      expect(String(failure?.annotations.error)).toContain("NO_BUNDLE")
      const system = await host.runContext("ses_err", [{ type: "text", text: "base" }])
      expect(system[0].text).not.toContain("AKM PROVENANCE")
      expect(system[0].text).toContain("AKM is available in this session")
    })

    it("treats an empty curate result as no recall, not an error", async () => {
      curateImpl = async () => "   \n"
      host = await startPlugin(project)
      await host.runPrompt("ses_empty", PROMPT)
      expect(host.logs.some((line) => line.message === "AKM recall failed")).toBe(false)
      expect((await host.runContext("ses_empty", []))[0].text).not.toContain("AKM PROVENANCE")
    })
  })

  describe("automatic feedback", () => {
    const showResult = (ref: string, body: unknown = { type: "skill", ref, content: "how to" }) => ({
      tool: "akm_show",
      sessionID: "ses_fb",
      id: "call_1",
      input: { ref },
      status: "completed",
      result: { content: JSON.stringify(body) },
    })
    const feedbackCalls = () => fake.calls().filter((a) => a[0] === "feedback")

    it("credits the refs a session touched when the user says it worked", async () => {
      host = await startPlugin(project)
      await host.runToolHook("execute.after", showResult("skills/nginx-proxy"))
      await host.runPrompt("ses_fb", "thanks, that worked perfectly")
      await settle(400)
      expect(feedbackCalls()).toHaveLength(1)
      expect(feedbackCalls()[0]).toEqual(expect.arrayContaining(["feedback", "skills/nginx-proxy", "--positive", "--reason"]))
    })

    it("treats a tool outcome as no feedback by itself", async () => {
      host = await startPlugin(project)
      await host.runToolHook("execute.after", showResult("skills/nginx-proxy"))
      await settle(300)
      expect(feedbackCalls()).toHaveLength(0)
    })

    it("does not credit on a mixed signal, a failed lookup, or a no-feedback root", async () => {
      host = await startPlugin(project)
      await host.runToolHook("execute.after", showResult("skills/nginx-proxy"))
      await host.runPrompt("ses_fb", "thanks, but it didn't work")
      await host.runToolHook("execute.after", { ...showResult("skills/missing", { ok: false, error: "not found" }), sessionID: "ses_fail" })
      await host.runPrompt("ses_fail", "thanks, that worked")
      await host.runToolHook("execute.after", { ...showResult("lessons/some-lesson", { type: "lesson", ref: "lessons/some-lesson" }), sessionID: "ses_less" })
      await host.runPrompt("ses_less", "thanks, that worked")
      await settle(400)
      expect(feedbackCalls().filter((a) => a.includes("--positive"))).toHaveLength(0)
    })

    it("credits nothing when plugins.autoFeedback is false, and a wrong value keeps the default", async () => {
      useConfig({ plugins: { autoFeedback: false } })
      host = await startPlugin(project)
      await host.runToolHook("execute.after", { ...showResult("skills/nginx-proxy"), sessionID: "ses_off" })
      await host.runPrompt("ses_off", "thanks, that worked")
      await settle(400)
      expect(feedbackCalls().filter((a) => a.includes("--positive"))).toHaveLength(0)
      await host.unload()

      useConfig({ plugins: { autoFeedback: "off" } })
      host = await startPlugin(project)
      await host.runToolHook("execute.after", { ...showResult("skills/nginx-proxy"), sessionID: "ses_bad" })
      await host.runPrompt("ses_bad", "thanks, that worked")
      await settle(400)
      expect(feedbackCalls().filter((a) => a.includes("--positive"))).toHaveLength(1)
    })

    it("blames the last touched ref on an explicit correction, and waits for a second soft signal", async () => {
      host = await startPlugin(project)
      await host.runToolHook("execute.after", showResult("skills/nginx-proxy"))
      await host.runPrompt("ses_fb", "that's wrong, the port is 8443")
      await settle(500)
      expect(feedbackCalls()).toHaveLength(1)
      expect(feedbackCalls()[0]).toEqual(expect.arrayContaining(["feedback", "skills/nginx-proxy", "--negative", "--reason"]))
      expect(host.logs.some((line) => line.message === "AKM auto-feedback recorded")).toBe(true)

      // A softer negative needs a confirming second one inside two minutes.
      await host.runToolHook("execute.after", { ...showResult("skills/nginx-proxy"), sessionID: "ses_soft" })
      await host.runPrompt("ses_soft", "this is broken")
      await settle(300)
      expect(feedbackCalls()).toHaveLength(1)
      await host.runPrompt("ses_soft", "still broken")
      await settle(500)
      expect(feedbackCalls().filter((a) => a.includes("--negative"))).toHaveLength(2)
    })

    it("only believes refs from other tools when they exist in the bundle, and drops a session's refs on delete", async () => {
      const bundle = path.join(root, "bundle")
      mkdirSync(path.join(bundle, "knowledge"), { recursive: true })
      writeFileSync(path.join(bundle, "knowledge", "real.md"), "# real")
      process.env.AKM_BUNDLE_DIR = bundle
      host = await startPlugin(project)
      await host.subscribed
      await host.runToolHook("execute.after", { tool: "read", sessionID: "ses_b", id: "c", input: { path: "knowledge/real.md" }, status: "completed", result: { content: "see knowledge/real.md and knowledge/invented.md" } })
      await host.runPrompt("ses_b", "thanks, that worked")
      await settle(400)
      expect(feedbackCalls().map((a) => a[1])).toEqual(["knowledge/real.md"])

      await host.runToolHook("execute.after", { tool: "read", sessionID: "ses_c", id: "c", input: {}, status: "completed", result: { content: "knowledge/real.md" } })
      await host.emit({ type: "session.deleted", data: { sessionID: "ses_c" }, location: { directory: project } })
      await settle(100)
      await host.runPrompt("ses_c", "thanks, that worked")
      await settle(300)
      expect(feedbackCalls()).toHaveLength(1)
    })

    it("logs a feedback process that cannot start instead of throwing", async () => {
      host = await startPlugin(project)
      await host.runToolHook("execute.after", showResult("skills/nginx-proxy"))
      process.env.AKM_OPENCODE_CLI = path.join(root, "does-not-exist")
      await host.runPrompt("ses_fb", "thanks, that worked")
      await settle(300)
      expect(host.logs.some((line) => line.message === "AKM auto-feedback failed" && line.level === "Warn")).toBe(true)
    })
  })

  describe("learning proposals", () => {
    const proposalCalls = () => fake.calls().filter((a) => a[0] === "proposal" && a[1] === "new")

    it("queues a proposal for an explicit instruction and logs it, without writing any memory", async () => {
      host = await startPlugin(project)
      await host.runPrompt("ses_l", "Remember that we always deploy the staging stack with docker compose on port 8443")
      await settle(600)
      expect(proposalCalls()).toHaveLength(1)
      expect(proposalCalls()[0]).toEqual(expect.arrayContaining(["proposal", "new", "--file", "--format", "json"]))
      expect(host.logs.some((line) => line.message === "AKM learning proposal submitted" && line.level === "Info")).toBe(true)
      // Consent: the plugin only PROPOSES. It never writes a memory or accepts anything itself.
      expect(fake.calls().some((a) => a[0] === "remember" || (a[0] === "proposal" && (a[1] === "accept" || a[1] === "drain")))).toBe(false)
      const ledger = readFileSync(path.join(process.env.XDG_STATE_HOME!, "akm-opencode", "events.jsonl"), "utf8")
      expect(ledger).toContain('"event":"learning_signal"')
      expect(ledger).toContain('"event":"learning_proposal"')
    })

    it("does not propose the same lesson twice", async () => {
      host = await startPlugin(project)
      const message = "Remember that release branches are cut from main every second Thursday"
      await host.runPrompt("ses_l", message)
      await settle(500)
      await host.runPrompt("ses_l2", message)
      await settle(400)
      expect(proposalCalls()).toHaveLength(1)
    })

    it("skips the proposal quietly while akm's learning switch (improve.enabled) is off: not submitted, not failed", async () => {
      useConfig(LEARNING_OFF)
      host = await startPlugin(project)
      await host.runPrompt("ses_core_off", "Remember that the cache directory is wiped nightly by the janitor job")
      await settle(600)
      expect(proposalCalls()).toHaveLength(0)
      expect(host.logs.some((line) => line.message.startsWith("AKM learning proposal"))).toBe(false)
    })

    it("never runs `akm setup --learning`: it only follows akm's switch", async () => {
      host = await startPlugin(project)
      await host.subscribed
      await host.emit({ type: "session.created", data: { sessionID: "ses_nosetup" }, location: { directory: project } })
      await settle(400)
      expect(fake.calls().some((a) => a[0] === "setup")).toBe(false)
    })

    it("reads the prompt `opencode run` hands over as a JSON string literal", async () => {
      host = await startPlugin(project)
      await host.runPrompt("ses_q", JSON.stringify("Remember that the nightly build uploads artifacts to the staging bucket"))
      await settle(600)
      expect(proposalCalls()).toHaveLength(1)
    })

    it("does not propose from an ordinary task prompt", async () => {
      host = await startPlugin(project)
      await host.runPrompt("ses_l", PROMPT)
      await settle(300)
      expect(proposalCalls()).toHaveLength(0)
    })

    it("logs a proposal that akm rejects as failed, and keeps going", async () => {
      process.env.AKM_OPENCODE_CLI = path.join(root, "does-not-exist")
      host = await startPlugin(project)
      await host.runPrompt("ses_l", "Remember that every migration needs a rollback script before review")
      await settle(300)
      expect(host.logs.some((line) => line.message === "AKM learning proposal skipped" || line.message === "AKM learning proposal failed")).toBe(true)
    })

    it("tells the model how many proposals await review, and says nothing when none do", async () => {
      host = await startPlugin(project)
      expect((await host.runContext("ses_n", []))[0].text).not.toContain("# AKM pending proposals")
      await host.unload()

      const wrapper = path.join(root, "akm-with-pending.sh")
      writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "proposal" ] && [ "$2" = "list" ]; then echo '{"proposals":[{"id":"a"},{"id":"b"}]}'; exit 0; fi\nexec "${fake.akmPath}" "$@"\n`, { mode: 0o755 })
      process.env.AKM_OPENCODE_CLI = wrapper
      host = await startPlugin(project)
      const text = (await host.runContext("ses_n", []))[0].text
      expect(text).toContain("# AKM pending proposals")
      expect(text).toContain("There are 2 pending AKM proposals.")
      expect(text).toContain("accepting or rejecting needs the user's approval")
    })
  })

  describe("read-only mode", () => {
    const stateDir = () => path.join(process.env.XDG_STATE_HOME!, "akm-opencode")

    it("registers exactly the four read tools and no write-gate, tracking or shell hook", async () => {
      host = await startPlugin(project, { readonly: true })
      expect([...host.tools.keys()].sort()).toEqual(["akm_curate", "akm_feedback", "akm_search", "akm_show"])
      expect(host.logs.some((line) => line.level === "Warn")).toBe(false)
      expect(host.toolHooks.size).toBe(0)
      expect(host.shellHooks.size).toBe(0)
    })

    it("keeps recall and its context, with hints that never mention akm_remember, and writes nothing", async () => {
      host = await startPlugin(project, { readonly: true })
      await host.subscribed
      await host.emit({ type: "session.created", data: { sessionID: "ses_ro", location: { directory: project } }, location: { directory: project } })
      await settle(300)
      expect(curateCalls.some((c) => c.query.includes("fixture-project"))).toBe(true)
      await host.runPrompt("ses_ro", PROMPT)
      const text = (await host.runContext("ses_ro", []))[0].text
      expect(text).toContain("AKM PROVENANCE")
      expect(text).toContain("skills/nginx-proxy")
      expect(text).toContain("akm_curate")
      expect(text).toContain("akm_feedback")
      expect(text).not.toContain("akm_remember")
    })

    it("starts no extraction, learning proposal, workflow listing, auto-feedback or ledger write", async () => {
      host = await startPlugin(project, { readonly: true })
      await host.subscribed
      const loc = { directory: project }
      await host.emit({ type: "session.created", data: { sessionID: "ses_ro2", location: loc }, location: loc })
      await host.runPrompt("ses_ro2", "Remember that we always deploy the staging stack with docker compose on port 8443")
      await host.runPrompt("ses_ro2", "thanks, that worked")
      await host.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_ro2", location: loc }, location: loc })
      await host.emit({ type: "session.deleted", data: { sessionID: "ses_ro2" }, location: loc })
      await settle(600)
      const verbs = new Set(fake.calls().map((a) => a[0]))
      // `config get` is the session bootstrap's read of the default bundle.
      for (const verb of verbs) expect(["search", "show", "curate", "feedback", "config"]).toContain(verb)
      // An explicit feedback call still goes through, and is not recording.
      expect(JSON.parse((await host.callTool("akm_feedback", { ref: "skills/nginx-proxy", sentiment: "positive" })).content).ok).toBe(true)
      expect(fake.calls().some((a) => a[0] === "feedback")).toBe(true)
      expect(existsSync(stateDir())).toBe(false)
    })

    it("treats a non-true value as normal mode and says so once in the host's log", async () => {
      host = await startPlugin(project, { readonly: "yes" })
      await settle(100)
      expect([...host.tools.keys()]).toHaveLength(5)
      const warnings = host.logs.filter((line) => line.level === "Warn" && line.message.includes("`readonly`"))
      expect(warnings).toHaveLength(1)
    })
  })

  describe("shell environment", () => {
    it("exports the plugin version to every shell it starts, and no project or bundle variable", async () => {
      process.env.AKM_BUNDLE_DIR = "/srv/bundle"
      host = await startPlugin(project)
      const env = await host.runShellCreate({ PATH: "/usr/bin" })
      expect(env).not.toHaveProperty("AKM_PROJECT")
      expect(env).not.toHaveProperty("AKM_BUNDLE_DIR")
      expect(env.AKM_PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+/)
      expect(env.PATH).toBe("/usr/bin")
    })

    it("never asks akm for the bundle to build a shell environment", async () => {
      delete process.env.AKM_BUNDLE_DIR
      host = await startPlugin(project)
      await host.runShellCreate()
      expect(fake.calls().filter((a) => a.includes("info"))).toHaveLength(0)
    })
  })

  describe("write gate", () => {
    let g = ""
    const manifest = path.join(project, "service.yaml")
    const readManifest = (sessionID: string) =>
      host!.runToolHook("execute.after", {
        tool: "read",
        sessionID,
        id: "read_1",
        input: { path: "service.yaml" },
        status: "completed",
        result: {
          output: { type: "file", content: "apiVersion: inkwell/v2\nkind: Service\n" },
          content: [{ type: "text", text: "Read file service.yaml, lines 1-2\n1: apiVersion: inkwell/v2\n2: kind: Service" }],
        },
      })
    const edit = (sessionID: string, input: Record<string, unknown> = { path: "service.yaml", oldString: "kind: Service", newString: "kind: Svc" }, tool = "edit") =>
      host!.runToolHook("execute.before", { tool, sessionID, id: `call_${Math.random()}`, input })
    const ledger = () => {
      try {
        return readFileSync(path.join(process.env.XDG_STATE_HOME!, "akm-opencode", "events.jsonl"), "utf8")
          .trim().split("\n").map((line) => JSON.parse(line)).filter((event) => event.event === "write_gate")
      } catch {
        return []
      }
    }
    const reasons = () => ledger().map((event) => event.input.reason)

    beforeEach(() => {
      g = `ses_g${++counter}`
      writeFileSync(manifest, "apiVersion: inkwell/v2\nkind: Service\n")
    })

    it("records the first edit to a file whose declared format the bundle documents, once, and blocks nothing", async () => {
      host = await startPlugin(project)
      await readManifest(g)
      await settle(1200) // the identity search runs in the background after the read
      await expect(edit(g)).resolves.toBeUndefined()
      await expect(edit(g)).resolves.toBeUndefined()
      expect(reasons()).toEqual(["observe", "latched"])
      expect(ledger()[0].refs).toEqual(["knowledge/inkwell"])
      expect(ledger()[0].outcome.status).toBe("ok")
    })

    it("records the mode it ran in on the ledger", async () => {
      host = await startPlugin(project)
      await readManifest(g)
      await settle(1200)
      await expect(edit(g)).resolves.toBeUndefined()
      expect(reasons()).toEqual(["observe"])
      expect(ledger()[0].input.mode).toBe("observe")
    })

    it("does not block a model that already opened the asset, or that creates the file", async () => {
      host = await startPlugin(project)
      await readManifest("ses_shown")
      await settle(1200)
      await host.runToolHook("execute.after", { tool: "akm_show", sessionID: "ses_shown", id: "s1", input: { ref: "knowledge/inkwell" }, status: "completed", result: { content: JSON.stringify({ type: "knowledge", ref: "knowledge/inkwell", content: "format" }) } })
      await expect(edit("ses_shown")).resolves.toBeUndefined()

      await readManifest("ses_create")
      await expect(edit("ses_create", { path: "service.yaml", oldString: "", newString: "x" })).resolves.toBeUndefined()
      await expect(edit("ses_create")).resolves.toBeUndefined() // the session created this path: create work, not an edit
      await expect(edit("ses_unread", { path: "other.yaml", oldString: "a", newString: "b" })).resolves.toBeUndefined()
      expect(reasons()).toEqual(["already-shown", "create-not-edit", "session-created", "file-not-read"])
    })

    it("is blind to a patch envelope, says so once, and types every skip", async () => {
      host = await startPlugin(project)
      await edit("ses_p", { patchText: "*** Begin Patch\n*** End Patch" }, "patch")
      await edit("ses_p", { patchText: "*** Begin Patch\n*** End Patch" }, "patch")
      await edit("ses_p", { notAPath: 1 }, "write")
      expect(reasons()).toEqual(["apply-patch-unsupported", "apply-patch-unsupported", "no-file-path"])
      expect(host.logs.filter((line) => line.message === "AKM write gate inert for patch")).toHaveLength(1)
    })

    it("ignores tools it does not watch", async () => {
      host = await startPlugin(project)
      await host.runToolHook("execute.before", { tool: "shell", sessionID: "s", id: "c", input: { command: "ls" } })
      expect(ledger()).toHaveLength(0)
    })

    it("fails open and logs when akm cannot answer the identity search", async () => {
      process.env.AKM_OPENCODE_CLI = path.join(root, "does-not-exist")
      host = await startPlugin(project)
      await readManifest(g)
      await settle(500)
      await expect(edit(g)).resolves.toBeUndefined()
      expect(reasons()).toEqual(["search-error"])
      expect(host.logs.some((line) => line.message === "AKM write gate resolution failed")).toBe(true)
    })

    it("forgets a session's files when it is deleted", async () => {
      host = await startPlugin(project)
      await host.subscribed
      await readManifest("ses_d")
      await host.emit({ type: "session.deleted", data: { sessionID: "ses_d" }, location: { directory: project } })
      await settle(200)
      await edit("ses_d")
      expect(reasons().at(-1)).toBe("file-not-read")
    })
  })
  it("lets only the session's own plugin instance handle a session event that carries no location", async () => {
    const other = path.join(root, "other-instance")
    mkdirSync(other, { recursive: true })
    host = await startPlugin(project)
    const second = await startPlugin(other)
    try {
      await host.subscribed
      await second.subscribed
      // The session lives in `project`; neither event names a location (OpenCode 2.1.4).
      for (const h of [host, second]) h.sessions.set("ses_loc", { location: { directory: project } })
      const event = { type: "session.execution.succeeded", data: { sessionID: "ses_loc" } }
      await host.emit(event)
      await second.emit(event)
      await settle(600)
      expect(fake.calls().filter((a) => a[0] === "proposal" && a[1] === "extract")).toHaveLength(1)
    } finally {
      await second.unload()
    }
  })

  it("recognises its own session through a trailing slash or a symlinked directory", async () => {
    const link = path.join(root, `link-${++counter}`)
    symlinkSync(project, link)
    host = await startPlugin(project)
    await host.subscribed
    host.sessions.set("ses_slash", { location: { directory: `${project}/` } })
    host.sessions.set("ses_link", { location: { directory: link } })
    await host.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_slash" } })
    await host.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_link" } })
    await settle(600)
    expect(fake.calls().filter((a) => a[0] === "proposal" && a[1] === "extract")).toHaveLength(2)
  })

  describe("session directory and project (akm projects)", () => {
    const argvOf = (verb: string) => fake.calls().filter((a) => a[0] === verb)
    const setProject = (sessionID: string, project: unknown, parentID?: string) =>
      host!.sessions.set(sessionID, { ...(parentID ? { parentID } : {}), metadata: project === undefined ? {} : { akm: { project } } })

    it("runs every search, curate and remember in the session directory and passes no project by default", async () => {
      // A wrapper records the working directory of each akm call before running the fake.
      const cwdLog = path.join(root, `cwd-${++counter}.log`)
      const wrapper = path.join(root, `akm-cwd-${counter}.sh`)
      writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$1" >> "${cwdLog}"\nexec "${fake.akmPath}" "$@"\n`, { mode: 0o755 })
      process.env.AKM_OPENCODE_CLI = wrapper
      host = await startPlugin(project)
      await host.callTool("akm_search", { query: "nginx" }, "ses_c")
      await host.callTool("akm_curate", { query: "configure nginx proxy" }, "ses_c")
      await host.callTool("akm_remember", { content: "note" }, "ses_c")
      await host.callTool("akm_show", { ref: "skills/nginx-proxy" }, "ses_c")
      await host.callTool("akm_feedback", { ref: "skills/nginx-proxy", sentiment: "positive" }, "ses_c")
      const seen = readFileSync(cwdLog, "utf8").trim().split("\n").map((line) => line.split("\t"))
      for (const verb of ["search", "curate", "remember", "show", "feedback"]) {
        expect(seen.filter(([, v]) => v === verb).length).toBeGreaterThan(0)
      }
      for (const [dir] of seen) expect(realpathSync(dir)).toBe(realpathSync(project))
      for (const verb of ["search", "curate", "remember", "show", "feedback"]) {
        for (const argv of argvOf(verb)) expect(argv).not.toContain("--project")
      }
      await host.runPrompt("ses_c", PROMPT)
      expect(curateCalls[0].options).toMatchObject({ cwd: project })
      expect(curateCalls[0].options).not.toHaveProperty("project")
    })

    it("passes metadata.akm.project to search, curate, remember, recall and the format gate, and not to show or feedback", async () => {
      host = await startPlugin(project)
      setProject("ses_p", "acme")
      await host.callTool("akm_search", { query: "nginx" }, "ses_p")
      await host.callTool("akm_curate", { query: "configure nginx proxy" }, "ses_p")
      await host.callTool("akm_remember", { content: "note", name: "n" }, "ses_p")
      await host.callTool("akm_show", { ref: "skills/nginx-proxy" }, "ses_p")
      await host.callTool("akm_feedback", { ref: "skills/nginx-proxy", sentiment: "positive" }, "ses_p")
      expect(argvOf("search")[0]).toEqual(["search", "nginx", "--project", "acme", "--detail", "full", "--format", "json"])
      expect(argvOf("curate")[0]).toEqual(["curate", "configure nginx proxy", "--project", "acme", "--format", "json"])
      expect(argvOf("remember")[0]).toEqual(["remember", "note", "--name", "n", "--project", "acme", "--format", "json"])
      expect(argvOf("show")[0]).not.toContain("--project")
      expect(argvOf("feedback")[0]).not.toContain("--project")

      await host.runPrompt("ses_p", PROMPT)
      expect(curateCalls[0].options).toMatchObject({ cwd: project, project: "acme" })

      const before = argvOf("search").length
      await host.runToolHook("execute.after", {
        tool: "read",
        sessionID: "ses_p",
        id: "read_1",
        input: { path: "service.yaml" },
        status: "completed",
        result: { output: { type: "file", content: "apiVersion: inkwell/v2\nkind: Service\n" }, content: [{ type: "text", text: "1: apiVersion: inkwell/v2" }] },
      })
      await settle(1200)
      const gate = argvOf("search").slice(before).find((a) => a.includes("--detail") && a.includes("normal"))
      expect(gate).toContain("--project")
      // #159: no plugin-owned source override; the project's `from` decides.
      expect(gate).not.toContain("--from")
      expect(gate![gate!.indexOf("--project") + 1]).toBe("acme")
    })

    it("sends the exact gate argv, with no --from, when the session has no project", async () => {
      host = await startPlugin(project)
      const before = argvOf("search").length
      await host.runToolHook("execute.after", {
        tool: "read",
        sessionID: "ses_np",
        id: "read_1",
        input: { path: "service.yaml" },
        status: "completed",
        result: { output: { type: "file", content: "apiVersion: inkwell/v2\nkind: Service\n" }, content: [{ type: "text", text: "1: apiVersion: inkwell/v2" }] },
      })
      await settle(1200)
      const gate = argvOf("search").slice(before).find((a) => a.includes("normal") && a.includes("inkwell/v2"))
      expect(gate).toEqual(["search", "inkwell/v2", "--limit", "5", "--detail", "normal", "--format", "json"])
    })

    describe("gate cache", () => {
      const readFor = (h: HostFake, sessionID: string) =>
        h.runToolHook("execute.after", {
          tool: "read",
          sessionID,
          id: "read_1",
          input: { path: "service.yaml" },
          status: "completed",
          result: { output: { type: "file", content: "apiVersion: inkwell/v2\nkind: Service\n" }, content: [{ type: "text", text: "1: apiVersion: inkwell/v2" }] },
        })
      const gateSearches = () => argvOf("search").filter((a) => a.includes("normal") && a.includes("inkwell/v2"))

      it("looks the same token up again for a session with another project, and once for the same one", async () => {
        host = await startPlugin(project)
        setProject("ses_a1", "acme")
        setProject("ses_a2", "acme")
        setProject("ses_b", "other")
        await readFor(host, "ses_a1")
        await settle(800)
        await readFor(host, "ses_a2")
        await settle(300)
        expect(gateSearches()).toHaveLength(1)
        await readFor(host, "ses_b")
        await settle(800)
        const searches = gateSearches()
        expect(searches).toHaveLength(2)
        expect(searches[0]).toContain("acme")
        expect(searches[1]).toContain("other")
      })

      it("looks the same token up again for a plugin loaded in another directory", async () => {
        host = await startPlugin(project)
        await readFor(host, "ses_d1")
        await settle(800)
        await host.unload()
        const other = path.join(root, "other-project")
        mkdirSync(other, { recursive: true })
        host = await startPlugin(other)
        await readFor(host, "ses_d2")
        await settle(800)
        expect(gateSearches()).toHaveLength(2)
      })
    })

    it("runs extraction, learning proposals and positive feedback in the session directory, with the project on extract and proposal new", async () => {
      const cwdLog = path.join(root, `cwd-${++counter}.log`)
      const wrapper = path.join(root, `akm-cwd-${counter}.sh`)
      writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\\t%s %s\\n' "$PWD" "$1" "$2" >> "${cwdLog}"\nexec "${fake.akmPath}" "$@"\n`, { mode: 0o755 })
      process.env.AKM_OPENCODE_CLI = wrapper
      host = await startPlugin(project)
      setProject("ses_x", "acme")
      await host.runToolHook("execute.after", { tool: "akm_show", sessionID: "ses_x", id: "s1", input: { ref: "skills/nginx-proxy" }, status: "completed", result: { content: JSON.stringify({ type: "skill", ref: "skills/nginx-proxy", content: "x" }) } })
      await host.runPrompt("ses_x", "Remember that we always deploy the staging stack with docker compose on port 8443")
      await host.runPrompt("ses_x", "thanks, that worked perfectly")
      await host.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_x" }, location: { directory: project } })
      await settle(1000)
      const seen = readFileSync(cwdLog, "utf8").trim().split("\n").map((line) => line.split("\t"))
      for (const verb of ["proposal extract", "proposal new", "feedback skills/nginx-proxy"]) {
        expect(seen.filter(([, v]) => v === verb).length).toBeGreaterThan(0)
      }
      for (const [dir] of seen) expect(realpathSync(dir)).toBe(realpathSync(project))
      for (const kind of ["extract", "new"]) {
        const argv = fake.calls().find((a) => a[0] === "proposal" && a[1] === kind)!
        expect(argv[argv.indexOf("--project") + 1]).toBe("acme")
      }
      expect(argvOf("feedback")[0]).not.toContain("--project")
    })

    it("walks up to eight ancestors, trims the name, skips blank ones and warns when the session cannot be read", async () => {
      host = await startPlugin(project)
      setProject("ses_top", "  acme  ")
      for (let i = 1; i <= 6; i++) host.sessions.set(`ses_l${i}`, { parentID: i === 1 ? "ses_top" : `ses_l${i - 1}`, metadata: { akm: { project: "   " } } })
      host.sessions.set("ses_l7", { parentID: "ses_l6" })
      await host.callTool("akm_search", { query: "nginx" }, "ses_l7")
      expect(argvOf("search")[0]).toEqual(["search", "nginx", "--project", "acme", "--detail", "full", "--format", "json"])
      // The ninth level is out of reach.
      host.sessions.set("ses_deep", { parentID: "ses_l7" })
      await host.callTool("akm_search", { query: "nginx" }, "ses_deep")
      expect(argvOf("search")[1]).not.toContain("--project")

      host.sessions.get = () => { throw new Error("boom") }
      await host.callTool("akm_search", { query: "nginx" }, "ses_broken")
      expect(host.logs.some((line) => line.level === "Warn" && line.message.includes("could not read session metadata"))).toBe(true)
    })

    it("falls back to the parent session's project, and the session's own wins", async () => {
      host = await startPlugin(project)
      setProject("ses_parent", "acme")
      setProject("ses_child", undefined, "ses_parent")
      setProject("ses_own", "other", "ses_parent")
      await host.callTool("akm_search", { query: "nginx" }, "ses_child")
      await host.callTool("akm_search", { query: "nginx" }, "ses_own")
      const [child, own] = argvOf("search")
      expect(child).toContain("acme")
      expect(own).toContain("other")
      expect(own).not.toContain("acme")
    })

    it("ignores anything but a non-empty string, and a session the host cannot read", async () => {
      host = await startPlugin(project)
      setProject("ses_n", 42)
      setProject("ses_e", "")
      host.sessions.set("ses_other", { metadata: { akm: { retrieval: { source: "x" }, project: ["a"] } } })
      for (const id of ["ses_n", "ses_e", "ses_other", "ses_unknown"]) await host.callTool("akm_search", { query: "nginx" }, id)
      for (const argv of argvOf("search")) expect(argv).not.toContain("--project")
    })

    it("does not let the model supply a project", async () => {
      host = await startPlugin(project)
      await host.callTool("akm_search", { query: "nginx", project: "stolen" }, "ses_m")
      await host.callTool("akm_curate", { query: "configure nginx proxy", project: "stolen" }, "ses_m")
      for (const argv of [...argvOf("search"), ...argvOf("curate")]) expect(argv).not.toContain("--project")
    })
  })

  describe("session bootstrap: rules and most used assets (#154)", () => {
    const rules = [
      { ref: "rules/shared", type: "rule", name: "shared", description: "Shared rules", keywords: [], body: "---\ndescription: Shared rules\n---\n- Prefer small commits\n" },
      { ref: "rules/acme", type: "rule", name: "acme", description: "Acme rules", keywords: [], project: "acme", body: "---\ndescription: Acme\nproject: acme\n---\n- Acme: never force push\n" },
    ]
    const usage = [{ ref: "skills/nginx-proxy", project: "acme" }, { ref: "skills/nginx-proxy", project: "acme" }, { ref: "knowledge/inkwell", project: "acme" }]
    const withBootstrap = () => {
      fake = freshFakeAkm({ assets: [...assets, ...rules], usage, projects: { acme: { paths: [project] } } })
      process.env.AKM_OPENCODE_CLI = fake.akmPath
    }
    const listings = () => fake.calls().filter((a) => a[0] === "search" && a.includes("--by-usage")).length
    const request = async (sessionID: string) => (await host!.runContext(sessionID, [{ type: "text", text: "base" }]))[0].text

    it("a fresh session gets the project's rules, then its most used assets, ahead of the AKM guidance", async () => {
      withBootstrap()
      host = await startPlugin(project)
      await host.emit({ type: "session.created", data: { sessionID: "ses_b" }, location: { directory: project } })
      const text = await request("ses_b")
      expect(text).toContain("## rules/acme\n- Acme: never force push")
      expect(text).toContain("## rules/shared\n- Prefer small commits")
      expect(text.indexOf("# AKM rules for this session")).toBeLessThan(text.indexOf("# AKM assets used most here"))
      expect(text.indexOf("- skills/nginx-proxy")).toBeLessThan(text.indexOf("- knowledge/inkwell"))
      expect(text.indexOf("# AKM assets used most here")).toBeLessThan(text.indexOf("AKM is available in this session"))
    })

    it("does not depend on automatic curation: the rules go out when curation fails", async () => {
      curateImpl = async () => {
        throw new Error("curate is down")
      }
      withBootstrap()
      host = await startPlugin(project)
      await host.emit({ type: "session.created", data: { sessionID: "ses_b" }, location: { directory: project } })
      await settle(200)
      expect(await request("ses_b")).toContain("## rules/acme")
    })

    it("loads once per start, however many requests and prompts follow, and reads count as no demand", async () => {
      withBootstrap()
      host = await startPlugin(project)
      await host.emit({ type: "session.created", data: { sessionID: "ses_b" }, location: { directory: project } })
      await request("ses_b")
      await host.runPrompt("ses_b", PROMPT)
      await request("ses_b")
      expect(listings()).toBe(1)
      expect(existsSync(path.join(fake.binDir, "akm-usage-events.json"))).toBe(false)
    })

    it("reloads after each compaction, before the next request, and a duplicate event adds nothing", async () => {
      withBootstrap()
      host = await startPlugin(project)
      await host.emit({ type: "session.created", data: { sessionID: "ses_b" }, location: { directory: project } })
      await request("ses_b")
      const compacted = { type: "session.compaction.ended", data: { sessionID: "ses_b", reason: "auto" }, location: { directory: project } }
      await host.emit(compacted)
      await host.emit(compacted)
      await settle(200)
      expect(await request("ses_b")).toContain("## rules/acme")
      expect(listings()).toBe(2)
    })

    it("with 8 rules and a full curation every block still arrives whole: guidance, workflow and pending nag included", async () => {
      const many = Array.from({ length: 8 }, (_, n) => ({ ref: `rules/m${n}`, type: "rule", name: `m${n}`, description: `m${n}`, keywords: [], body: `---\ndescription: m${n}\n---\n- ${"z".repeat(400)}\n` }))
      fake = freshFakeAkm({ assets: [...assets, ...many], usage, projects: { acme: { paths: [project] } } })
      process.env.AKM_OPENCODE_CLI = fake.akmPath
      curateImpl = async () => ["# AKM curated", ...Array.from({ length: 5 }, (_, n) => `- knowledge/k${n} (knowledge): ${"d".repeat(150)}`)].join("\n")
      host = await startPlugin(project)
      await host.emit({ type: "session.created", data: { sessionID: "ses_m" }, location: { directory: project } })
      await settle(300)
      await host.runPrompt("ses_m", PROMPT)
      const text = await request("ses_m")
      expect(text).toContain("## rules/m0")
      expect(text).toContain("knowledge/k4")
      expect(text).toContain("An asset that simply didn't fit your task is not negative feedback") // the curated tip, whole
      expect(text).toContain("AKM is available in this session") // the guidance
      expect(text).not.toContain("[truncated for context]")
    })

    it("a child session gets no sections of its own", async () => {
      withBootstrap()
      host = await startPlugin(project)
      await host.emit({ type: "session.created", data: { sessionID: "ses_kid", parentID: "ses_b" }, location: { directory: project } })
      await settle(100)
      expect(await request("ses_kid")).not.toContain("# AKM rules")
      expect(listings()).toBe(0)
    })

    it("a session first seen at a request (a resumed one) is loaded then, once", async () => {
      withBootstrap()
      host = await startPlugin(project)
      expect(await request("ses_resumed")).toContain("## rules/acme")
      await request("ses_resumed")
      expect(listings()).toBe(1)
    })

    it("passes the host's project override to akm", async () => {
      fake = freshFakeAkm({ assets: [...assets, ...rules], usage, projects: { acme: { paths: [path.join(root, "nowhere")] } } })
      process.env.AKM_OPENCODE_CLI = fake.akmPath
      host = await startPlugin(project)
      host.sessions.set("ses_o", { metadata: { akm: { project: "acme" } } })
      await host.emit({ type: "session.created", data: { sessionID: "ses_o" }, location: { directory: project } })
      expect(await request("ses_o")).toContain("## rules/acme")
      expect(fake.calls().filter((a) => a[0] === "search" && a.includes("--by-usage")).every((a) => a.includes("--project") && a.includes("acme"))).toBe(true)
    })

    it("a failing akm leaves the guidance in place and logs the lookup", async () => {
      const bin = makeBinDir(root, `failing-${++counter}`)
      installScriptedAkm(bin, `if (args[0] === "--version") { console.log("akm 0.10.26101002"); process.exit(0) }\nprocess.stderr.write(JSON.stringify({ ok: false, error: "boom" }))\nprocess.exit(1)`)
      process.env.AKM_OPENCODE_CLI = path.join(bin, "akm")
      host = await startPlugin(project)
      await host.emit({ type: "session.created", data: { sessionID: "ses_f" }, location: { directory: project } })
      const text = await request("ses_f")
      expect(text).toContain("AKM is available in this session")
      expect(text).not.toContain("# AKM rules")
      expect(host.logs.some((line) => line.message === "AKM session bootstrap lookup failed")).toBe(true)
    })
  })

})
