import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { installFakeAkm, readCallLog } from "../evals/lib/fake-akm"
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

let host: HostFake | undefined
let fake: ReturnType<typeof freshFakeAkm>
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ["AKM_OPENCODE_CLI", "AKM_EXTRACT_MIN_INTERVAL_MS", "AKM_AUTO_MEMORY", "AKM_AUTO_CURATE"]) saved[key] = process.env[key]
  fake = freshFakeAkm()
  process.env.AKM_OPENCODE_CLI = fake.akmPath
  process.env.AKM_EXTRACT_MIN_INTERVAL_MS = "600000"
  delete process.env.AKM_AUTO_MEMORY
  delete process.env.AKM_AUTO_CURATE
})

afterEach(async () => {
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
    const curates = () => fake.calls().filter((a) => a[0] === "curate" || a.includes("curate")).length
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
    expect(fake.calls().some((a) => a.includes("curate"))).toBe(false)
  })

  it("session start curates for the project, loads hints, and cleans up on delete", async () => {
    host = await startPlugin(project)
    await host.subscribed
    await host.emit({ type: "session.created", data: { sessionID: "ses_s", location: { directory: project } }, location: { directory: project } })
    await settle(400)
    const argv = fake.calls()
    expect(argv.some((a) => a.includes("hints"))).toBe(true)
    expect(argv.some((a) => a.includes("curate") && a.some((x) => x.includes("fixture-project")))).toBe(true)
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
})
