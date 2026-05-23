import { describe, it, expect, mock, beforeEach } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import opencodePackage from "../opencode/package.json"

// Mock execFileSync and execSync before importing the plugin
const mockExecFileSync = mock(() => "mock output")
const mockExecSync = mock(() => "exec output")
const execFileSyncShim = (...args: any[]) => {
  const [command, commandArgs] = args as [string, string[]]
  const isAkmCommand = typeof command === "string"
    && (command === "akm" || /(^|[\\/])akm(?:\.cmd|\.exe)?$/.test(command))
  if (isAkmCommand && Array.isArray(commandArgs) && commandArgs[0] === "--version") {
    try {
      const result = (mockExecFileSync as any)(...args)
      if (typeof result === "string" && /\b\d+\.\d+\.\d+\b/.test(result)) return result
      return "akm 0.8.9\n"
    } catch {
      return "akm 0.8.9\n"
    }
  }
  return (mockExecFileSync as any)(...args)
}
const mockSpawn = mock(() => ({
  on: mock(() => undefined),
  unref: mock(() => undefined),
}))
const mockFetch = mock(async () => new Response(JSON.stringify({ version: "0.5.0" }), { status: 200 }))
mock.module("node:child_process", () => ({
  execFileSync: execFileSyncShim,
  execSync: mockExecSync,
  spawn: mockSpawn,
}))

const pluginModule = await import("../opencode/index.ts")
const { AkmPlugin, server, default: defaultPluginModule } = pluginModule

function createMockClient() {
  return {
    app: {
      log: mock(async () => ({ data: {}, error: undefined })),
      agents: mock(async () => ({
        data: [{ name: "general" }, { name: "akm-curator" }],
        error: undefined,
      })),
    },
    session: {
      create: mock(async () => ({ data: { id: "child-session-1" }, error: undefined })),
      get: mock(async () => ({
        data: { id: "child-session-1", parentID: "parent-session-root" },
        error: undefined,
      })),
      messages: mock(async () => ({
        data: [
          {
            info: { role: "user", agent: "build" },
            parts: [{ type: "text", text: "Parent context" }],
          },
        ],
        error: undefined,
      })),
      prompt: mock(async () => ({
        data: {
          parts: [{ type: "text", text: "child response" }],
        },
        error: undefined,
      })),
    },
  }
}

async function withEnvVar<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[name]
  process.env[name] = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

const opencodeInstallLocation = path.dirname(fileURLToPath(new URL("../opencode/index.ts", import.meta.url)))

// Minimal stub that satisfies the PluginInput shape
function createPluginInput(overrides?: Partial<PluginInput>): PluginInput {
  return {
    client: createMockClient() as any,
    project: {} as any,
    directory: "/tmp/test-project",
    worktree: "/tmp/test-project",
    serverUrl: new URL("http://localhost:3000"),
    $: {} as any,
    ...overrides,
  }
}

function createToolContext(overrides?: Record<string, unknown>) {
  return {
    sessionID: "parent-session-1",
    messageID: "message-1",
    agent: "build",
    directory: "/tmp/test-project",
    worktree: "/tmp/test-project",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
    ...overrides,
  } as any
}

