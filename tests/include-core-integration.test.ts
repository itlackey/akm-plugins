// Cross-repository acceptance: run against the candidate core without pinning an unpublished dependency.
// AKM_INCLUDE_CORE_ROOT=/path/to/akm bun test tests/include-core-integration.test.ts
import { expect, it } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { setCurateForTests } from "../opencode-shared/akm-api"
import { startPlugin, type HostFake } from "../opencode-v2/testing"

const core = process.env.AKM_INCLUDE_CORE_ROOT
const acceptance = core && process.platform !== "win32" ? it : it.skip

acceptance("session metadata selects project includes for startup, prompt recall, bootstrap and explicit tools", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "akm-include-acceptance-"))
  const keys = ["AKM_CONFIG_DIR", "AKM_BUNDLE_DIR", "AKM_CACHE_DIR", "AKM_DATA_DIR", "AKM_STATE_DIR", "AKM_OPENCODE_CLI", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"]
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  let host: HostFake | undefined
  let resetConfigCache: (() => void) | undefined
  try {
    for (const key of keys) {
      if (key === "AKM_OPENCODE_CLI") continue
      process.env[key] = path.join(root, key)
      mkdirSync(process.env[key]!, { recursive: true })
    }
    const directory = path.join(root, "project")
    mkdirSync(directory)
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "widgetflux", description: "widgetflux deployment" }))
    const bundle = process.env.AKM_BUNDLE_DIR!
    for (const [name, quality] of [["draft", "proposed"], ["live", "curated"]]) {
      mkdirSync(path.join(bundle, "knowledge"), { recursive: true })
      writeFileSync(path.join(bundle, "knowledge", `${name}.md`), `---\ndescription: Configure widgetflux deployment ${name}\nquality: ${quality}\nproject: alpha\n---\nWidgetflux deployment ${name} instructions.\n`)
    }
    mkdirSync(path.join(bundle, "rules"), { recursive: true })
    writeFileSync(path.join(bundle, "rules", "draft-rule.md"), "---\ndescription: Proposed standing rule\nquality: proposed\nproject: alpha\n---\nIncluded bootstrap rule: preserve widgetflux deploy review.\n")
    const importCore = (file: string) => import(pathToFileURL(path.join(core!, "src", file)).href)
    const config = await importCore("core/config/config.ts")
    resetConfigCache = config.resetConfigCache
    config.saveConfig({ semanticSearchMode: "off", improve: { enabled: false }, projects: {
      alpha: { filters: { project: "alpha" }, include: { quality: "proposed" } },
      ordinary: { filters: { project: "alpha" } },
    } })
    const indexer = await importCore("indexer/indexer.ts")
    await indexer.akmIndex({ stashDir: bundle, full: true })
    const api = await importCore("api.ts")
    const recalls: string[] = []
    setCurateForTests(async (query, options) => {
      const result = await api.curate(query, options)
      recalls.push(result)
      return result
    })
    const executable = path.join(root, "akm")
    writeFileSync(executable, `#!/usr/bin/env bun\nawait import(${JSON.stringify(pathToFileURL(path.join(core!, "src/cli.ts")).href)}).then(m => m.runCli())\n`)
    // Importing cli.ts does not run its entrypoint; invoke its supported runCli startup.
    chmodSync(executable, 0o755)
    process.env.AKM_OPENCODE_CLI = executable
    host = await startPlugin(directory)
    await host.subscribed
    host.sessions.set("included", { metadata: { akm: { project: "alpha" } } })
    host.sessions.set("ordinary", { metadata: { akm: { project: "ordinary" } } })
    await host.emit({ type: "session.created", data: { sessionID: "included" }, location: { directory } })
    const deadline = Date.now() + 10000
    while (!recalls.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(recalls.length).toBeGreaterThan(0)
    expect(recalls[0]).toContain("knowledge/draft")
    await host.runPrompt("included", "Configure the widgetflux deployment service using the project instructions")
    expect(recalls.at(-1)).toContain("knowledge/draft")
    const context = await host.runContext("included", [])
    expect(context.map((part) => part.text).join("\n")).toContain("knowledge/draft")
    expect(context.map((part) => part.text).join("\n")).toContain("Included bootstrap rule")
    for (const verb of ["akm_search", "akm_curate"]) {
      const included = await host.callTool(verb, { query: "widgetflux" }, "included")
      expect(included.content).toContain("knowledge/draft")
      const ordinary = await host.callTool(verb, { query: "widgetflux" }, "ordinary")
      expect(ordinary.content).not.toContain("knowledge/draft")
      const explicit = await host.callTool(verb, { query: "widgetflux", include: ["quality=proposed"] }, "ordinary")
      expect(explicit.content).toContain("knowledge/draft")
    }
    await host.runPrompt("ordinary", "Configure the widgetflux deployment service using the project instructions")
    expect(recalls.at(-1)).not.toContain("knowledge/draft")
  } finally {
    await host?.unload()
    setCurateForTests(undefined)
    resetConfigCache?.()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
}, 30000)
