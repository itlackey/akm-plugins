import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { installFakeAkm, readCallLog } from "../evals/lib/fake-akm"
import { type CurateFn, setCurateForTests } from "../opencode-shared/akm-api"
import { resetWriteGateForTests } from "../opencode-shared/write-gate"
import { startPlugin, type HostFake } from "../opencode-v2/testing"

// Drives the real `akm-opencode-v2` entrypoint (`Plugin.define`, effect API of
// @opencode/plugin 2.0.26) against a fake OpenCode context and the repo's fake
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
function freshFakeAkm() {
  const dir = path.join(root, `fake-${++counter}`)
  const fake = installFakeAkm({ binDir: dir, callLog: path.join(dir, "calls.log"), assets })
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
const ENV_KEYS = ["AKM_OPENCODE_CLI", "AKM_EXTRACT_MIN_INTERVAL_MS", "AKM_AUTO_MEMORY", "AKM_AUTO_CURATE", "AKM_RECALL_WAIT_MS", "AKM_CURATE_TIMEOUT", "AKM_AUTO_FEEDBACK", "AKM_AUTO_LEARNING", "AKM_AUTO_SKILL_PROPOSALS", "AKM_BUNDLE_DIR", "AKM_WRITE_GATE", "XDG_STATE_HOME"]
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
  delete process.env.AKM_WRITE_GATE
  resetWriteGateForTests()
  fake = freshFakeAkm()
  process.env.AKM_OPENCODE_CLI = fake.akmPath
  process.env.AKM_EXTRACT_MIN_INTERVAL_MS = "600000"
  delete process.env.AKM_AUTO_MEMORY
  delete process.env.AKM_AUTO_CURATE
})

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
    expect(JSON.parse(search.content).hits[0].ref).toBe("skills/nginx-proxy")
    const show = await host.callTool("akm_show", { ref: "skills/nginx-proxy", detail: "full" })
    expect(JSON.parse(show.content).ref).toBe("skills/nginx-proxy")
    const curate = await host.callTool("akm_curate", { query: "configure nginx proxy", limit: 2 })
    expect(JSON.parse(curate.content).items[0].ref).toBe("skills/nginx-proxy")

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
    expect(argv.find((a) => a[0] === "remember")).toEqual(expect.arrayContaining(["remember", "use port 8443", "--name", "port-note", "--run", "ses_test"]))
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

  it("does not curate when automatic recall is switched off or the prompt is not a task", async () => {
    process.env.AKM_AUTO_CURATE = "0"
    host = await startPlugin(project)
    await host.runPrompt("ses_off", PROMPT)
    expect(curateCalls).toHaveLength(0)
  })

  it("session start curates for the project, loads hints, and cleans up on delete", async () => {
    host = await startPlugin(project)
    await host.subscribed
    await host.emit({ type: "session.created", data: { sessionID: "ses_s", location: { directory: project } }, location: { directory: project } })
    await settle(400)
    const argv = fake.calls()
    expect(argv.some((a) => a.includes("hints"))).toBe(true)
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

  it("honours AKM_AUTO_MEMORY=0 and ignores events from other projects", async () => {
    process.env.AKM_AUTO_MEMORY = "0"
    host = await startPlugin(project)
    await host.subscribed
    await host.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_m" }, location: { directory: project } })
    await settle(300)
    expect(fake.calls().some((a) => a[1] === "extract")).toBe(false)

    delete process.env.AKM_AUTO_MEMORY
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
    it("asks the in-process curate for the contract's options: limit and text format, no cwd", async () => {
      host = await startPlugin(project)
      await host.runPrompt("ses_opts", PROMPT)
      expect(curateCalls).toHaveLength(1)
      expect(curateCalls[0].options).toEqual({ limit: 5, format: "text" })
      // Recall starts no `akm curate` process: the in-process call replaced it.
      expect(fake.calls().some((a) => a.includes("curate"))).toBe(false)
    })

    it("stops waiting at the timeout, logs it, and drops the late result", async () => {
      process.env.AKM_CURATE_TIMEOUT = "1"
      process.env.AKM_RECALL_WAIT_MS = "50"
      let finish!: (text: string) => void
      curateImpl = () => new Promise<string>((resolve) => (finish = resolve))
      host = await startPlugin(project)
      const started = Date.now()
      await host.runPrompt("ses_slow", PROMPT)
      expect(Date.now() - started).toBeLessThan(900) // the prompt hook did not wait for the slow curate
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
      process.env.AKM_RECALL_WAIT_MS = "50"
      let finish!: (text: string) => void
      curateImpl = () => new Promise<string>((resolve) => (finish = resolve))
      host = await startPlugin(project)
      await host.subscribed
      await host.runPrompt("ses_gone", PROMPT)
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

    it("does not credit on a mixed signal, a failed lookup, a no-feedback root, or when switched off", async () => {
      host = await startPlugin(project)
      await host.runToolHook("execute.after", showResult("skills/nginx-proxy"))
      await host.runPrompt("ses_fb", "thanks, but it didn't work")
      await host.runToolHook("execute.after", { ...showResult("skills/missing", { ok: false, error: "not found" }), sessionID: "ses_fail" })
      await host.runPrompt("ses_fail", "thanks, that worked")
      await host.runToolHook("execute.after", { ...showResult("lessons/some-lesson", { type: "lesson", ref: "lessons/some-lesson" }), sessionID: "ses_less" })
      await host.runPrompt("ses_less", "thanks, that worked")
      process.env.AKM_AUTO_FEEDBACK = "0"
      await host.runToolHook("execute.after", { ...showResult("skills/nginx-proxy"), sessionID: "ses_off" })
      await host.runPrompt("ses_off", "thanks, that worked")
      await settle(400)
      expect(feedbackCalls().filter((a) => a.includes("--positive"))).toHaveLength(0)
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

    it("does not propose the same lesson twice, and is off with AKM_AUTO_LEARNING=0", async () => {
      host = await startPlugin(project)
      const message = "Remember that release branches are cut from main every second Thursday"
      await host.runPrompt("ses_l", message)
      await settle(500)
      await host.runPrompt("ses_l2", message)
      await settle(400)
      expect(proposalCalls()).toHaveLength(1)

      process.env.AKM_AUTO_LEARNING = "0"
      await host.runPrompt("ses_l3", "Remember that the cache directory is wiped nightly by the janitor job")
      await settle(400)
      expect(proposalCalls()).toHaveLength(1)
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
      writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "proposal" ] && [ "$2" = "list" ]; then echo '{"proposals":[{"id":"a"},{"id":"b"}]}'; exit 0; fi\nexec ${fake.akmPath} "$@"\n`, { mode: 0o755 })
      process.env.AKM_OPENCODE_CLI = wrapper
      host = await startPlugin(project)
      const text = (await host.runContext("ses_n", []))[0].text
      expect(text).toContain("# AKM pending proposals")
      expect(text).toContain("There are 2 pending AKM proposals.")
      expect(text).toContain("mutating proposal actions require explicit user approval")
    })
  })

  describe("shell environment", () => {
    it("exports the project, the plugin version and the bundle to every shell it starts", async () => {
      process.env.AKM_BUNDLE_DIR = "/srv/bundle"
      host = await startPlugin(project)
      const env = await host.runShellCreate({ PATH: "/usr/bin" })
      expect(env.AKM_PROJECT).toBe(project)
      expect(env.AKM_BUNDLE_DIR).toBe("/srv/bundle")
      expect(env.AKM_PLUGIN_VERSION).toMatch(/^\d+\.\d+\.\d+/)
      expect(env.PATH).toBe("/usr/bin")
    })

    it("asks akm for the bundle once when AKM_BUNDLE_DIR is unset, and never throws when it cannot", async () => {
      delete process.env.AKM_BUNDLE_DIR
      host = await startPlugin(project)
      await host.runShellCreate()
      await host.runShellCreate()
      expect(fake.calls().filter((a) => a.includes("info"))).toHaveLength(1)

      process.env.AKM_OPENCODE_CLI = path.join(root, "does-not-exist")
      await host.unload()
      host = await startPlugin(project)
      const env = await host.runShellCreate()
      expect(env.AKM_PROJECT).toBe(project)
      expect(env.AKM_BUNDLE_DIR).toBeUndefined()
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

    function enforce() {
      process.env.AKM_WRITE_GATE = "enforce"
      resetWriteGateForTests()
    }

    it("blocks the first edit to a file whose declared format the bundle documents, once", async () => {
      enforce()
      host = await startPlugin(project)
      await readManifest(g)
      await settle(1200) // the identity search runs in the background after the read
      await expect(edit(g)).rejects.toThrow(/declares `inkwell\/v2`|declares `inkwell`/)
      await expect(edit(g)).resolves.toBeUndefined() // repeating it proceeds
      expect(reasons()).toEqual(["fired", "latched"])
      expect(ledger()[0].refs).toEqual(["knowledge/inkwell"])
      expect(ledger()[0].outcome.status).toBe("ok")
    })

    it("fails with the gate message as the tool error, tagged the way the host reads", async () => {
      enforce()
      host = await startPlugin(project)
      await readManifest(g)
      await settle(1200)
      const error = await edit(g).then(() => undefined, (e: unknown) => e as { _tag?: string; message: string })
      expect(error?._tag).toBe("Tool.Error")
      expect(error?.message).toContain('Call akm_show with ref "knowledge/inkwell"')
      expect(error?.message).toContain("The inkwell service manifest format")
    })

    it("only records what it would have blocked in the default observe mode", async () => {
      host = await startPlugin(project)
      await readManifest(g)
      await settle(1200)
      await expect(edit(g)).resolves.toBeUndefined()
      expect(reasons()).toEqual(["observe"])
    })

    it("does not block a model that already opened the asset, or that creates the file", async () => {
      enforce()
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
      enforce()
      host = await startPlugin(project)
      await edit("ses_p", { patchText: "*** Begin Patch\n*** End Patch" }, "patch")
      await edit("ses_p", { patchText: "*** Begin Patch\n*** End Patch" }, "patch")
      await edit("ses_p", { notAPath: 1 }, "write")
      expect(reasons()).toEqual(["apply-patch-unsupported", "apply-patch-unsupported", "no-file-path"])
      expect(host.logs.filter((line) => line.message === "AKM write gate inert for patch")).toHaveLength(1)
    })

    it("ignores tools it does not watch, honours AKM_WRITE_GATE=off, and refuses a misspelled mode loudly", async () => {
      enforce()
      host = await startPlugin(project)
      await host.runToolHook("execute.before", { tool: "shell", sessionID: "s", id: "c", input: { command: "ls" } })
      expect(ledger()).toHaveLength(0)

      process.env.AKM_WRITE_GATE = "off"
      resetWriteGateForTests()
      await edit("ses_off")
      expect(reasons()).toEqual(["disabled"])

      process.env.AKM_WRITE_GATE = "enfroce"
      resetWriteGateForTests()
      await readManifest("ses_bad")
      await settle(300)
      await expect(edit("ses_bad")).resolves.toBeUndefined()
      expect(reasons().at(-1)).toBe("invalid-mode")
      expect(host.logs.some((line) => line.level === "Error" && line.message.includes("unrecognized AKM_WRITE_GATE"))).toBe(true)
    })

    it("fails open and logs when akm cannot answer the identity search", async () => {
      enforce()
      process.env.AKM_OPENCODE_CLI = path.join(root, "does-not-exist")
      host = await startPlugin(project)
      await readManifest(g)
      await settle(500)
      await expect(edit(g)).resolves.toBeUndefined()
      expect(reasons()).toEqual(["search-error"])
      expect(host.logs.some((line) => line.message === "AKM write gate resolution failed")).toBe(true)
    })

    it("forgets a session's files when it is deleted", async () => {
      enforce()
      host = await startPlugin(project)
      await host.subscribed
      await readManifest("ses_d")
      await host.emit({ type: "session.deleted", data: { sessionID: "ses_d" }, location: { directory: project } })
      await settle(200)
      await edit("ses_d")
      expect(reasons().at(-1)).toBe("file-not-read")
    })
  })
})