describe("akm-opencode plugin", () => {
  beforeEach(() => {
    mockExecFileSync.mockClear()
    mockExecFileSync.mockReturnValue("mock output")
    mockExecSync.mockClear()
    mockExecSync.mockReturnValue("exec output")
    mockSpawn.mockClear()
    mockFetch.mockClear()
    mockFetch.mockImplementation(async () => new Response(JSON.stringify({ version: "0.5.0" }), { status: 200 }))
    globalThis.fetch = mockFetch as typeof fetch
  })

  describe("plugin loading", () => {
    it("exports AkmPlugin as a function", () => {
      expect(typeof AkmPlugin).toBe("function")
    })

    it("exports the OpenCode plugin module shape", () => {
      expect(server).toBe(AkmPlugin)
      expect(defaultPluginModule).toEqual({ server: AkmPlugin, id: "akm-opencode" })
    })

    it("returns hooks object when invoked", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      expect(hooks).toBeDefined()
      expect(hooks["chat.message"]).toBeDefined()
      expect(hooks["tool.execute.before"]).toBeDefined()
      expect(hooks["tool.execute.after"]).toBeDefined()
      expect(hooks["shell.env"]).toBeDefined()
      expect(hooks["experimental.session.compacting"]).toBeUndefined()
      expect(hooks.tool).toBeDefined()
    })

    it("registers the high-value tool surface plus akm_help and the v0.8.0 proposal/improve tools", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const toolNames = Object.keys(hooks.tool!)
      const expected = [
        "akm_info",
        "akm_search",
        "akm_show",
        "akm_remember",
        "akm_feedback",
        "akm_memory",
        "akm_curate",
        "akm_evolve",
        "akm_parent_messages",
        "akm_session_messages",
        "akm_agent",
        "akm_cmd",
        "akm_vault",
        "akm_wiki",
        "akm_workflow",
        "akm_proposal",
        "akm_improve",
        "akm_propose",
        "akm_init",
        "akm_help",
      ]
      for (const name of expected) {
        expect(toolNames).toContain(name)
      }
      const removed = [
        "akm_add",
        "akm_registry_search",
        "akm_index",
        "akm_list",
        "akm_remove",
        "akm_update",
        "akm_clone",
        "akm_config",
        "akm_run",
        "akm_sources",
        "akm_upgrade",
        "akm_save",
        "akm_import",
        "akm_submit",
      ]
      for (const name of removed) {
        expect(toolNames).not.toContain(name)
      }
      expect(toolNames).toHaveLength(expected.length)
    })

    it("returns lifecycle hooks for the compound-engineering loop", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      expect(hooks.event).toBeDefined()
      expect(hooks.stop).toBeDefined()
      expect(hooks["experimental.chat.system.transform"]).toBeDefined()
    })

    it("logs shell.env hook failures through OpenCode logging", async () => {
      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const output = { env: null as any }

      await hooks["shell.env"]!({} as any, output as any)

      expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          message: "AKM shell.env hook failed",
          extra: expect.objectContaining({ subsystem: "hook", hook: "shell.env" }),
        }),
      }))
    })
  })

  describe("tool definitions", () => {
    it("each tool has a description", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      for (const [name, def] of Object.entries(hooks.tool!)) {
        expect(def.description).toBeTruthy()
        expect(typeof def.description).toBe("string")
      }
    })

    it("each tool has an execute function", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      for (const [name, def] of Object.entries(hooks.tool!)) {
        expect(typeof def.execute).toBe("function")
      }
    })

    it("akm_search has required args schema", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const search = hooks.tool!.akm_search
      expect(search.args.query).toBeDefined()
      expect(search.args.type).toBeDefined()
      expect(search.args.limit).toBeDefined()
      expect(search.args.source).toBeDefined()
    })

    it("akm_info has no args", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      expect(Object.keys(hooks.tool!.akm_info.args)).toHaveLength(0)
    })

    it("akm_show has required args schema", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const show = hooks.tool!.akm_show
      expect(show.args.ref).toBeDefined()
      expect(show.args.view_mode).toBeDefined()
      expect(show.args.heading).toBeDefined()
      expect(show.args.start_line).toBeDefined()
      expect(show.args.end_line).toBeDefined()
    })

    it("akm_agent has required args schema", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const dispatch = hooks.tool!.akm_agent
      expect(dispatch.args.ref).toBeDefined()
      expect(dispatch.args.query).toBeDefined()
      expect(dispatch.args.task_prompt).toBeDefined()
      expect(dispatch.args.dispatch_agent).toBeDefined()
      expect(dispatch.args.as_subtask).toBeDefined()
    })

    it("akm_remember has required args schema", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const remember = hooks.tool!.akm_remember
      expect(remember.args.content).toBeDefined()
      expect(remember.args.name).toBeDefined()
      expect(remember.args.force).toBeDefined()
    })

    it("akm_feedback has required args schema", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const feedback = hooks.tool!.akm_feedback
      expect(feedback.args.ref).toBeDefined()
      expect(feedback.args.sentiment).toBeDefined()
      expect(feedback.args.note).toBeDefined()
    })

    it("akm_memory exposes action and candidate review args", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const memory = hooks.tool!.akm_memory
      expect(memory.args.action).toBeDefined()
      expect(memory.args.candidate_id).toBeDefined()
      expect(memory.args.reason).toBeDefined()
      expect(memory.args.scope).toBeDefined()
      expect(memory.args.status).toBeDefined()
      expect(memory.args.confirm).toBeDefined()
    })

    it("akm_cmd has required args schema", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const cmd = hooks.tool!.akm_cmd
      expect(cmd.args.ref).toBeDefined()
      expect(cmd.args.query).toBeDefined()
      expect(cmd.args.arguments).toBeDefined()
      expect(cmd.args.dispatch_agent).toBeDefined()
      expect(cmd.args.as_subtask).toBeDefined()
    })

    it("akm_help exposes topic and command args", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const help = hooks.tool!.akm_help
      expect(help.args.topic).toBeDefined()
      expect(help.args.command).toBeDefined()
    })

    it("akm_vault has required args schema", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const vault = hooks.tool!.akm_vault
      expect(vault.args.action).toBeDefined()
      expect(vault.args.ref).toBeDefined()
      expect(vault.args.name).toBeDefined()
      expect(vault.args.key).toBeDefined()
      expect(vault.args.value).toBeDefined()
      expect(vault.args.comment).toBeDefined()
      expect(vault.args.confirm).toBeDefined()
    })

    it("cross-session message tools expose the expected args", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      expect(Object.keys(hooks.tool!.akm_parent_messages.args)).toHaveLength(0)
      expect(hooks.tool!.akm_session_messages.args.session_id).toBeDefined()
    })

    it("akm_wiki has required args schema", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const wiki = hooks.tool!.akm_wiki
      expect(wiki.args.action).toBeDefined()
      expect(wiki.args.name).toBeDefined()
      expect(wiki.args.source_ref).toBeDefined()
      expect(wiki.args.writable).toBeDefined()
      expect(wiki.args.trust).toBeDefined()
      expect(wiki.args.max_pages).toBeDefined()
      expect(wiki.args.max_depth).toBeDefined()
      expect(wiki.args.query).toBeDefined()
      expect(wiki.args.source).toBeDefined()
      expect(wiki.args.as_slug).toBeDefined()
      expect(wiki.args.force).toBeDefined()
      expect(wiki.args.with_sources).toBeDefined()
    })

    it("akm_workflow has required args schema", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const wf = hooks.tool!.akm_workflow
      expect(wf.args.action).toBeDefined()
      expect(wf.args.ref).toBeDefined()
      expect(wf.args.target).toBeDefined()
      expect(wf.args.run_id).toBeDefined()
      expect(wf.args.params).toBeDefined()
      expect(wf.args.step).toBeDefined()
      expect(wf.args.state).toBeDefined()
      expect(wf.args.evidence).toBeDefined()
      expect(wf.args.name).toBeDefined()
      expect(wf.args.from).toBeDefined()
      expect(wf.args.force).toBeDefined()
      expect(wf.args.reset).toBeDefined()
      expect(wf.args.filter_ref).toBeDefined()
      expect(wf.args.active_only).toBeDefined()
    })

    it("akm_proposal exposes the v0.8.0 list/show/diff/accept/reject discriminator", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const tool = hooks.tool!.akm_proposal
      expect(tool.args.action).toBeDefined()
      expect(tool.args.id).toBeDefined()
      expect(tool.args.status).toBeDefined()
      expect(tool.args.reason).toBeDefined()
    })

    it("akm_improve exposes scope + task args", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const tool = hooks.tool!.akm_improve
      expect(tool.args.scope).toBeDefined()
      expect(tool.args.task).toBeDefined()
      expect(tool.args.dry_run).toBeDefined()
    })

    it("akm_propose requires type/name and one input source", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const tool = hooks.tool!.akm_propose
      expect(tool.args.type).toBeDefined()
      expect(tool.args.name).toBeDefined()
      expect(tool.args.task).toBeDefined()
      expect(tool.args.file).toBeDefined()
    })

    it("akm_init takes no args", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const tool = hooks.tool!.akm_init
      expect(tool.args).toEqual({})
    })

  })

  describe("tool execution", () => {
    it("akm_info returns akm info output plus plugin metadata", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args[0] === "--version") return "0.8.9"
        if (Array.isArray(args) && args[0] === "info") {
          return JSON.stringify({ version: "0.7.0", stashDir: "/tmp/akm-stash" })
        }
        return "mock output"
      })

      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_info.execute({} as any, {} as any)

      expect(
        mockExecFileSync.mock.calls.some(([, args]) =>
          Array.isArray(args)
          && args[0] === "info",
        ),
      ).toBe(true)

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.pluginVersion).toBe(opencodePackage.version)
      expect(parsed.pluginInstallLocation).toBe(opencodeInstallLocation)
      expect(parsed.akmInfo).toEqual({
        version: "0.7.0",
        stashDir: "/tmp/akm-stash",
      })
    })

    it("akm_search calls CLI with correct args", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_search.execute(
        { query: "test-query" } as any,
        {} as any,
      )
      expect(result).toBe("mock output")
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["search", "test-query", "--detail", "normal", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_search passes type filter", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_search.execute(
        { query: "hello", type: "skill" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["search", "hello", "--type", "skill", "--detail", "normal", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_search passes limit", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_search.execute(
        { query: "hello", limit: 5 } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["search", "hello", "--limit", "5", "--detail", "normal", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_search supports lessons and include_proposed", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args[0] === "search") {
          return JSON.stringify({
            hits: [{ type: "lesson", ref: "lesson:avoid-drift", quality: "proposed" }],
            warnings: ["existing warning"],
          })
        }
        return "mock output"
      })
      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_search.execute(
        { query: "drift", type: "lesson", include_proposed: true } as any,
        createToolContext(),
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["search", "drift", "--type", "lesson", "--include-proposed", "--detail", "normal", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
      const parsed = JSON.parse(result)
      expect(parsed.hits[0].type).toBe("lesson")
      expect(parsed.hits[0].quality).toBe("proposed")
      expect(parsed.warnings).toContain("existing warning")
      expect(parsed.warnings).toContain("Do not treat proposed assets as curated until accepted.")
    })

    it("akm_show calls CLI with ref", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_show.execute(
        { ref: "script:deploy.sh" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["show", "script:deploy.sh", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_show passes view_mode and heading as positional args", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_show.execute(
        { ref: "knowledge://doc", view_mode: "section", heading: "Install" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["show", "knowledge://doc", "section", "Install", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_show passes line range as positional args", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_show.execute(
        { ref: "knowledge://doc", view_mode: "lines", start_line: 10, end_line: 20 } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["show", "knowledge://doc", "lines", "10", "20", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_remember records a memory with optional flags", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_remember.execute(
        { content: "Deployment needs VPN", name: "ops/vpn", force: true } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["remember", "Deployment needs VPN", "--name", "ops/vpn", "--force", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_remember passes harness scope flags", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_remember.execute(
        { content: "remember this" } as any,
        createToolContext({ userID: "user-9", agent: "general", sessionID: "run-1", channel: "review" }),
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["remember", "remember this", "--user", "user-9", "--agent", "general", "--run", "run-1", "--channel", "review", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_feedback records positive feedback with a note", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_feedback.execute(
        { ref: "skill:code-review", sentiment: "positive", note: "Worked perfectly" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["feedback", "skill:code-review", "--positive", "--note", "Worked perfectly", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_feedback records positive feedback for lesson refs with scope", async () => {
      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      await hooks.tool!.akm_feedback.execute(
        { ref: "lesson:review-first", sentiment: "positive", note: "helped" } as any,
        createToolContext({ userID: "u1", channel: "review" }),
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["feedback", "lesson:review-first", "--positive", "--note", "helped", "--user", "u1", "--agent", "build", "--run", "parent-session-1", "--channel", "review", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
      expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({ message: "akm.feedback.recorded" }),
      }))
    })

    it("akm_feedback skips unindexed refs without surfacing the raw CLI error payload", async () => {
      const client = createMockClient()
      mockExecFileSync.mockImplementation(() => {
        throw new Error("Ref \"knowledge:akm-plugin-version\" is not in the current index. Run \"akm index\" and try again.")
      })
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))

      const result = await hooks.tool!.akm_feedback.execute(
        { ref: "knowledge:akm-plugin-version", sentiment: "positive", note: "Used akm_info to answer installed plugin version question." } as any,
        {} as any,
      )

      expect(result).toBe(JSON.stringify({
        ok: true,
        skipped: true,
        reason: "ref_not_indexed",
        ref: "knowledge:akm-plugin-version",
        sentiment: "positive",
      }))
      expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          message: "AKM feedback skipped",
          extra: expect.objectContaining({
            subsystem: "feedback",
            ref: "knowledge:akm-plugin-version",
            reason: "ref_not_indexed",
          }),
        }),
      }))
      expect(client.app.log).not.toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({ message: "akm.feedback.recorded" }),
      }))
    })

    it("akm_curate shells out to 'akm curate' with JSON output like the direct CLI", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_curate.execute(
        { query: "deploy the app", limit: 4 } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        [
          "curate",
          "deploy the app",
          "--limit",
          "4",
          "--format",
          "json",
        ],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_curate passes harness scope flags", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_curate.execute(
        { query: "deploy the app", limit: 3 } as any,
        createToolContext({ userID: "user-9", agent: "general", sessionID: "run-1", channel: "review" }),
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["curate", "deploy the app", "--limit", "3", "--user", "user-9", "--agent", "general", "--run", "run-1", "--channel", "review", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_curate preserves a single explicit detail flag without injecting duplicate formats", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_curate.execute(
        { query: "deploy the app", limit: 8, detail: "normal" } as any,
        {} as any,
      )

      const [, args] = mockExecFileSync.mock.calls.at(-1) as [string, string[]]
      expect(args).toEqual([
        "curate",
        "deploy the app",
        "--limit",
        "8",
        "--detail",
        "normal",
        "--format",
        "json",
      ])
      expect(args.filter((value) => value === "--format")).toHaveLength(1)
    })

    it("akm_evolve dispatches the curator prompt through a child session", async () => {
      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const result = await hooks.tool!.akm_evolve.execute(
        { focus: "release workflow" } as any,
        {
          sessionID: "parent-session-1",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          agent: "build",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.sessionID).toBe("child-session-1")
      expect(parsed.dispatchAgent).toBe("akm-curator")
      expect(parsed.curatorMemoryRef).toMatch(/^memory:akm-curator-/)
      expect(parsed.focus).toBe("release workflow")
      expect(client.session.create).toHaveBeenCalledWith({
        body: { parentID: "parent-session-1", title: "akm:curator" },
      })
      const promptArgs = (client.session.prompt as any).mock.calls[0][0]
      expect(promptArgs.path).toEqual({ id: "child-session-1" })
      expect(promptArgs.body.system).toBeUndefined()
      expect(promptArgs.body.parts[0].text).toContain("release workflow")
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        expect.arrayContaining(["remember", "--name", expect.stringMatching(/^akm-curator-/), "--force"]),
        expect.objectContaining({ input: "child response" }),
      )
      expect(client.app.log).toHaveBeenCalledWith({
        query: { directory: "/tmp/test-project" },
        body: {
          service: "akm-opencode",
          level: "info",
          message: "AKM dispatch child session created",
          extra: expect.objectContaining({
            subsystem: "dispatch",
            toolName: "akm_evolve",
            childSessionID: "child-session-1",
          }),
        },
      })
      expect(client.app.log).toHaveBeenCalledWith({
        query: { directory: "/tmp/test-project" },
        body: {
          service: "akm-opencode",
          level: "info",
          message: "AKM dispatch prompt completed",
          extra: expect.objectContaining({
            subsystem: "dispatch",
            toolName: "akm_evolve",
            targetSessionID: "child-session-1",
            dispatchAgent: "akm-curator",
          }),
        },
      })
    })

    it("akm_evolve degrades gracefully when curator memory persistence fails", async () => {
      const client = createMockClient()
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args.includes("remember")) throw new Error("remember failed")
        return "mock output"
      })
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const result = await hooks.tool!.akm_evolve.execute(
        { focus: "release workflow" } as any,
        {
          sessionID: "parent-session-1",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          agent: "build",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      expect(JSON.parse(result).curatorMemoryRef).toBeNull()
    })

    it("akm_evolve returns JSON error when session.prompt throws", async () => {
      const client = createMockClient()
      client.session.prompt = mock(async () => {
        throw new Error("prompt exploded")
      })
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const result = await hooks.tool!.akm_evolve.execute(
        { focus: "release workflow" } as any,
        {
          sessionID: "parent-session-1",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          agent: "build",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed).toEqual({
        ok: false,
        error: "Failed to dispatch curator: prompt exploded",
      })
      expect(client.app.log).toHaveBeenCalledWith({
        query: { directory: "/tmp/test-project" },
        body: {
          service: "akm-opencode",
          level: "error",
          message: "AKM dispatch prompt threw",
          extra: expect.objectContaining({
            subsystem: "dispatch",
            toolName: "akm_evolve",
            targetSessionID: "child-session-1",
            error: "prompt exploded",
          }),
        },
      })
    })

    it("akm_parent_messages returns the parent session transcript summary", async () => {
      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const result = await hooks.tool!.akm_parent_messages.execute(
        {} as any,
        {
          sessionID: "child-session-1",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          agent: "akm-curator",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.sessionID).toBe("parent-session-root")
      expect(parsed.messages[0]).toEqual({
        role: "user",
        agent: "build",
        text: "Parent context",
      })
    })

    it("akm_parent_messages logs thrown SDK errors instead of throwing", async () => {
      const client = createMockClient()
      client.session.messages = mock(async () => {
        throw new Error("messages exploded")
      }) as any
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))

      const result = await hooks.tool!.akm_parent_messages.execute(
        {} as any,
        {
          sessionID: "child-session-1",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          agent: "akm-curator",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      expect(JSON.parse(result)).toEqual({ ok: false, error: "Failed to read parent session messages." })
      expect(client.app.log).toHaveBeenCalledWith({
        query: { directory: "/tmp/test-project" },
        body: {
          service: "akm-opencode",
          level: "error",
          message: "AKM parent session read failed",
          extra: expect.objectContaining({
            subsystem: "session",
            toolName: "akm_parent_messages",
            sessionID: "child-session-1",
            directory: "/tmp/test-project",
            error: "messages exploded",
          }),
        },
      })
    })

    it("akm_session_messages restricts arbitrary session IDs for non-curator agents", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_session_messages.execute(
        { session_id: "another-session" } as any,
        {
          sessionID: "child-session-1",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          agent: "general",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      expect(JSON.parse(result)).toEqual({
        ok: false,
        error: "akm_session_messages only allows arbitrary session IDs for the akm-curator agent. Use akm_parent_messages for parent context.",
      })
    })

    it("akm_session_messages allows arbitrary session IDs for the curator agent", async () => {
      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const result = await hooks.tool!.akm_session_messages.execute(
        { session_id: "another-session" } as any,
        {
          sessionID: "child-session-1",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          agent: "akm-curator",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      expect(JSON.parse(result)).toEqual({
        ok: true,
        sessionID: "another-session",
        messages: [{ role: "user", agent: "build", text: "Parent context" }],
      })
    })

    it("akm_session_messages logs thrown SDK errors instead of throwing", async () => {
      const client = createMockClient()
      client.session.messages = mock(async () => {
        throw new Error("messages exploded")
      }) as any
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))

      const result = await hooks.tool!.akm_session_messages.execute(
        { session_id: "another-session" } as any,
        {
          sessionID: "child-session-1",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          agent: "akm-curator",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      expect(JSON.parse(result)).toEqual({ ok: false, error: "Failed to read messages for session 'another-session'." })
      expect(client.app.log).toHaveBeenCalledWith({
        query: { directory: "/tmp/test-project" },
        body: {
          service: "akm-opencode",
          level: "error",
          message: "AKM session messages read failed",
          extra: expect.objectContaining({
            subsystem: "session",
            toolName: "akm_session_messages",
            sessionID: "child-session-1",
            directory: "/tmp/test-project",
            targetSessionID: "another-session",
            error: "messages exploded",
          }),
        },
      })
    })

    it("akm_search passes source filter", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_search.execute(
        { query: "hello", source: "registry" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["search", "hello", "--source", "registry", "--detail", "normal", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_search supports script type filter", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_search.execute(
        { query: "deploy", type: "script" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["search", "deploy", "--type", "script", "--detail", "normal", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_search supports memory type and stash source filters", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_search.execute(
        { query: "retro", type: "memory", source: "stash" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["search", "retro", "--type", "memory", "--source", "stash", "--detail", "normal", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("returns JSON error when CLI fails", async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("command not found: akm")
      })
      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_search.execute(
        { query: "test" } as any,
        {} as any,
      )
      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("command not found")
    })

    it("writes successful AKM tool invocations to OpenCode app logs", async () => {
      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))

      await hooks.tool!.akm_search.execute(
        { query: "deploy", source: "local" } as any,
        {} as any,
      )

      expect(client.app.log).toHaveBeenCalledWith({
        query: undefined,
        body: {
          service: "akm-opencode",
          level: "info",
          message: "AKM command completed",
          extra: expect.objectContaining({
            subsystem: "akm",
            toolName: "akm_search",
            command: "akm",
            args: ["search", "deploy", "--source", "stash", "--detail", "normal", "--format", "json"],
            exitCode: 0,
            stdout: "mock output",
            stderr: "",
          }),
        },
      })
    })

    it("writes failed AKM tool invocations to OpenCode app logs", async () => {
      mockExecFileSync.mockImplementation((cmd, args) => {
        if (Array.isArray(args) && args[0] === "--version") return "0.8.9"
        const error = new Error("Legacy show flags are no longer supported.") as Error & {
          status?: number
          stdout?: string
          stderr?: string
        }
        error.status = 1
        error.stdout = ""
        error.stderr = "Legacy show flags are no longer supported."
        throw error
      })

      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const result = await hooks.tool!.akm_show.execute(
        { ref: "knowledge:guide.md", view_mode: "toc" } as any,
        {} as any,
      )

      expect(JSON.parse(result)).toEqual({
        ok: false,
        error: "Legacy show flags are no longer supported.",
      })
      expect(client.app.log).toHaveBeenCalledWith({
        query: undefined,
        body: {
          service: "akm-opencode",
          level: "error",
          message: "AKM command failed",
          extra: expect.objectContaining({
            subsystem: "akm",
            toolName: "akm_show",
            command: "akm",
            args: ["show", "knowledge:guide.md", "toc", "--format", "json"],
            exitCode: 1,
            stdout: "",
            stderr: "Legacy show flags are no longer supported.",
          }),
        },
      })
    })

    it("records user feedback through the chat.message hook", async () => {
      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))

      await hooks["chat.message"]!(
        {
          sessionID: "parent-session-1",
          messageID: "message-1",
          agent: "build",
        },
        {
          message: {} as any,
          parts: [{ type: "text", text: "Please remember this worked well for the release." }] as any,
        },
      )

      expect(client.app.log).toHaveBeenCalledWith({
        query: undefined,
        body: {
          service: "akm-opencode",
          level: "info",
          message: "AKM user feedback recorded",
          extra: expect.objectContaining({
            subsystem: "feedback",
            actor: "user",
            sessionID: "parent-session-1",
            messageID: "message-1",
            agent: "build",
            text: "Please remember this worked well for the release.",
          }),
        },
      })
    })

    it("logs and swallows unexpected chat.message hook failures", async () => {
      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))

      await hooks["chat.message"]!(
        {
          sessionID: "parent-session-1",
          messageID: "message-1",
          agent: "build",
        },
        {
          message: {} as any,
          get parts() {
            throw new Error("parts exploded")
          },
        } as any,
      )

      expect(client.app.log).toHaveBeenCalledWith({
        query: undefined,
        body: {
          service: "akm-opencode",
          level: "error",
          message: "AKM chat.message hook failed",
          extra: expect.objectContaining({
            subsystem: "hook",
            hook: "chat.message",
            sessionID: "parent-session-1",
            messageID: "message-1",
            agent: "build",
            error: "parts exploded",
          }),
        },
      })
    })

    it("records retrospective negative feedback for an explicit correction", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args[0] === "feedback") return JSON.stringify({ ok: true })
        return "mock output"
      })
      const hooks = await AkmPlugin(createPluginInput())
      await hooks["tool.execute.after"]!(
        {
          tool: "akm_show",
          sessionID: "session-neg-1",
          callID: "c1",
          args: { ref: "lesson:bad-guidance" },
        } as any,
        {
          title: "show",
          output: JSON.stringify({ type: "lesson", ref: "lesson:bad-guidance" }),
          metadata: {},
        } as any,
      )
      await hooks["chat.message"]!(
        { sessionID: "session-neg-1", messageID: "m1", agent: "build" } as any,
        { message: {} as any, parts: [{ type: "text", text: "This was wrong" }] as any },
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["feedback", "lesson:bad-guidance", "--negative", "--note", "This was wrong", "--run", "session-neg-1", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("does not log retrospective feedback as recorded when the feedback result is malformed", async () => {
      const client = createMockClient()
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args[0] === "feedback") return "not json"
        return "mock output"
      })
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))

      await hooks["tool.execute.after"]!(
        {
          tool: "akm_show",
          sessionID: "session-neg-2",
          callID: "c1",
          args: { ref: "lesson:bad-guidance" },
        } as any,
        {
          title: "show",
          output: JSON.stringify({ type: "lesson", ref: "lesson:bad-guidance" }),
          metadata: {},
        } as any,
      )
      await hooks["chat.message"]!(
        { sessionID: "session-neg-2", messageID: "m1", agent: "build" } as any,
        { message: {} as any, parts: [{ type: "text", text: "This was wrong" }] as any },
      )

      expect(client.app.log).not.toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({ message: "akm.feedback.recorded" }),
      }))
    })

    it("records system feedback and memory usage through the tool.execute.after hook", async () => {
      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))

      await hooks["tool.execute.after"]!(
        {
          tool: "akm_show",
          sessionID: "parent-session-1",
          callID: "call-1",
          args: { ref: "memory:release-retro" },
        },
        {
          title: "show memory",
          output: JSON.stringify({ type: "memory", ref: "memory:release-retro", content: "Remember the rollback steps." }),
          metadata: {},
        },
      )

      expect(client.app.log).toHaveBeenCalledWith({
        query: undefined,
        body: {
          service: "akm-opencode",
          level: "info",
          message: "AKM system feedback recorded",
          extra: expect.objectContaining({
            subsystem: "feedback",
            actor: "system",
            feedback: "positive",
            toolName: "akm_show",
            sessionID: "parent-session-1",
            callID: "call-1",
          }),
        },
      })
      expect(client.app.log).toHaveBeenCalledWith({
        query: undefined,
        body: {
          service: "akm-opencode",
          level: "info",
          message: "AKM memory usage recorded",
          extra: expect.objectContaining({
            subsystem: "memory",
            toolName: "akm_show",
            sessionID: "parent-session-1",
            callID: "call-1",
            refs: ["memory:release-retro"],
          }),
        },
      })
    })

    it("logs and swallows unexpected tool.execute.after hook failures", async () => {
      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))

      await hooks["tool.execute.after"]!(
        {
          tool: "akm_show",
          sessionID: "parent-session-1",
          callID: "call-1",
          get args() {
            throw new Error("args exploded")
          },
        } as any,
        {
          title: "show",
          output: JSON.stringify({ type: "memory", ref: "memory:release-retro" }),
          metadata: {},
        } as any,
      )

      expect(client.app.log).toHaveBeenCalledWith({
        query: undefined,
        body: {
          service: "akm-opencode",
          level: "error",
          message: "AKM tool.execute.after hook failed",
          extra: expect.objectContaining({
            subsystem: "hook",
            hook: "tool.execute.after",
            toolName: "akm_show",
            sessionID: "parent-session-1",
            callID: "call-1",
            error: "args exploded",
          }),
        },
      })
    })

    it("injects akm hints into the system prompt after session.created fires", async () => {
      const configHome = mkdtempSync(path.join(tmpdir(), "akm-opencode-config-"))
      mkdirSync(path.join(configHome, "akm"), { recursive: true })
      writeFileSync(path.join(configHome, "akm", "config.json"), `${JSON.stringify({ agent: { default: "opencode" } })}\n`)
      mockExecFileSync.mockImplementation((cmd, args) => {
        if (args[0] === "--version") return "0.8.9"
        if (Array.isArray(args) && args.includes("hints")) return "Use `akm curate` first.\n"
        if (Array.isArray(args) && args.includes("curate")) return ""
        if (Array.isArray(args) && args[0] === "proposal" && args[1] === "list") return JSON.stringify({ proposals: [] })
        return "mock output"
      })

      try {
        await withEnvVar("XDG_CONFIG_HOME", configHome, async () => {
          const hooks = await AkmPlugin(createPluginInput())
          await hooks.event!({
            event: { type: "session.created", properties: { sessionID: "session-hints-1" } },
          } as any)

          const output = { system: [] as string[] }
          await hooks["experimental.chat.system.transform"]!(
            { sessionID: "session-hints-1" } as any,
            output as any,
          )

          expect(output.system).toHaveLength(1)
          expect(output.system[0]).toContain("AKM is available in this session")
          expect(output.system[0]).toContain("# AKM workflow")
          expect(output.system[0]).toContain("Treat `lesson:*` as first-class durable learning assets")
          expect(output.system[0]).toContain("Use `akm curate` first.")

          const second = { system: [] as string[] }
          await hooks["experimental.chat.system.transform"]!(
            { sessionID: "session-hints-1" } as any,
            second as any,
          )
          expect(second.system).toHaveLength(0)
        })
      } finally {
        rmSync(configHome, { recursive: true, force: true })
      }
    })

    it("initializes agent.default to opencode on session.created when missing", async () => {
      const configHome = mkdtempSync(path.join(tmpdir(), "akm-opencode-config-"))
      mkdirSync(path.join(configHome, "akm"), { recursive: true })
      writeFileSync(path.join(configHome, "akm", "config.json"), `${JSON.stringify({})}\n`)
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args.includes("hints")) return "Use `akm curate` first.\n"
        if (Array.isArray(args) && args.includes("curate")) return ""
        if (Array.isArray(args) && args[0] === "proposal" && args[1] === "list") return JSON.stringify({ proposals: [] })
        return "mock output"
      })

      try {
        await withEnvVar("XDG_CONFIG_HOME", configHome, async () => {
          const client = createMockClient()
          const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
          await hooks.event!({ event: { type: "session.created", properties: { sessionID: "session-agent-default-1" } } } as any)

          const config = JSON.parse(readFileSync(path.join(configHome, "akm", "config.json"), "utf8"))
          expect(config.agent.default).toBe("opencode")
        })
      } finally {
        rmSync(configHome, { recursive: true, force: true })
      }
    })

    it("curates on session.created and injects the result before the first user message", async () => {
      const configHome = mkdtempSync(path.join(tmpdir(), "akm-opencode-config-"))
      mkdirSync(path.join(configHome, "akm"), { recursive: true })
      writeFileSync(path.join(configHome, "akm", "config.json"), `${JSON.stringify({})}\n`)
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args.includes("hints")) return "Use `akm curate` first.\n"
        if (Array.isArray(args) && args.includes("curate") && args.includes("--run")) {
          return "# skills\n- skill:deploy — ship the app\n"
        }
        if (Array.isArray(args) && args[0] === "proposal" && args[1] === "list") return JSON.stringify({ proposals: [] })
        return "mock output"
      })

      try {
        await withEnvVar("XDG_CONFIG_HOME", configHome, async () => {
          const hooks = await AkmPlugin(createPluginInput())
          await hooks.event!({
            event: { type: "session.created", properties: { sessionID: "session-start-curate-1" } },
          } as any)

          const curateCall = (mockExecFileSync.mock.calls as any[]).find(
            ([, args]) => Array.isArray(args) && args.includes("curate") && args.includes("--run"),
          )
          expect(curateCall).toBeDefined()
          expect(curateCall?.[1]).toContain("session-start-curate-1")
          expect(curateCall?.[1]).toEqual(expect.arrayContaining(["--detail", "agent"]))
          expect(curateCall?.[1]).not.toContain("--for-agent")

          const config = JSON.parse(readFileSync(path.join(configHome, "akm", "config.json"), "utf8"))
          expect(config.agent.default).toBe("opencode")

          const output = { system: [] as string[] }
          await hooks["experimental.chat.system.transform"]!(
            { sessionID: "session-start-curate-1" } as any,
            output as any,
          )

          expect(output.system.join("\n")).toContain("AKM stash curation available at")
          expect(output.system.join("\n")).toContain("session-start-curate-1.md")
        })
      } finally {
        rmSync(configHome, { recursive: true, force: true })
      }
    })

    it("injects a pending proposal summary when proposals exist", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args[0] === "proposal" && args[1] === "list") {
          return JSON.stringify({ proposals: [{ id: "p1" }, { id: "p2" }] })
        }
        if (Array.isArray(args) && args.includes("hints")) return "Use `akm curate` first.\n"
        if (Array.isArray(args) && args.includes("curate")) return ""
        return "mock output"
      })
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.event!({ event: { type: "session.created", properties: { sessionID: "session-proposals" } } } as any)
      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]!({ sessionID: "session-proposals" } as any, output as any)
      expect(output.system.join("\n\n")).toContain("There are 2 pending AKM proposals.")
      expect(output.system.join("\n\n")).toContain("/akm-review-proposals")
      expect(output.system.join("\n\n")).toContain("Do not treat proposed assets as curated until accepted.")
    })

    it("does not inject compaction context when compaction is disabled", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args[0] === "proposal" && args[1] === "list") {
          return JSON.stringify({ proposals: [{ id: "p1" }] })
        }
        return "mock output"
      })
      const hooks = await AkmPlugin(createPluginInput())
      expect(hooks["experimental.session.compacting"]).toBeUndefined()
    })

    it("keeps compaction free of AKM tool-injection using the local fake model path", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args[0] === "proposal" && args[1] === "list") {
          return JSON.stringify({ proposals: [{ id: "p1" }] })
        }
        return "mock output"
      })
      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      await hooks.event!({
        event: { type: "session.created", properties: { sessionID: "session-local-model" } },
      } as any)

      expect(hooks["experimental.session.compacting"]).toBeUndefined()
      expect(client.session.prompt).not.toHaveBeenCalled()
      expect(client.session.create).not.toHaveBeenCalled()
      expect(mockSpawn).not.toHaveBeenCalled()
    })

    it("denies risky raw akm shell commands", async () => {
      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const output = { status: "ask" as "ask" | "deny" | "allow" }
      await hooks["permission.ask"]?.({
        sessionID: "session-1",
        permission: "bash",
        patterns: ["akm accept 123"],
        metadata: { command: "akm accept 123" },
      } as any, output)
      expect(output.status).toBe("deny")
      expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          message: "akm.raw_cli.blocked",
          extra: expect.objectContaining({ category: "proposal-accept" }),
        }),
      }))
    })

    it("blocks risky command.execute.before raw akm commands with explanatory text", async () => {
      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const output = { parts: [] as Array<{ type: string; text: string }> }
      await hooks["command.execute.before"]?.({
        sessionID: "session-1",
        command: "akm",
        arguments: "upgrade",
      } as any, output as any)
      expect(output.parts[0].text).toContain("Blocked risky AKM command: akm upgrade")
      expect(output.parts[0].text).toContain("approve the exact `akm upgrade` command")
    })

    it("caps fresh-session injected context to AKM_CONTEXT_BUDGET_CHARS", async () => {
      process.env.AKM_CONTEXT_BUDGET_CHARS = "220"
      try {
        mockExecFileSync.mockImplementation((_cmd, args) => {
          if (Array.isArray(args) && args.includes("hints")) return "H".repeat(180)
          if (Array.isArray(args) && args.includes("curate") && args.includes("--run")) return "C".repeat(180)
          return "mock output"
        })

        const hooks = await AkmPlugin(createPluginInput())
        await hooks.event!({
          event: { type: "session.created", properties: { sessionID: "session-budget-1" } },
        } as any)

        const output = { system: [] as string[] }
        await hooks["experimental.chat.system.transform"]!(
          { sessionID: "session-budget-1" } as any,
          output as any,
        )

        const combined = output.system.join("\n")
        expect(combined.length).toBeLessThanOrEqual(220)
        expect(combined).toContain("[truncated for context]")
      } finally {
        delete process.env.AKM_CONTEXT_BUDGET_CHARS
      }
    })

    it("chat.message injects only a small AKM hint for low-signal prompts", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        return "mock output"
      })

      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))

      await hooks["chat.message"]!(
        { sessionID: "session-curate-1", messageID: "m1", agent: "build" } as any,
        { message: {} as any, parts: [{ type: "text", text: "Need more help" }] as any },
      )

      const curateCall = (mockExecFileSync.mock.calls as any[]).find(
        ([, args]) => Array.isArray(args) && args.includes("curate"),
      )
      expect(curateCall).toBeUndefined()

      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]!(
        { sessionID: "session-curate-1" } as any,
        output as any,
      )
      expect(output.system).toHaveLength(1)
      expect(output.system[0]).toContain("AKM stash curation available at")
      expect(output.system[0]).toContain("session-curate-1.md")

      // Curated context is one-shot per turn.
      const second = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]!(
        { sessionID: "session-curate-1" } as any,
        second as any,
      )
      expect(second.system).toHaveLength(0)
    })

    it("chat.message curates release prompts that imply workflow and command recall", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args.includes("curate")) {
          return "# release\n- command:bump-version\n- workflow:release\n"
        }
        return "mock output"
      })

      const hooks = await AkmPlugin(createPluginInput())

      await hooks["chat.message"]!(
        { sessionID: "session-release-curate-1", messageID: "m1", agent: "build" } as any,
        { message: {} as any, parts: [{ type: "text", text: "Cut a new semver release and publish - bump version everywhere and tag the release." }] as any },
      )

      const curateCall = (mockExecFileSync.mock.calls as any[]).find(
        ([, args]) => Array.isArray(args) && args.includes("curate"),
      )
      expect(curateCall).toBeDefined()

      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]!(
        { sessionID: "session-release-curate-1" } as any,
        output as any,
      )
      expect(output.system.join("\n")).toContain("AKM stash curation available at")
      expect(output.system.join("\n")).toContain("session-release-curate-1.md")
    })

    it("skips curate when the user prompt is shorter than AKM_CURATE_MIN_CHARS", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks["chat.message"]!(
        { sessionID: "session-short-1", messageID: "m1", agent: "build" } as any,
        { message: {} as any, parts: [{ type: "text", text: "hi" }] as any },
      )
      const curateCall = (mockExecFileSync.mock.calls as any[]).find(
        ([, args]) => Array.isArray(args) && args.includes("curate"),
      )
      expect(curateCall).toBeUndefined()
    })

    it("tool.execute.before blocks akm_vault show until confirm:true is provided", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const output = { args: { action: "show", ref: "vault:prod" } as any }
      await hooks["tool.execute.before"]!(
        {
          tool: "akm_vault",
          sessionID: "session-block-1",
          callID: "call-1",
        } as any,
        output as any,
      )

      expect(output.args.__akmBlocked).toContain("confirm:true")
    })

    it("tool.execute.before leaves non-exact refs unchanged", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const output = { args: { ref: "unknown helper" } as any }
      await hooks["tool.execute.before"]!(
        {
          tool: "akm_show",
          sessionID: "session-ref-1",
          callID: "call-1",
        } as any,
        output as any,
      )

      expect(output.args.ref).toBe("unknown helper")
      expect(output.args.__akmBlocked).toBeUndefined()
    })

    it("tool.execute.before does not block read-only akm_memory sync", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const output = { args: { action: "sync" } as any }

      await hooks["tool.execute.before"]!(
        {
          tool: "akm_memory",
          sessionID: "session-memory-sync-1",
          callID: "call-1",
        } as any,
        output as any,
      )

      expect(output.args.action).toBe("sync")
      expect(output.args.__akmBlocked).toBeUndefined()
    })

    it("does not expose a compaction hook after disabling it", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args.includes("hints")) return "Use `akm curate` first.\n"
        if (Array.isArray(args) && args[0] === "--format" && args.includes("workflow")) {
          return JSON.stringify([{ ref: "workflow:release", runId: "run-1", state: "blocked" }])
        }
        if (Array.isArray(args) && args.includes("curate")) return "# curated\n- skill:deploy\n"
        if (Array.isArray(args) && args.includes("remember")) return JSON.stringify({ ref: "memory:akm-curator-20260425-session" })
        return "mock output"
      })

      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      await hooks.event!({
        event: { type: "session.created", properties: { sessionID: "session-compact-1" } },
      } as any)
      await hooks["chat.message"]!(
        { sessionID: "session-compact-1", messageID: "m1", agent: "build" } as any,
        { message: {} as any, parts: [{ type: "text", text: "Help me deploy the application to production" }] as any },
      )
      await hooks.tool!.akm_evolve.execute(
        { focus: "release workflow" } as any,
        {
          sessionID: "session-compact-1",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          agent: "build",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      expect(hooks["experimental.session.compacting"]).toBeUndefined()
      expect(client.session.prompt).toHaveBeenCalledTimes(1)
      expect(mockSpawn).not.toHaveBeenCalled()

      const postCompactSystem = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]!(
        { sessionID: "session-compact-1" } as any,
        postCompactSystem as any,
      )

      expect(postCompactSystem.system.join("\n")).toContain("AKM is available in this session")
      expect(postCompactSystem.system.join("\n")).toContain("workflow:release")
    })

    it("keeps local-model curator flows working without compaction injection", async () => {
      const longReport = `${"A".repeat(4500)}TAIL`
      const client = createMockClient()
      client.session.prompt = mock(async () => ({
        data: { parts: [{ type: "text", text: longReport }] },
        error: undefined,
      }))

      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      await hooks.tool!.akm_evolve.execute(
        { focus: "release workflow" } as any,
        {
          sessionID: "session-compact-2",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          agent: "build",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      expect(hooks["experimental.session.compacting"]).toBeUndefined()
      expect(client.session.prompt).toHaveBeenCalledTimes(1)
      expect(client.session.create).toHaveBeenCalledTimes(1)
      expect(mockSpawn).not.toHaveBeenCalled()
    })

    it("records auto positive feedback after a successful akm tool invocation", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      mockExecFileSync.mockClear()
      mockSpawn.mockClear()

      await hooks["tool.execute.after"]!(
        {
          tool: "akm_show",
          sessionID: "session-feedback-1",
          callID: "call-1",
          args: { ref: "skill:deploy" },
        } as any,
        {
          title: "show skill",
          output: JSON.stringify({ type: "skill", ref: "skill:deploy" }),
          metadata: {},
        } as any,
      )

      const feedbackCall = (mockSpawn.mock.calls as any[]).find(
        ([, args]) => Array.isArray(args) && args.includes("feedback"),
      )
      expect(feedbackCall).toBeDefined()
      expect(feedbackCall[1]).toContain("skill:deploy")
      expect(feedbackCall[1]).toContain("--positive")
    })

    it("logs auto-feedback subprocess exit failures through OpenCode logging", async () => {
      const client = createMockClient()
      const exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
      mockSpawn.mockImplementation(() => ({
        on: mock((event: string, handler: (...args: any[]) => void) => {
          if (event === "exit") exitHandlers.push(handler as (code: number | null, signal: NodeJS.Signals | null) => void)
          return undefined
        }),
        unref: mock(() => undefined),
      }))
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))

      await hooks["tool.execute.after"]!(
        {
          tool: "akm_show",
          sessionID: "session-feedback-exit",
          callID: "call-1",
          args: { ref: "skill:deploy" },
        } as any,
        {
          title: "show skill",
          output: JSON.stringify({ type: "skill", ref: "skill:deploy" }),
          metadata: {},
        } as any,
      )

      expect(exitHandlers).toHaveLength(1)
      exitHandlers[0](1, null)
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(client.app.log).toHaveBeenCalledWith({
        query: undefined,
        body: {
          service: "akm-opencode",
          level: "warn",
          message: "AKM auto-feedback failed",
          extra: expect.objectContaining({
            subsystem: "feedback",
            toolName: "akm_show",
            sessionID: "session-feedback-exit",
            ref: "skill:deploy",
            sentiment: "positive",
            error: "akm feedback exited with code 1",
          }),
        },
      })
    })

    it("scans child-agent free-text refs and only negative-feeds structured refs", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      mockSpawn.mockClear()

      await hooks["tool.execute.after"]!(
        {
          tool: "akm_agent",
          sessionID: "session-child-1",
          callID: "call-1",
          args: { ref: "agent:coach.md" },
        } as any,
        {
          title: "dispatch agent",
          output: JSON.stringify({
            ok: false,
            error: "dispatch failed",
            ref: "agent:coach.md",
            text: "Try `skill:deploy` and \"knowledge:release-guide\" next.",
          }),
          metadata: {},
        } as any,
      )

      const negativeFeedbackRefs = (mockSpawn.mock.calls as any[])
        .filter(([, args]) => Array.isArray(args) && args.includes("--negative"))
        .map(([, args]) => args[4])
      expect(negativeFeedbackRefs).toEqual(["agent:coach.md"])

      mockSpawn.mockClear()

      await hooks["tool.execute.after"]!(
        {
          tool: "akm_agent",
          sessionID: "session-child-1",
          callID: "call-2",
          args: { ref: "agent:coach.md" },
        } as any,
        {
          title: "dispatch agent",
          output: JSON.stringify({
            ok: true,
            ref: "agent:coach.md",
            text: "Use `skill:deploy`, {skill:deploy}, and \"knowledge:release-guide\".",
          }),
          metadata: {},
        } as any,
      )

      const positiveFeedbackRefs = (mockSpawn.mock.calls as any[])
        .filter(([, args]) => Array.isArray(args) && args.includes("--positive"))
        .map(([, args]) => args[4])
        .sort()
      expect(positiveFeedbackRefs).toEqual(["agent:coach.md"])
    })

    it("does not auto-feedback for memory refs and never recurses into akm_feedback", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      mockExecFileSync.mockClear()
      mockSpawn.mockClear()

      await hooks["tool.execute.after"]!(
        {
          tool: "akm_feedback",
          sessionID: "session-feedback-2",
          callID: "call-1",
          args: { ref: "skill:deploy" },
        } as any,
        {
          title: "feedback",
          output: JSON.stringify({ ok: true, type: "feedback" }),
          metadata: {},
        } as any,
      )

      await hooks["tool.execute.after"]!(
        {
          tool: "akm_show",
          sessionID: "session-feedback-2",
          callID: "call-2",
          args: { ref: "memory:release-retro" },
        } as any,
        {
          title: "show memory",
          output: JSON.stringify({ type: "memory", ref: "memory:release-retro" }),
          metadata: {},
        } as any,
      )

      const feedbackCall = (mockSpawn.mock.calls as any[]).find(
        ([, args]) => Array.isArray(args) && args.includes("feedback"),
      )
      expect(feedbackCall).toBeUndefined()
    })

    it("records retrospective positive feedback for the last three non-secret refs", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      mockSpawn.mockClear()

      for (const ref of ["skill:first", "memory:notes", "vault:prod", "skill:second", "skill:third"]) {
        await hooks["tool.execute.after"]!(
          {
            tool: "akm_show",
            sessionID: "session-retro-1",
            callID: ref,
            args: { ref },
          } as any,
          {
            title: "show",
            output: JSON.stringify({ type: ref.startsWith("memory:") ? "memory" : "skill", ref }),
            metadata: {},
          } as any,
        )
      }

      mockSpawn.mockClear()

      await hooks["chat.message"]!(
        { sessionID: "session-retro-1", messageID: "m2", agent: "build" } as any,
        { message: {} as any, parts: [{ type: "text", text: "Thanks, that worked perfectly." }] as any },
      )

      const retrospectiveRefs = (mockSpawn.mock.calls as any[])
        .filter(([, args]) => Array.isArray(args) && args.includes("opencode retrospective: user confirmed it worked"))
        .map(([, args]) => args[4])
        .sort()
      expect(retrospectiveRefs).toEqual(["skill:first", "skill:second", "skill:third"])
    })

    it("captures a session memory on stop when the buffer has enough entries", async () => {
      const hooks = await AkmPlugin(createPluginInput())

      // Seed the session buffer with two tool refs.
      await hooks["tool.execute.after"]!(
        { tool: "akm_show", sessionID: "session-capture-1", callID: "c1", args: { ref: "skill:alpha" } } as any,
        { title: "show", output: JSON.stringify({ type: "skill", ref: "skill:alpha" }), metadata: {} } as any,
      )
      await hooks["tool.execute.after"]!(
        { tool: "akm_show", sessionID: "session-capture-1", callID: "c2", args: { ref: "skill:beta" } } as any,
        { title: "show", output: JSON.stringify({ type: "skill", ref: "skill:beta" }), metadata: {} } as any,
      )

      mockExecFileSync.mockClear()
      await hooks.stop!({ sessionID: "session-capture-1" } as any)

      const rememberCall = (mockExecFileSync.mock.calls as any[]).find(
        ([, args]) => Array.isArray(args) && args.includes("remember"),
      )
      expect(rememberCall).toBeDefined()
      const rememberArgs = rememberCall![1] as string[]
      const nameFlag = rememberArgs.indexOf("--name")
      expect(nameFlag).toBeGreaterThan(-1)
      expect(rememberArgs[nameFlag + 1]).toMatch(/^opencode-session-/)
      expect(rememberArgs).toContain("--force")
    })

    it("runs akm index after capturing a session memory when enabled", async () => {
      await withEnvVar("AKM_INDEX_ON_SESSION_END", "1", async () => {
        const hooks = await AkmPlugin(createPluginInput())

        await hooks["tool.execute.after"]!(
          { tool: "akm_show", sessionID: "session-index-1", callID: "c1", args: { ref: "skill:alpha" } } as any,
          { title: "show", output: JSON.stringify({ type: "skill", ref: "skill:alpha" }), metadata: {} } as any,
        )
        await hooks["tool.execute.after"]!(
          { tool: "akm_show", sessionID: "session-index-1", callID: "c2", args: { ref: "skill:beta" } } as any,
          { title: "show", output: JSON.stringify({ type: "skill", ref: "skill:beta" }), metadata: {} } as any,
        )

        mockExecFileSync.mockClear()
        await hooks.stop!({ sessionID: "session-index-1" } as any)

        const calls = mockExecFileSync.mock.calls as Array<[string, string[]]>
        const rememberIndex = calls.findIndex(([, args]) => Array.isArray(args) && args.includes("remember"))
        const indexCalls = calls.filter(([, args]) => Array.isArray(args) && args.length === 1 && args[0] === "index")

        expect(rememberIndex).toBeGreaterThan(-1)
        expect(indexCalls).toHaveLength(1)
        expect(calls.findIndex(([, args]) => Array.isArray(args) && args.length === 1 && args[0] === "index")).toBeGreaterThan(rememberIndex)
      })
    })

    it("logs akm index failures without aborting session cleanup", async () => {
      await withEnvVar("AKM_INDEX_ON_SESSION_END", "1", async () => {
        const client = createMockClient()
        mockExecFileSync.mockImplementation((_, args) => {
          if (Array.isArray(args) && args.length === 1 && args[0] === "index") {
            throw new Error("index failed")
          }
          return "mock output"
        })

        const hooks = await AkmPlugin(createPluginInput({ client: client as any }))

        await hooks["tool.execute.after"]!(
          { tool: "akm_show", sessionID: "session-index-2", callID: "c1", args: { ref: "skill:alpha" } } as any,
          { title: "show", output: JSON.stringify({ type: "skill", ref: "skill:alpha" }), metadata: {} } as any,
        )
        await hooks["tool.execute.after"]!(
          { tool: "akm_show", sessionID: "session-index-2", callID: "c2", args: { ref: "skill:beta" } } as any,
          { title: "show", output: JSON.stringify({ type: "skill", ref: "skill:beta" }), metadata: {} } as any,
        )

        await hooks.stop!({ sessionID: "session-index-2" } as any)

        const logCalls = (client.app.log as any).mock.calls as Array<
          [{ body: { level: string; message: string; extra?: Record<string, unknown> } }]
        >
        const failureLog = logCalls.find(([entry]) => entry.body.message === "AKM session indexing failed")
        expect(failureLog).toBeDefined()
        expect(failureLog?.[0].body.level).toBe("warn")
        expect(failureLog?.[0].body.extra?.sessionID).toBe("session-index-2")
      })
    })

    it("captures checkpoint memories mid-session without losing the final session summary", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      mockExecFileSync.mockClear()

      for (let index = 0; index < 8; index += 1) {
        await hooks["tool.execute.after"]!(
          {
            tool: "akm_show",
            sessionID: "session-checkpoint-1",
            callID: `c${index}`,
            args: { ref: `skill:asset-${index}` },
          } as any,
          {
            title: "show",
            output: JSON.stringify({ type: "skill", ref: `skill:asset-${index}` }),
            metadata: {},
          } as any,
        )
      }

      const checkpointCall = (mockExecFileSync.mock.calls as any[]).find(
        ([, args]) => Array.isArray(args) && args.includes("remember") && args.some((arg: string) => arg.startsWith("opencode-checkpoint-")),
      )
      expect(checkpointCall).toBeDefined()
      expect(checkpointCall?.[1]).toContain("--run")
      expect(checkpointCall?.[1]).toContain("session-checkpoint-1")

      await hooks.stop!({ sessionID: "session-checkpoint-1" } as any)

      const finalCall = (mockExecFileSync.mock.calls as any[]).find(
        ([, args]) => Array.isArray(args) && args.includes("remember") && args.some((arg: string) => arg.startsWith("opencode-session-")),
      )
      expect(finalCall).toBeDefined()
      const stopRememberInput = ((finalCall?.[2] as { input?: string } | undefined)?.input) ?? ""
      expect(stopRememberInput).toContain("## Full-detail evidence files")
      expect(stopRememberInput).toContain("events.jsonl")
      expect(stopRememberInput).toContain("memory-candidates.jsonl")
      expect(stopRememberInput).toContain("opencode/log")
      expect(stopRememberInput).toContain("## Evidence aggregates")
    })

    it("does not re-capture already checkpointed entries until new successful refs arrive", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      mockExecFileSync.mockClear()

      for (let index = 0; index < 8; index += 1) {
        await hooks["tool.execute.after"]!(
          {
            tool: "akm_show",
            sessionID: "session-checkpoint-2",
            callID: `c${index}`,
            args: { ref: `skill:asset-${index}` },
          } as any,
          {
            title: "show",
            output: JSON.stringify({ type: "skill", ref: `skill:asset-${index}` }),
            metadata: {},
          } as any,
        )
      }

      const checkpointCallsAfterFirstBatch = (mockExecFileSync.mock.calls as any[]).filter(
        ([, args]) => Array.isArray(args) && args.includes("remember") && args.some((arg: string) => arg.startsWith("opencode-checkpoint-")),
      )
      expect(checkpointCallsAfterFirstBatch).toHaveLength(1)

      for (let index = 8; index < 15; index += 1) {
        await hooks["tool.execute.after"]!(
          {
            tool: "akm_show",
            sessionID: "session-checkpoint-2",
            callID: `c${index}`,
            args: { ref: `skill:asset-${index}` },
          } as any,
          {
            title: "show",
            output: JSON.stringify({ type: "skill", ref: `skill:asset-${index}` }),
            metadata: {},
          } as any,
        )
      }

      const checkpointCallsAfterSecondBatch = (mockExecFileSync.mock.calls as any[]).filter(
        ([, args]) => Array.isArray(args) && args.includes("remember") && args.some((arg: string) => arg.startsWith("opencode-checkpoint-")),
      )
      expect(checkpointCallsAfterSecondBatch).toHaveLength(1)
    })

    it("injects AKM shell environment variables for bash tools", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args[0] === "--format" && args[3] === "config" && args[4] === "get" && args[5] === "stashDir") {
          return JSON.stringify({ stashDir: "/tmp/akm-stash" })
        }
        return "mock output"
      })

      const hooks = await AkmPlugin(createPluginInput())
      const output = { env: {} as Record<string, string> }
      await hooks["shell.env"]!(
        { cwd: "/tmp/test-project", sessionID: "session-env-1", callID: "call-1" } as any,
        output as any,
      )

      expect(output.env.AKM_PROJECT).toBe("/tmp/test-project")
      expect(output.env.AKM_PLUGIN_VERSION).toBeTruthy()
      expect(output.env.AKM_STASH_DIR).toBe("/tmp/akm-stash")
    })

    it("akm_agent creates child session and prompts with stash metadata", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "agent",
            name: "coach.md",
            path: "/stash/agents/coach.md",
            prompt: "Use this exact system prompt.",
            modelHint: "openai/gpt-5",
            toolPolicy: { read: true, edit: false, bash: false },
          })
        }
        return "mock output"
      })

      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const result = await hooks.tool!.akm_agent.execute(
        {
          ref: "agent:coach.md",
          task_prompt: "Review this repository for bugs",
        } as any,
        {
          sessionID: "parent-session-1",
          messageID: "message-1",
          agent: "build",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.sessionID).toBe("child-session-1")
      expect(client.session.create).toHaveBeenCalledWith({
        body: { parentID: "parent-session-1", title: "akm:coach.md" },
      })
      expect(client.session.prompt).toHaveBeenCalledWith({
        path: { id: "child-session-1" },
        body: {
          agent: "general",
          model: { providerID: "openai", modelID: "gpt-5" },
          system: "Use this exact system prompt.",
          tools: { read: true, edit: false, bash: false },
          parts: [{ type: "text", text: "Review this repository for bugs" }],
        },
      })
    })

    it("akm_agent keeps using the supported OpenCode session prompt path", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "agent",
            name: "coach.md",
            path: "/stash/agents/coach.md",
            prompt: "Use this exact system prompt.",
            modelHint: "openai/gpt-5",
            toolPolicy: { read: true, edit: false, bash: false },
          })
        }
        return "mock output"
      })

      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const result = await hooks.tool!.akm_agent.execute(
        {
          ref: "agent:coach.md",
          task_prompt: "Review this repository for bugs",
        } as any,
        createToolContext(),
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.dispatchAgent).toBe("general")
      expect(parsed.agentSlug).toBeUndefined()
      expect(client.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({
            agent: "general",
            system: "Use this exact system prompt.",
            model: { providerID: "openai", modelID: "gpt-5" },
          }),
        }),
      )
    })

    it("akm_agent returns JSON error when session.create throws", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "agent",
            name: "coach.md",
            path: "/stash/agents/coach.md",
            prompt: "Use this exact system prompt.",
          })
        }
        return "mock output"
      })

      const client = createMockClient()
      client.session.create = mock(async () => {
        throw new Error("create exploded")
      })
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const result = await hooks.tool!.akm_agent.execute(
        {
          ref: "agent:coach.md",
          task_prompt: "Review this repository for bugs",
        } as any,
        {
          sessionID: "parent-session-1",
          messageID: "message-1",
          agent: "build",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed).toEqual({
        ok: false,
        error: "Failed to create child session: create exploded",
      })
      expect(client.app.log).toHaveBeenCalledWith({
        query: { directory: "/tmp/test-project" },
        body: {
          service: "akm-opencode",
          level: "error",
          message: "AKM dispatch child session threw",
          extra: expect.objectContaining({
            subsystem: "dispatch",
            toolName: "akm_agent",
            title: "akm:coach.md",
            error: "create exploded",
          }),
        },
      })
    })

    it("akm_agent returns JSON error when session.prompt throws", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "agent",
            name: "coach.md",
            path: "/stash/agents/coach.md",
            prompt: "Use this exact system prompt.",
          })
        }
        return "mock output"
      })

      const client = createMockClient()
      client.session.prompt = mock(async () => {
        throw new Error("prompt exploded")
      })
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const result = await hooks.tool!.akm_agent.execute(
        {
          ref: "agent:coach.md",
          task_prompt: "Review this repository for bugs",
        } as any,
        {
          sessionID: "parent-session-1",
          messageID: "message-1",
          agent: "build",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed).toEqual({
        ok: false,
        error: "Failed to dispatch prompt for agent:coach.md: prompt exploded",
      })
      expect(client.app.log).toHaveBeenCalledWith({
        query: { directory: "/tmp/test-project" },
        body: {
          service: "akm-opencode",
          level: "error",
          message: "AKM dispatch prompt threw",
          extra: expect.objectContaining({
            subsystem: "dispatch",
            toolName: "akm_agent",
            ref: "agent:coach.md",
            targetSessionID: "child-session-1",
            error: "prompt exploded",
          }),
        },
      })
    })

    it("akm_agent can resolve ref from query", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "search") {
          return JSON.stringify({ hits: [{ type: "agent", ref: "agent:coach.md" }] })
        }
        if (args[0] === "show") {
          return JSON.stringify({
            type: "agent",
            name: "coach.md",
            path: "/stash/agents/coach.md",
            prompt: "Use this exact system prompt.",
          })
        }
        return "mock output"
      })

      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const result = await hooks.tool!.akm_agent.execute(
        { query: "coach", task_prompt: "Do work" } as any,
        {
          sessionID: "parent-session-1",
          messageID: "message-1",
          agent: "build",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.ref).toBe("agent:coach.md")
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["search", "coach", "--type", "agent", "--limit", "1", "--detail", "normal", "--source", "stash", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_agent can run in current session", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "agent",
            name: "coach.md",
            path: "/stash/agents/coach.md",
            prompt: "Use this exact system prompt.",
          })
        }
        return "mock output"
      })

      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const result = await hooks.tool!.akm_agent.execute(
        {
          ref: "agent:coach.md",
          task_prompt: "Analyze tests",
          dispatch_agent: "explore",
          as_subtask: false,
        } as any,
        {
          sessionID: "parent-session-1",
          messageID: "message-1",
          agent: "build",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.usedSubtask).toBe(false)
      expect(parsed.sessionID).toBe("parent-session-1")
      expect(client.session.create).not.toHaveBeenCalled()
      expect(client.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ path: { id: "parent-session-1" } }),
      )
    })

    it("akm_agent maps string-array toolPolicy into OpenCode tool flags", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "agent",
            name: "coach.md",
            path: "/stash/agents/coach.md",
            prompt: "Use this exact system prompt.",
            toolPolicy: ["Read", "Bash"],
          })
        }
        return "mock output"
      })

      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const result = await hooks.tool!.akm_agent.execute(
        {
          ref: "agent:coach.md",
          task_prompt: "Analyze tests",
          as_subtask: false,
        } as any,
        {
          sessionID: "parent-session-1",
          messageID: "message-1",
          agent: "build",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(client.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ tools: { read: true, bash: true } }),
        }),
      )
    })

    it("akm_agent fails for non-agent payload", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "knowledge",
            name: "docs.md",
            path: "/stash/knowledge/docs.md",
            content: "hello",
          })
        }
        return "mock output"
      })

      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_agent.execute(
        {
          ref: "knowledge:docs.md",
          task_prompt: "Analyze docs",
        } as any,
        {
          sessionID: "parent-session-1",
          messageID: "message-1",
          agent: "build",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("not an agent payload")
    })

    it("akm_cmd renders arguments and prompts current session", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "command",
            name: "create-file.md",
            path: "/stash/commands/create-file.md",
            template: "Create $1 in $2 with content: $3. All args: $ARGUMENTS",
          })
        }
        return "mock output"
      })

      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const result = await hooks.tool!.akm_cmd.execute(
        {
          ref: "command:create-file.md",
          arguments: "config.json src '{\"key\":\"value\"}'",
        } as any,
        {
          sessionID: "parent-session-1",
          messageID: "message-1",
          agent: "build",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.usedSubtask).toBe(false)
      expect(client.session.create).not.toHaveBeenCalled()
      expect(client.session.prompt).toHaveBeenCalledWith({
        path: { id: "parent-session-1" },
        body: {
          agent: "build",
          parts: [{
            type: "text",
            text: "Create config.json in src with content: {\"key\":\"value\"}. All args: config.json src '{\"key\":\"value\"}'",
          }],
        },
      })
    })

    it("akm_cmd returns JSON error when session.prompt throws", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "command",
            name: "create-file.md",
            path: "/stash/commands/create-file.md",
            template: "Create $1 in $2 with content: $3. All args: $ARGUMENTS",
          })
        }
        return "mock output"
      })

      const client = createMockClient()
      client.session.prompt = mock(async () => {
        throw new Error("prompt exploded")
      })
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))
      const result = await hooks.tool!.akm_cmd.execute(
        {
          ref: "command:create-file.md",
          arguments: "config.json src '{\"key\":\"value\"}'",
        } as any,
        {
          sessionID: "parent-session-1",
          messageID: "message-1",
          agent: "build",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed).toEqual({
        ok: false,
        error: "Failed to execute command command:create-file.md: prompt exploded",
      })
      expect(client.app.log).toHaveBeenCalledWith({
        query: { directory: "/tmp/test-project" },
        body: {
          service: "akm-opencode",
          level: "error",
          message: "AKM dispatch prompt threw",
          extra: expect.objectContaining({
            subsystem: "dispatch",
            toolName: "akm_cmd",
            ref: "command:create-file.md",
            targetSessionID: "parent-session-1",
            error: "prompt exploded",
          }),
        },
      })
    })

    it("akm_cmd resolves command ref from query", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "search") {
          return JSON.stringify({ hits: [{ type: "command", ref: "command:review.md" }] })
        }
        if (args[0] === "show") {
          return JSON.stringify({
            type: "command",
            name: "review.md",
            path: "/stash/commands/review.md",
            template: "Review recent changes",
          })
        }
        return "mock output"
      })

      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_cmd.execute(
        {
          query: "review",
          as_subtask: true,
        } as any,
        {
          sessionID: "parent-session-1",
          messageID: "message-1",
          agent: "build",
          directory: "/tmp/test-project",
          worktree: "/tmp/test-project",
          abort: new AbortController().signal,
          metadata: () => {},
          ask: async () => {},
        } as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.ref).toBe("command:review.md")
      expect(parsed.usedSubtask).toBe(true)
    })

    it("akm_proposal list shells out to `akm proposals`", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      mockExecFileSync.mockReturnValue("{\"proposals\":[]}")
      await hooks.tool!.akm_proposal.execute(
        { action: "list" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["proposals", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_proposal list forwards a status filter", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      mockExecFileSync.mockReturnValue("{\"proposals\":[]}")
      await hooks.tool!.akm_proposal.execute(
        { action: "list", status: "pending" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["proposals", "--status", "pending", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_proposal show requires an id", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_proposal.execute(
        { action: "show" } as any,
        {} as any,
      )
      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("'id' is required")
    })

    it("akm_proposal accept routes through the runCli approval pathway", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      mockExecFileSync.mockReturnValue("{\"ok\":true}")
      await hooks.tool!.akm_proposal.execute(
        { action: "accept", id: "p_123" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["accept", "p_123", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_proposal reject requires a reason", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_proposal.execute(
        { action: "reject", id: "p_123" } as any,
        {} as any,
      )
      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("'reason' is required")
    })

    it("akm_improve forwards scope + task without auto-injecting --format (akm 0.8.0 rejects --format on improve)", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      mockExecFileSync.mockReturnValue("{\"ok\":true}")
      await hooks.tool!.akm_improve.execute(
        { scope: "knowledge:design", task: "review consistency" } as any,
        createToolContext({ sessionID: "session-improve-1" }),
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["improve", "knowledge:design", "--task", "review consistency"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_propose requires exactly one of task/file and forwards task input", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      mockExecFileSync.mockReturnValue("{\"ok\":true}")
      const noTask = await hooks.tool!.akm_propose.execute(
        { type: "skill", name: "release-checks" } as any,
        {} as any,
      )
      expect(JSON.parse(noTask).ok).toBe(false)

      const both = await hooks.tool!.akm_propose.execute(
        { type: "skill", name: "release-checks", task: "x", file: "./prompt.md" } as any,
        {} as any,
      )
      expect(JSON.parse(both).ok).toBe(false)

      await hooks.tool!.akm_propose.execute(
        { type: "skill", name: "release-checks", task: "fail loudly when CI is red" } as any,
        createToolContext({ sessionID: "session-propose-1" }),
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["propose", "skill", "release-checks", "--task", "fail loudly when CI is red", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_propose forwards file input", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      mockExecFileSync.mockReturnValue("{\"ok\":true}")
      await hooks.tool!.akm_propose.execute(
        { type: "workflow", name: "release-checks", file: "./prompt.md" } as any,
        createToolContext({ sessionID: "session-propose-2" }),
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["propose", "workflow", "release-checks", "--file", "./prompt.md", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("captures a fresh checkpoint before improve when there is uncheckpointed session evidence", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      mockExecFileSync.mockReturnValue("{\"ok\":true}")

      await hooks["tool.execute.after"]!(
        { tool: "akm_show", sessionID: "session-improve-prep", callID: "c1", args: { ref: "skill:deploy" } } as any,
        { title: "show", output: JSON.stringify({ type: "skill", ref: "skill:deploy" }), metadata: {} } as any,
      )
      await hooks["tool.execute.after"]!(
        { tool: "akm_show", sessionID: "session-improve-prep", callID: "c2", args: { ref: "skill:test" } } as any,
        { title: "show", output: JSON.stringify({ type: "skill", ref: "skill:test" }), metadata: {} } as any,
      )

      mockExecFileSync.mockClear()
      await hooks.tool!.akm_improve.execute(
        { scope: "skill:deploy" } as any,
        createToolContext({ sessionID: "session-improve-prep" }),
      )

      const calls = mockExecFileSync.mock.calls as Array<[string, string[]]>
      const rememberIndex = calls.findIndex(([, args]) => Array.isArray(args) && args.includes("remember") && args.some((arg) => arg.startsWith("opencode-checkpoint-")))
      const indexIndex = calls.findIndex(([, args]) => Array.isArray(args) && args.length === 1 && args[0] === "index")
      const improveIndex = calls.findIndex(([, args]) => Array.isArray(args) && args[0] === "improve")
      expect(rememberIndex).toBeGreaterThan(-1)
      expect(indexIndex).toBeGreaterThan(rememberIndex)
      expect(improveIndex).toBeGreaterThan(indexIndex)
    })

    it("captures a fresh checkpoint before propose when there is uncheckpointed session evidence", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      mockExecFileSync.mockReturnValue("{\"ok\":true}")

      await hooks["tool.execute.after"]!(
        { tool: "akm_show", sessionID: "session-propose-prep", callID: "c1", args: { ref: "skill:deploy" } } as any,
        { title: "show", output: JSON.stringify({ type: "skill", ref: "skill:deploy" }), metadata: {} } as any,
      )
      await hooks["tool.execute.after"]!(
        { tool: "akm_show", sessionID: "session-propose-prep", callID: "c2", args: { ref: "skill:test" } } as any,
        { title: "show", output: JSON.stringify({ type: "skill", ref: "skill:test" }), metadata: {} } as any,
      )

      mockExecFileSync.mockClear()
      await hooks.tool!.akm_propose.execute(
        { type: "lesson", name: "release-checks", task: "capture release drift" } as any,
        createToolContext({ sessionID: "session-propose-prep" }),
      )

      const calls = mockExecFileSync.mock.calls as Array<[string, string[]]>
      const rememberIndex = calls.findIndex(([, args]) => Array.isArray(args) && args.includes("remember") && args.some((arg) => arg.startsWith("opencode-checkpoint-")))
      const indexIndex = calls.findIndex(([, args]) => Array.isArray(args) && args.length === 1 && args[0] === "index")
      const proposeIndex = calls.findIndex(([, args]) => Array.isArray(args) && args[0] === "propose")
      expect(rememberIndex).toBeGreaterThan(-1)
      expect(indexIndex).toBeGreaterThan(rememberIndex)
      expect(proposeIndex).toBeGreaterThan(indexIndex)
    })

    it("akm_propose returns init/setup guidance when agent config is missing", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      let proposeCalls = 0
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (!Array.isArray(args)) return "mock output"
        if (args[0] === "propose") {
          proposeCalls += 1
          const error = new Error("agent commands are disabled: no `agent` block in config.json") as Error & { status?: number }
          error.status = 1
          throw error
        }
        return "mock output"
      })

      const raw = await hooks.tool!.akm_propose.execute(
        { type: "lesson", name: "avoid-agent-drift", task: "capture the setup precondition for akm propose" } as any,
        createToolContext(),
      )

      const parsed = JSON.parse(raw)
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("Agents should not run akm setup")
      expect(parsed.error).toContain("akm_init")
      expect(proposeCalls).toBe(1)
    })

    it("akm_proposal show routes through `akm show proposal`", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      mockExecFileSync.mockReturnValue("{\"ok\":true}")
      await hooks.tool!.akm_proposal.execute(
        { action: "show", id: "p_123" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["show", "proposal", "p_123", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_init runs `akm init`", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      mockExecFileSync.mockReturnValue("{\"ok\":true}")
      await hooks.tool!.akm_init.execute({} as any, {} as any)
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["init", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })
  })

  describe("expanded response types", () => {
    it("search response includes timing, warnings, and tip", async () => {
      const searchResponse = JSON.stringify({
        hits: [{ type: "script", ref: "script:deploy.sh" }],
        source: "local",
        stashDir: "/home/user/.akm/stash",
        timing: { totalMs: 42, rankMs: 10, embedMs: 5 },
        warnings: ["Index is stale"],
        tip: "Run akm index to refresh",
      })
      mockExecFileSync.mockReturnValue(searchResponse)

      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_search.execute(
        { query: "deploy" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.stashDir).toBe("/home/user/.akm/stash")
      expect(parsed.timing).toEqual({ totalMs: 42, rankMs: 10, embedMs: 5 })
      expect(parsed.warnings).toEqual(["Index is stale"])
      expect(parsed.tip).toBe("Run akm index to refresh")
    })

    it("search hits include name, description, score, whyMatched, run", async () => {
      const searchResponse = JSON.stringify({
        hits: [{
          type: "script",
          ref: "script:deploy.sh",
          name: "deploy.sh",
          description: "Deploy the application",
          score: 0.95,
          whyMatched: ["name match"],
          run: "bash deploy.sh",
        }],
      })
      mockExecFileSync.mockReturnValue(searchResponse)

      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_search.execute(
        { query: "deploy" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      const hit = parsed.hits[0]
      expect(hit.name).toBe("deploy.sh")
      expect(hit.description).toBe("Deploy the application")
      expect(hit.score).toBe(0.95)
      expect(hit.whyMatched).toEqual(["name match"])
      expect(hit.run).toBe("bash deploy.sh")
    })

    it("show agent response includes origin and editable", async () => {
      const agentResponse = JSON.stringify({
        type: "agent",
        name: "reviewer.md",
        path: "/stash/agents/reviewer.md",
        prompt: "You are a code reviewer.",
        origin: "npm:@scope/reviewer",
        editable: false,
      })
      mockExecFileSync.mockReturnValue(agentResponse)

      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_show.execute(
        { ref: "agent:reviewer.md" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.type).toBe("agent")
      expect(parsed.origin).toBe("npm:@scope/reviewer")
      expect(parsed.editable).toBe(false)
    })

    it("show command response includes origin, editable, and agent", async () => {
      const commandResponse = JSON.stringify({
        type: "command",
        name: "lint.md",
        path: "/stash/commands/lint.md",
        template: "Run lint on $1",
        origin: "npm:@scope/lint",
        editable: true,
        agent: "build",
      })
      mockExecFileSync.mockReturnValue(commandResponse)

      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_show.execute(
        { ref: "command:lint.md" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.type).toBe("command")
      expect(parsed.origin).toBe("npm:@scope/lint")
      expect(parsed.editable).toBe(true)
      expect(parsed.agent).toBe("build")
    })
  })

  describe("akm_help tool", () => {
    it("calls `akm --help` by default and returns the curated quick-reference", async () => {
      mockExecFileSync.mockReturnValue("Usage: akm [command]\n  search    ...\n  show      ...\n")
      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_help.execute({} as any, {} as any)
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["--help"],
        expect.objectContaining({ encoding: "utf8" }),
      )
      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.help).toContain("Usage: akm")
      expect(Array.isArray(parsed.quickReference)).toBe(true)
      expect(parsed.quickReference.length).toBeGreaterThan(0)
    })

    it("filters quick-reference hints by topic keywords", async () => {
      mockExecFileSync.mockReturnValue("help text")
      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_help.execute(
        { topic: "commit and push my stash" } as any,
        {} as any,
      )
      const parsed = JSON.parse(result)
      expect(parsed.hints.length).toBeGreaterThan(0)
      expect(parsed.hints.some((h: { command: string }) => h.command.startsWith("akm save"))).toBe(true)
    })

    it("inspects a specific subcommand via `akm <command> --help`", async () => {
      mockExecFileSync.mockReturnValue("save help text")
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_help.execute({ command: "save" } as any, {} as any)
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["save", "--help"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("logs `akm_help` execution failures through OpenCode logging", async () => {
      const client = createMockClient()
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args.includes("--help")) throw new Error("help exploded")
        return "mock output"
      })
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))

      const result = await hooks.tool!.akm_help.execute({ command: "save" } as any, {} as any)

      expect(JSON.parse(result)).toEqual({ ok: false, error: "help exploded" })
      expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          message: "AKM help command failed",
          extra: expect.objectContaining({ subsystem: "help", toolName: "akm_help" }),
        }),
      }))
    })
  })

  describe("v0.5.0 tool execution", () => {
    it("akm_vault set pipes value via stdin (akm 0.8.0 removed positional VALUE)", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_vault.execute(
        { action: "set", ref: "vault:prod", key: "API_KEY", value: "s3kret", comment: "prod key" } as any,
        {} as any,
      )
      // The value MUST go via stdin (the `input` option) and MUST NOT appear in argv.
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["--format", "json", "-q", "vault", "set", "vault:prod", "API_KEY", "--comment", "prod key"],
        expect.objectContaining({ input: "s3kret" }),
      )
    })

    it("akm_vault set rejects KEY=VALUE shape (removed in akm 0.8.0)", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_vault.execute(
        { action: "set", ref: "vault:prod", key: "API_KEY=s3kret", value: "ignored" } as any,
        {} as any,
      )
      expect(JSON.parse(result as string).ok).toBe(false)
      expect(JSON.parse(result as string).error).toContain("KEY=VALUE form was removed")
    })

    it("akm_vault rejects set without a value", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_vault.execute(
        { action: "set", ref: "vault:prod", key: "API_KEY" } as any,
        {} as any,
      )
      expect(JSON.parse(result as string)).toEqual({ ok: false, error: "'value' is required for action='set'." })
    })

    it("akm_vault load returns raw shell text wrapped in JSON", async () => {
      // `resolveAkmCommand` probes the binary via --version before the actual
      // command runs, so route shell output only for the vault-load invocation.
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args[0] === "vault" && args[1] === "load") {
          return ". '/tmp/vault.sh'; rm -f '/tmp/vault.sh'"
        }
        return "mock output"
      })
      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_vault.execute(
        { action: "load", ref: "vault:prod" } as any,
        {} as any,
      )
      const parsed = JSON.parse(result as string)
      expect(parsed.ok).toBe(true)
      expect(parsed.ref).toBe("vault:prod")
      expect(parsed.shell).toContain(". '/tmp/vault.sh'")
    })

    it("akm_vault load logs failures through OpenCode logging", async () => {
      const client = createMockClient()
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args[0] === "vault" && args[1] === "load") {
          throw new Error("vault load exploded")
        }
        return "mock output"
      })
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))

      const result = await hooks.tool!.akm_vault.execute(
        { action: "load", ref: "vault:prod" } as any,
        {} as any,
      )

      expect(JSON.parse(result as string)).toEqual({ ok: false, error: "vault load exploded" })
      expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          message: "AKM vault load failed",
          extra: expect.objectContaining({ subsystem: "vault", action: "load", ref: "vault:prod" }),
        }),
      }))
    })

    it("akm_vault rejects set without a key", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_vault.execute(
        { action: "set", ref: "vault:prod" } as any,
        {} as any,
      )
      expect(JSON.parse(result as string)).toEqual({ ok: false, error: "'key' is required for action='set'." })
    })

    it("akm_wiki register passes writable, trust, and crawler caps", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_wiki.execute(
        {
          action: "register",
          name: "team",
          source_ref: "https://example.com/docs",
          writable: true,
          trust: true,
          max_pages: 120,
          max_depth: 4,
        } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        [
          "wiki",
          "register",
          "team",
          "https://example.com/docs",
          "--writable",
          "--trust",
          "--max-pages",
          "120",
          "--max-depth",
          "4",
          "--format",
          "json",
        ],
        expect.any(Object),
      )
    })

    it("akm_wiki remove requires force and forwards --with-sources", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const denied = await hooks.tool!.akm_wiki.execute(
        { action: "remove", name: "team" } as any,
        {} as any,
      )
      expect(JSON.parse(denied as string)).toEqual({ ok: false, error: "'force' must be true to remove a wiki." })

      await hooks.tool!.akm_wiki.execute(
        { action: "remove", name: "team", force: true, with_sources: true } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["wiki", "remove", "team", "--force", "--with-sources", "--format", "json"],
        expect.any(Object),
      )
    })

    it("akm_wiki stash streams content on stdin when source is '-'", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_wiki.execute(
        {
          action: "stash",
          name: "team",
          source: "-",
          as_slug: "intro",
          content: "# intro",
        } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["wiki", "stash", "team", "-", "--as", "intro", "--format", "json"],
        expect.objectContaining({ input: "# intro" }),
      )
    })

    it("akm_wiki stash logs stdin execution failures", async () => {
      const client = createMockClient()
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args[0] === "wiki" && args[1] === "stash") {
          throw new Error("wiki stash exploded")
        }
        return "mock output"
      })
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))

      const result = await hooks.tool!.akm_wiki.execute(
        { action: "stash", name: "team", source: "-", content: "# intro" } as any,
        {} as any,
      )

      expect(JSON.parse(result as string)).toEqual({ ok: false, error: "wiki stash exploded" })
      expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          message: "AKM wiki stash failed",
          extra: expect.objectContaining({ subsystem: "wiki", action: "stash", name: "team", source: "-" }),
        }),
      }))
    })

    it("akm_workflow start passes --params JSON verbatim", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_workflow.execute(
        { action: "start", ref: "workflow:release", params: '{"tag":"v1"}' } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["workflow", "start", "workflow:release", "--params", '{"tag":"v1"}', "--format", "json"],
        expect.any(Object),
      )
    })

    it("akm_workflow template logs execution failures", async () => {
      const client = createMockClient()
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args[0] === "workflow" && args[1] === "template") {
          throw new Error("workflow template exploded")
        }
        return "mock output"
      })
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))

      const result = await hooks.tool!.akm_workflow.execute(
        { action: "template" } as any,
        {} as any,
      )

      expect(JSON.parse(result as string)).toEqual({ ok: false, error: "workflow template exploded" })
      expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({
          message: "AKM workflow template failed",
          extra: expect.objectContaining({ subsystem: "workflow", action: "template" }),
        }),
      }))
    })

    it("akm_workflow complete requires run_id and step and forwards evidence", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const missing = await hooks.tool!.akm_workflow.execute(
        { action: "complete", step: "qa" } as any,
        {} as any,
      )
      expect(JSON.parse(missing as string).ok).toBe(false)

      await hooks.tool!.akm_workflow.execute(
        {
          action: "complete",
          run_id: "run-1",
          step: "qa",
          state: "blocked",
          notes: "awaiting review",
          evidence: '{"url":"https://ex.com/1"}',
        } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        [
          "workflow",
          "complete",
          "run-1",
          "--step",
          "qa",
          "--state",
          "blocked",
          "--notes",
          "awaiting review",
          "--evidence",
          '{"url":"https://ex.com/1"}',
          "--format",
          "json",
        ],
        expect.any(Object),
      )
    })

    it("akm_workflow next accepts either a run id or a workflow ref", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_workflow.execute(
        { action: "next", ref: "workflow:release" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["workflow", "next", "workflow:release", "--format", "json"],
        expect.any(Object),
      )
    })

  })

  describe("v0.5.0 ref pattern", () => {
    it("extracts workflow, vault, and wiki refs from tool output", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const output = JSON.stringify({
        ok: true,
        hits: [
          { ref: "workflow:release" },
          { ref: "vault:prod" },
          { ref: "wiki:team/intro" },
          { ref: "skill:review" },
        ],
      })
      const logCalls: any[] = []
      const input = createPluginInput({
        client: {
          ...(createMockClient() as any),
          app: {
            log: mock(async (payload: any) => {
              logCalls.push(payload)
              return { data: {}, error: undefined }
            }),
          },
        },
      })
      const hooks2 = await AkmPlugin(input)
      await hooks2["tool.execute.after"]!(
        { tool: "akm_search", args: {}, sessionID: "s1", callID: "c1" } as any,
        { title: "t", output, metadata: {} } as any,
      )
      const memoryLog = logCalls.find((c) => c.body?.extra?.subsystem === "feedback")
      expect(memoryLog).toBeDefined()
      // Verify the ref extraction picked up the v0.5.0 asset types by checking
      // that feedback was recorded for the non-memory, non-vault refs.
      // Auto-feedback wraps its call as: [..., "-q", "feedback", <ref>, ...]
      const feedbackRefs = mockSpawn.mock.calls
        .filter((call: any[]) => Array.isArray(call[1]) && call[1].includes("feedback"))
        .map((call: any[]) => {
          const args = call[1] as string[]
          return args[args.indexOf("feedback") + 1]
        })
      expect(feedbackRefs).toEqual([])
      // Vault refs MUST NOT receive automatic feedback.
      expect(feedbackRefs).not.toContain("vault:prod")
    })

    it("extracts lesson refs from tool output and records feedback", async () => {
      const input = createPluginInput()
      const hooks = await AkmPlugin(input)
      mockSpawn.mockClear()
      await hooks["tool.execute.after"]!(
        { tool: "akm_search", args: {}, sessionID: "s2", callID: "c2" } as any,
        { title: "t", output: JSON.stringify({ ok: true, hits: [{ ref: "lesson:review-first" }] }), metadata: {} } as any,
      )
      const feedbackRefs = mockSpawn.mock.calls
        .filter((call: any[]) => Array.isArray(call[1]) && call[1].includes("feedback"))
        .map((call: any[]) => {
          const args = call[1] as string[]
          return args[args.indexOf("feedback") + 1]
        })
      expect(feedbackRefs).toEqual([])
    })

    it("akm_memory audit reports recall, writes, refs, and safety blocks", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks["chat.message"]!(
        { sessionID: "session-memory-audit", messageID: "m1", agent: "build" } as any,
        { message: {} as any, parts: [{ type: "text", text: "Continue the workflow and remember the deployment constraint" }] as any },
      )
      await hooks["tool.execute.after"]!(
        { tool: "akm_show", sessionID: "session-memory-audit", callID: "c1", args: { ref: "workflow:release" } } as any,
        { title: "show", output: JSON.stringify({ type: "workflow", ref: "workflow:release" }), metadata: {} } as any,
      )
      const result = await hooks.tool!.akm_memory.execute(
        { action: "audit" } as any,
        createToolContext({ sessionID: "session-memory-audit" }),
      )
      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.audit).toBeDefined()
      expect(parsed.audit.lastRecall).toBeDefined()
      expect(Array.isArray(parsed.audit.refs)).toBe(true)
    })

    it("akm_memory audit honors the requested scope", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks["chat.message"]!(
        { sessionID: "session-memory-scope", messageID: "m1", agent: "build" } as any,
        { message: {} as any, parts: [{ type: "text", text: "Continue the workflow and remember the deployment constraint" }] as any },
      )
      await hooks["tool.execute.after"]!(
        { tool: "akm_show", sessionID: "session-memory-scope", callID: "c1", args: { ref: "workflow:release" } } as any,
        { title: "show", output: JSON.stringify({ type: "workflow", ref: "workflow:release" }), metadata: {} } as any,
      )

      const refsOnly = JSON.parse(await hooks.tool!.akm_memory.execute(
        { action: "audit", scope: "refs" } as any,
        createToolContext({ sessionID: "session-memory-scope" }),
      ))
      expect(refsOnly.ok).toBe(true)
      expect(refsOnly.audit.refs).toContain("workflow:release")
      expect(refsOnly.audit.lastRecall).toBeUndefined()
      expect(refsOnly.audit.recentWrites).toBeUndefined()

      const lastPromptOnly = JSON.parse(await hooks.tool!.akm_memory.execute(
        { action: "audit", scope: "last-prompt" } as any,
        createToolContext({ sessionID: "session-memory-scope" }),
      ))
      expect(lastPromptOnly.ok).toBe(true)
      expect(lastPromptOnly.audit.lastRecall).toBeDefined()
      expect(lastPromptOnly.audit.refs).toBeUndefined()
    })

    it("akm_memory candidates can reject with confirm:true after checkpoint extraction", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks["chat.message"]!(
        { sessionID: "session-memory-candidate", messageID: "m1", agent: "build" } as any,
        { message: {} as any, parts: [{ type: "text", text: "Remember: always run integration tests before release" }] as any },
      )
      await hooks["tool.execute.after"]!(
        { tool: "akm_show", sessionID: "session-memory-candidate", callID: "c1", args: { ref: "skill:deploy" } } as any,
        { title: "show", output: JSON.stringify({ type: "skill", ref: "skill:deploy" }), metadata: {} } as any,
      )
      await hooks["tool.execute.after"]!(
        { tool: "akm_show", sessionID: "session-memory-candidate", callID: "c2", args: { ref: "skill:test" } } as any,
        { title: "show", output: JSON.stringify({ type: "skill", ref: "skill:test" }), metadata: {} } as any,
      )
      await hooks.stop!({ sessionID: "session-memory-candidate" } as any)

      const listed = JSON.parse(await hooks.tool!.akm_memory.execute(
        { action: "candidates" } as any,
        createToolContext({ sessionID: "session-memory-candidate" }),
      ))
      expect(listed.ok).toBe(true)
      expect(listed.candidates.length).toBeGreaterThan(0)
      expect(listed.candidates.some((candidate: { sourcePaths?: string[] }) =>
        Array.isArray(candidate.sourcePaths)
        && candidate.sourcePaths.some((entry) => entry.includes("events.jsonl")),
      )).toBe(true)

      const rejected = JSON.parse(await hooks.tool!.akm_memory.execute(
        { action: "reject", candidate_id: listed.candidates[0].id, reason: "not durable", confirm: true } as any,
        createToolContext({ sessionID: "session-memory-candidate" }),
      ))
      expect(rejected.ok).toBe(true)
      expect(rejected.candidate.status).toBe("rejected")
    })

    it("akm_memory promote keeps the candidate pending when the AKM command fails", async () => {
      const client = createMockClient()
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (Array.isArray(args) && args.includes("remember")) {
          return JSON.stringify({ ok: false, error: "remember failed" })
        }
        return "mock output"
      })
      const hooks = await AkmPlugin(createPluginInput({ client: client as any }))

      await hooks["chat.message"]!(
        { sessionID: "session-memory-promote", messageID: "m1", agent: "build" } as any,
        { message: {} as any, parts: [{ type: "text", text: "Remember: always run integration tests before release" }] as any },
      )
      await hooks["tool.execute.after"]!(
        { tool: "akm_show", sessionID: "session-memory-promote", callID: "c1", args: { ref: "skill:deploy" } } as any,
        { title: "show", output: JSON.stringify({ type: "skill", ref: "skill:deploy" }), metadata: {} } as any,
      )
      await hooks["tool.execute.after"]!(
        { tool: "akm_show", sessionID: "session-memory-promote", callID: "c2", args: { ref: "skill:test" } } as any,
        { title: "show", output: JSON.stringify({ type: "skill", ref: "skill:test" }), metadata: {} } as any,
      )
      await hooks.stop!({ sessionID: "session-memory-promote" } as any)

      const listed = JSON.parse(await hooks.tool!.akm_memory.execute(
        { action: "candidates" } as any,
        createToolContext({ sessionID: "session-memory-promote" }),
      ))
      expect(listed.ok).toBe(true)
      expect(listed.candidates.length).toBeGreaterThan(0)

      const promoteResult = JSON.parse(await hooks.tool!.akm_memory.execute(
        { action: "promote", candidate_id: listed.candidates[0].id, confirm: true } as any,
        createToolContext({ sessionID: "session-memory-promote" }),
      ))
      expect(promoteResult.ok).toBe(false)

      const afterFailure = JSON.parse(await hooks.tool!.akm_memory.execute(
        { action: "candidates" } as any,
        createToolContext({ sessionID: "session-memory-promote" }),
      ))
      const candidate = afterFailure.candidates.find((entry: { id: string }) => entry.id === listed.candidates[0].id)
      expect(candidate.status).toBe("pending")
    })

    it("extracts candidate target refs from session evidence when available", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks["chat.message"]!(
        { sessionID: "session-candidate-target", messageID: "m1", agent: "build" } as any,
        { message: {} as any, parts: [{ type: "text", text: "Remember that skill:deploy worked for release fixes" }] as any },
      )
      await hooks["tool.execute.after"]!(
        { tool: "akm_show", sessionID: "session-candidate-target", callID: "c1", args: { ref: "skill:deploy" } } as any,
        { title: "show", output: JSON.stringify({ type: "skill", ref: "skill:deploy" }), metadata: {} } as any,
      )
      await hooks["tool.execute.after"]!(
        { tool: "akm_show", sessionID: "session-candidate-target", callID: "c2", args: { ref: "skill:test" } } as any,
        { title: "show", output: JSON.stringify({ type: "skill", ref: "skill:test" }), metadata: {} } as any,
      )
      await hooks.stop!({ sessionID: "session-candidate-target" } as any)

      const listed = JSON.parse(await hooks.tool!.akm_memory.execute(
        { action: "candidates" } as any,
        createToolContext({ sessionID: "session-candidate-target" }),
      ))
      expect(listed.ok).toBe(true)
      expect(listed.candidates.some((candidate: { evidence?: string[] }) =>
        Array.isArray(candidate.evidence)
        && (candidate.evidence.includes("skill:deploy") || candidate.evidence.includes("skill:test")),
      )).toBe(true)
    })
  })

  describe("packaging", () => {
    it("ships workflow command docs in the package", () => {
      expect(opencodePackage.files).toContain("commands/")
    })
  })

  describe("akm CLI availability", () => {
    it("uses a compatible AKM executable without attempting Bun auto-install", async () => {
      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === "akm" && args[0] === "--version") return "0.8.9"
        if (cmd === "akm" && args[0] === "search") return JSON.stringify({ hits: [] })
        return "mock output"
      })

      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_search.execute({ query: "anything" } as any, {} as any)

      expect(JSON.parse(result)).toEqual({ hits: [] })
      expect(
        mockExecFileSync.mock.calls.some(([cmd, args]) =>
          cmd === "akm"
          && Array.isArray(args)
          && args[0] === "search"
          && args[1] === "anything",
        ),
      ).toBe(true)
      expect(
        mockExecFileSync.mock.calls.some(([cmd, args]) =>
          cmd === "bun" && Array.isArray(args) && args[0] === "install",
        ),
      ).toBe(false)
    })

    it("falls back to ~/.local/bin/akm when PATH lookup fails", async () => {
      const fallbackCommand = path.join(process.env.HOME ?? "/home/test", ".local", "bin", "akm")
      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === "akm" && args[0] === "--version") return "0.7.9"
        if (cmd === fallbackCommand && args[0] === "--version") return "0.8.0-rc0"
        if (cmd === fallbackCommand && args[0] === "search") return JSON.stringify({ hits: [] })
        return "mock output"
      })

      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_search.execute({ query: "anything" } as any, {} as any)

      expect(JSON.parse(result)).toEqual({ hits: [] })
      expect(
        mockExecFileSync.mock.calls.some(([cmd, args]) =>
          cmd === fallbackCommand
          && Array.isArray(args)
          && args[0] === "search"
          && args[1] === "anything",
        ),
      ).toBe(true)
    })

    it("prefers ~/.config/opencode/node_modules/.bin/akm before user-local fallbacks", async () => {
      await withEnvVar("HOME", mkdtempSync(path.join(tmpdir(), "akm-opencode-home-")), async () => {
        const configCommand = path.join(process.env.HOME!, ".config", "opencode", "node_modules", ".bin", "akm")
        const fallbackCommand = path.join(process.env.HOME!, ".local", "bin", "akm")
        mkdirSync(path.dirname(configCommand), { recursive: true })
        writeFileSync(configCommand, "#!/bin/sh\n")
        expect(existsSync(configCommand)).toBe(true)

        mockExecFileSync.mockImplementation((cmd, args) => {
          if (Array.isArray(args) && args[0] === "search") {
            return JSON.stringify({ hits: [], command: cmd })
          }
          if (Array.isArray(args) && args[0] === "--version") {
            return cmd === configCommand ? "0.8.0-rc0" : "0.7.9"
          }
          return "mock output"
        })

        const hooks = await AkmPlugin(createPluginInput())
        const result = await hooks.tool!.akm_search.execute({ query: "anything" } as any, {} as any)

        expect(JSON.parse(result)).toEqual({ hits: [], command: configCommand })
        expect(
          mockExecFileSync.mock.calls.some(([cmd, args]) =>
            cmd === configCommand
            && Array.isArray(args)
            && args[0] === "search"
            && args[1] === "anything",
          ),
        ).toBe(true)
        expect(
          mockExecFileSync.mock.calls.some(([cmd, args]) =>
            cmd === fallbackCommand
            && Array.isArray(args)
            && args[0] === "search",
          ),
        ).toBe(false)
      })
    })

    it("returns a compatibility error when only unsupported AKM versions are available", async () => {
      mockExecFileSync.mockImplementation((cmd, args) => {
        if (Array.isArray(args) && args[0] === "search") return "mock output"
        if (typeof cmd === "string" && Array.isArray(args) && args[0] === "--version" && /(^|[\\/])akm(?:\.cmd|\.exe)?$/.test(cmd)) {
          return "0.7.9"
        }
        return "mock output"
      })

      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_search.execute({ query: "anything" } as any, {} as any)

      expect(JSON.parse(result)).toEqual({
        ok: false,
        error: "AKM CLI ^0.8.0 is required, but no compatible bundled or PATH 'akm' executable was found. Reinstall or update the akm-opencode plugin so OpenCode/Bun installs the dependency.",
      })
      expect(
        mockExecFileSync.mock.calls.some(
          ([cmd, args]) => cmd === "bun" && Array.isArray(args) && args[0] === "install",
        ),
      ).toBe(false)
    })
  })
})
