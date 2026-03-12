import { describe, it, expect, mock, beforeEach } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"

// Mock execFileSync and execSync before importing the plugin
const mockExecFileSync = mock(() => "mock output")
const mockExecSync = mock(() => "exec output")
mock.module("node:child_process", () => ({
  execFileSync: mockExecFileSync,
  execSync: mockExecSync,
}))

const { AgentikitPlugin } = await import("../opencode/index.ts")

function createMockClient() {
  return {
    app: {
      log: mock(async () => ({ data: {}, error: undefined })),
    },
    session: {
      create: mock(async () => ({ data: { id: "child-session-1" }, error: undefined })),
      prompt: mock(async () => ({
        data: {
          parts: [{ type: "text", text: "child response" }],
        },
        error: undefined,
      })),
    },
  }
}

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

describe("akm-opencode plugin", () => {
  beforeEach(() => {
    mockExecFileSync.mockClear()
    mockExecFileSync.mockReturnValue("mock output")
    mockExecSync.mockClear()
    mockExecSync.mockReturnValue("exec output")
  })

  describe("plugin loading", () => {
    it("exports AgentikitPlugin as a function", () => {
      expect(typeof AgentikitPlugin).toBe("function")
    })

    it("returns hooks object when invoked", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      expect(hooks).toBeDefined()
      expect(hooks.tool).toBeDefined()
    })

    it("registers all tools", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const toolNames = Object.keys(hooks.tool!)
      expect(toolNames).toContain("akm_search")
      expect(toolNames).toContain("akm_registry_search")
      expect(toolNames).toContain("akm_show")
      expect(toolNames).toContain("akm_index")
      expect(toolNames).toContain("akm_agent")
      expect(toolNames).toContain("akm_cmd")
      expect(toolNames).toContain("akm_add")
      expect(toolNames).toContain("akm_list")
      expect(toolNames).toContain("akm_remove")
      expect(toolNames).toContain("akm_update")
      expect(toolNames).toContain("akm_clone")
      expect(toolNames).toContain("akm_config")
      expect(toolNames).toContain("akm_run")
      expect(toolNames).toContain("akm_sources")
      expect(toolNames).toContain("akm_upgrade")
      expect(toolNames).not.toContain("akm_submit")
      expect(toolNames).toHaveLength(15)
    })
  })

  describe("tool definitions", () => {
    it("each tool has a description", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      for (const [name, def] of Object.entries(hooks.tool!)) {
        expect(def.description).toBeTruthy()
        expect(typeof def.description).toBe("string")
      }
    })

    it("each tool has an execute function", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      for (const [name, def] of Object.entries(hooks.tool!)) {
        expect(typeof def.execute).toBe("function")
      }
    })

    it("akm_search has required args schema", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const search = hooks.tool!.akm_search
      expect(search.args.query).toBeDefined()
      expect(search.args.type).toBeDefined()
      expect(search.args.limit).toBeDefined()
      expect(search.args.source).toBeDefined()
    })

    it("akm_registry_search has required args schema", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const search = hooks.tool!.akm_registry_search
      expect(search.args.query).toBeDefined()
      expect(search.args.type).toBeDefined()
      expect(search.args.limit).toBeDefined()
      expect(search.args.assets).toBeDefined()
    })

    it("akm_show has required args schema", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const show = hooks.tool!.akm_show
      expect(show.args.ref).toBeDefined()
      expect(show.args.view_mode).toBeDefined()
      expect(show.args.heading).toBeDefined()
      expect(show.args.start_line).toBeDefined()
      expect(show.args.end_line).toBeDefined()
    })

    it("akm_index has no required args", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const index = hooks.tool!.akm_index
      expect(Object.keys(index.args)).toHaveLength(0)
    })

    it("akm_agent has required args schema", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const dispatch = hooks.tool!.akm_agent
      expect(dispatch.args.ref).toBeDefined()
      expect(dispatch.args.query).toBeDefined()
      expect(dispatch.args.task_prompt).toBeDefined()
      expect(dispatch.args.dispatch_agent).toBeDefined()
      expect(dispatch.args.as_subtask).toBeDefined()
    })

    it("akm_add has required args schema", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const add = hooks.tool!.akm_add
      expect(add.args.package_ref).toBeDefined()
    })

    it("akm_list has no required args", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const list = hooks.tool!.akm_list
      expect(Object.keys(list.args)).toHaveLength(0)
    })

    it("akm_remove has required args schema", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const remove = hooks.tool!.akm_remove
      expect(remove.args.package_ref).toBeDefined()
    })

    it("akm_update has required args schema", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const update = hooks.tool!.akm_update
      expect(update.args.package_ref).toBeDefined()
      expect(update.args.all).toBeDefined()
      expect(update.args.force).toBeDefined()
    })

    it("akm_clone has required args schema", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const clone = hooks.tool!.akm_clone
      expect(clone.args.ref).toBeDefined()
      expect(clone.args.name).toBeDefined()
      expect(clone.args.dest).toBeDefined()
      expect(clone.args.force).toBeDefined()
    })

    it("akm_cmd has required args schema", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const cmd = hooks.tool!.akm_cmd
      expect(cmd.args.ref).toBeDefined()
      expect(cmd.args.query).toBeDefined()
      expect(cmd.args.arguments).toBeDefined()
      expect(cmd.args.dispatch_agent).toBeDefined()
      expect(cmd.args.as_subtask).toBeDefined()
    })

    it("akm_sources has no required args", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const sources = hooks.tool!.akm_sources
      expect(Object.keys(sources.args)).toHaveLength(0)
    })

    it("akm_upgrade has required args schema", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const upgrade = hooks.tool!.akm_upgrade
      expect(upgrade.args.check).toBeDefined()
      expect(upgrade.args.force).toBeDefined()
    })
  })

  describe("tool execution", () => {
    it("akm_search calls CLI with correct args", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
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
      const hooks = await AgentikitPlugin(createPluginInput())
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
      const hooks = await AgentikitPlugin(createPluginInput())
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

    it("akm_registry_search defaults to registry source", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_registry_search.execute(
        { query: "lint" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["registry", "search", "lint", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_registry_search passes --assets flag", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_registry_search.execute(
        { query: "lint", assets: true } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["registry", "search", "lint", "--assets", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_show calls CLI with ref", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
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
      const hooks = await AgentikitPlugin(createPluginInput())
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
      const hooks = await AgentikitPlugin(createPluginInput())
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

    it("akm_add calls CLI with package ref", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_add.execute(
        { package_ref: "my-kit" } as any,
        {} as any,
      )
      expect(result).toBe("mock output")
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["add", "my-kit", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_add handles github refs", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_add.execute(
        { package_ref: "github:itlackey/my-kit" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["add", "github:itlackey/my-kit", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_list calls CLI with no extra args", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_list.execute({} as any, {} as any)
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["list", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_remove calls CLI with package ref", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_remove.execute(
        { package_ref: "npm:@scope/kit" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["remove", "npm:@scope/kit", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_update calls CLI for a specific package", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_update.execute(
        { package_ref: "owner/repo", force: true } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["update", "owner/repo", "--force", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_update can update all packages", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_update.execute(
        { all: true } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["update", "--all", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_update validates required inputs", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_update.execute({} as any, {} as any)
      expect(JSON.parse(result)).toEqual({
        ok: false,
        error: "Provide 'package_ref' or set 'all' to true.",
      })
    })

    it("akm_clone calls CLI with optional flags", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_clone.execute(
        {
          ref: "npm:@scope/pkg//script:deploy.sh",
          name: "my-deploy.sh",
          dest: "/tmp/worktree",
          force: true,
        } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["clone", "npm:@scope/pkg//script:deploy.sh", "--name", "my-deploy.sh", "--dest", "/tmp/worktree", "--force", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_search passes source filter", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
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
      const hooks = await AgentikitPlugin(createPluginInput())
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

    it("akm_index calls CLI with no extra args", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_index.execute({} as any, {} as any)
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["index", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("returns JSON error when CLI fails", async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("command not found: akm")
      })
      const hooks = await AgentikitPlugin(createPluginInput())
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
      const hooks = await AgentikitPlugin(createPluginInput({ client: client as any }))

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
            args: ["search", "deploy", "--source", "local", "--detail", "normal", "--format", "json"],
            exitCode: 0,
            stdout: "mock output",
            stderr: "",
          }),
        },
      })
    })

    it("writes failed AKM tool invocations to OpenCode app logs", async () => {
      mockExecFileSync.mockImplementation((cmd, args) => {
        if (Array.isArray(args) && args[0] === "--version") return "0.0.18"
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
      const hooks = await AgentikitPlugin(createPluginInput({ client: client as any }))
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
      const hooks = await AgentikitPlugin(createPluginInput({ client: client as any }))
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
        query: { directory: "/tmp/test-project" },
        body: { parentID: "parent-session-1", title: "akm:coach.md" },
      })
      expect(client.session.prompt).toHaveBeenCalledWith({
        query: { directory: "/tmp/test-project" },
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
      const hooks = await AgentikitPlugin(createPluginInput({ client: client as any }))
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
        ["search", "coach", "--type", "agent", "--limit", "1", "--detail", "normal", "--source", "local", "--format", "json"],
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
      const hooks = await AgentikitPlugin(createPluginInput({ client: client as any }))
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
      const hooks = await AgentikitPlugin(createPluginInput({ client: client as any }))
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

      const hooks = await AgentikitPlugin(createPluginInput())
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
      const hooks = await AgentikitPlugin(createPluginInput({ client: client as any }))
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
        query: { directory: "/tmp/test-project" },
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

      const hooks = await AgentikitPlugin(createPluginInput())
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
  })

  describe("expanded response types", () => {
    it("search response includes timing, warnings, and tip", async () => {
      const searchResponse = JSON.stringify({
        hits: [{ type: "script", ref: "script:deploy.sh" }],
        source: "local",
        stashDir: "/home/user/.agentikit/stash",
        timing: { totalMs: 42, rankMs: 10, embedMs: 5 },
        warnings: ["Index is stale"],
        tip: "Run akm index to refresh",
      })
      mockExecFileSync.mockReturnValue(searchResponse)

      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_search.execute(
        { query: "deploy" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.stashDir).toBe("/home/user/.agentikit/stash")
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

      const hooks = await AgentikitPlugin(createPluginInput())
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

    it("registry search hits include installRef for direct akm_add usage", async () => {
      const registryResponse = JSON.stringify({
        hits: [{
          type: "registry",
          id: "skills-sh:anthropics/skills/frontend-design",
          installRef: "github:anthropics/skills",
          action: "akm add github:anthropics/skills",
          name: "frontend-design",
        }],
      })
      mockExecFileSync.mockReturnValue(registryResponse)

      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_registry_search.execute(
        { query: "frontend design" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.hits[0].id).toBe("skills-sh:anthropics/skills/frontend-design")
      expect(parsed.hits[0].installRef).toBe("github:anthropics/skills")
      expect(parsed.hits[0].action).toBe("akm add github:anthropics/skills")
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

      const hooks = await AgentikitPlugin(createPluginInput())
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

      const hooks = await AgentikitPlugin(createPluginInput())
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

  describe("akm_config tool", () => {
    it("tool exists with description and execute function", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const config = hooks.tool!.akm_config
      expect(config).toBeDefined()
      expect(config.description).toBeTruthy()
      expect(typeof config.execute).toBe("function")
    })

    it("config list calls CLI as 'akm config list'", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_config.execute(
        { action: "list" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["config", "list", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("config get calls CLI as 'akm config get <key>'", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_config.execute(
        { action: "get", key: "stashDir" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["config", "get", "stashDir", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("config set calls CLI as 'akm config set <key> <value>'", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_config.execute(
        { action: "set", key: "stashDir", value: "/tmp/stash" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["config", "set", "stashDir", "/tmp/stash", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("config unset calls CLI as 'akm config unset <key>'", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_config.execute(
        { action: "unset", key: "llm" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["config", "unset", "llm", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("config path supports --all", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_config.execute(
        { action: "path", all: true } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["config", "path", "--all", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("returns JSON error when CLI fails", async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("config read failed")
      })
      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_config.execute(
        { action: "list" } as any,
        {} as any,
      )
      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("config read failed")
    })
  })

  describe("akm_run tool", () => {
    it("tool exists with description and execute function", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const run = hooks.tool!.akm_run
      expect(run).toBeDefined()
      expect(run.description).toBeTruthy()
      expect(typeof run.execute).toBe("function")
    })

    it("run by ref executes the run command from show response", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "script",
            name: "deploy.sh",
            path: "/stash/scripts/deploy.sh",
            run: "cd /stash && bash deploy.sh",
          })
        }
        return "mock output"
      })
      mockExecSync.mockReturnValue("deployed successfully")

      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_run.execute(
        { ref: "script:deploy.sh" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.script).toBe("deploy.sh")
      expect(parsed.run).toBe("cd /stash && bash deploy.sh")
      expect(parsed.output).toBe("deployed successfully")
      expect(mockExecSync).toHaveBeenCalledWith(
        "cd /stash && bash deploy.sh",
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("run by query resolves ref via search then show then executes", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "search") {
          return JSON.stringify({
            hits: [{ type: "script", ref: "script:build.sh" }],
          })
        }
        if (args[0] === "show") {
          return JSON.stringify({
            type: "script",
            name: "build.sh",
            path: "/stash/scripts/build.sh",
            run: "bash build.sh",
          })
        }
        return "mock output"
      })
      mockExecSync.mockReturnValue("build complete")

      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_run.execute(
        { query: "build" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.script).toBe("build.sh")
      expect(parsed.output).toBe("build complete")
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["search", "build", "--type", "script", "--limit", "1", "--detail", "normal", "--source", "local", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("run with args appends args to run command", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "script",
            name: "deploy.sh",
            path: "/stash/scripts/deploy.sh",
            run: "bash deploy.sh",
          })
        }
        return "mock output"
      })
      mockExecSync.mockReturnValue("deployed to prod")

      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_run.execute(
        { ref: "script:deploy.sh", args: "--env production" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.run).toBe("bash deploy.sh --env production")
      expect(mockExecSync).toHaveBeenCalledWith(
        "bash deploy.sh --env production",
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("returns error for non-script type", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "agent",
            name: "coach.md",
            path: "/stash/agents/coach.md",
            prompt: "You are a coach.",
          })
        }
        return "mock output"
      })

      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_run.execute(
        { ref: "agent:coach.md" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("not a script payload")
    })

    it("returns error when run command is missing", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "script",
            name: "broken.sh",
            path: "/stash/scripts/broken.sh",
          })
        }
        return "mock output"
      })

      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_run.execute(
        { ref: "script:broken.sh" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("missing run command")
    })

    it("returns error when execution fails", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "script",
            name: "fail.sh",
            path: "/stash/scripts/fail.sh",
            run: "bash fail.sh",
          })
        }
        return "mock output"
      })
      mockExecSync.mockImplementation(() => {
        throw new Error("exit code 1: script failed")
      })

      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_run.execute(
        { ref: "script:fail.sh" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("Failed to execute run command")
      expect(parsed.error).toContain("exit code 1")
    })

    it("accepts type 'script' from show response", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "script",
            name: "build.sh",
            path: "/stash/scripts/build.sh",
            run: "bash build.sh",
          })
        }
        return "mock output"
      })
      mockExecSync.mockReturnValue("done")

      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_run.execute(
        { ref: "script:build.sh" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.script).toBe("build.sh")
    })

    it("accepts type 'tool' from show response", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "tool",
            name: "build.sh",
            path: "/stash/scripts/build.sh",
            run: "bash build.sh",
          })
        }
        return "mock output"
      })
      mockExecSync.mockReturnValue("done")

      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_run.execute(
        { ref: "script:build.sh" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.script).toBe("build.sh")
    })
  })

  describe("akm_sources tool", () => {
    it("tool exists with description and execute function", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const sources = hooks.tool!.akm_sources
      expect(sources).toBeDefined()
      expect(sources.description).toBeTruthy()
      expect(typeof sources.execute).toBe("function")
    })

    it("calls CLI with 'sources' command", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_sources.execute({} as any, {} as any)
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["sources", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })
  })

  describe("akm_upgrade tool", () => {
    it("tool exists with description and execute function", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const upgrade = hooks.tool!.akm_upgrade
      expect(upgrade).toBeDefined()
      expect(upgrade.description).toBeTruthy()
      expect(typeof upgrade.execute).toBe("function")
    })

    it("calls CLI with 'upgrade' command", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_upgrade.execute({} as any, {} as any)
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["upgrade", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("passes --check flag", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_upgrade.execute(
        { check: true } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["upgrade", "--check", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("passes --force flag", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_upgrade.execute(
        { force: true } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["upgrade", "--force", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })
  })

  describe("akm CLI availability", () => {
    it("auto-installs akm-cli via Bun when akm is missing", async () => {
      let installComplete = false
      mockExecFileSync.mockImplementation((cmd, args) => {
        if (cmd === "akm" && args[0] === "--version") {
          const error = new Error("spawn akm ENOENT") as Error & { code?: string }
          error.code = "ENOENT"
          throw error
        }
        if (cmd === "bun" && args[0] === "--version") return "1.3.5"
        if (cmd === "bun" && args[0] === "install") {
          installComplete = true
          return "installed"
        }
        if (cmd === "bun" && args[0] === "pm") return "/tmp/.bun/bin\n"
        if (cmd === "/tmp/.bun/bin/akm" && args[0] === "--version" && installComplete) return "0.1.0"
        if (cmd === "/tmp/.bun/bin/akm" && args[0] === "sources" && installComplete) {
          return JSON.stringify({ sources: [] })
        }
        return "mock output"
      })

      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_sources.execute({} as any, {} as any)

      expect(JSON.parse(result)).toEqual({ sources: [] })
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "bun",
        ["install", "-g", "akm-cli"],
        expect.objectContaining({ encoding: "utf8", timeout: 120_000, stdio: "pipe" }),
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "/tmp/.bun/bin/akm",
        ["sources", "--format", "json"],
        expect.objectContaining({ encoding: "utf8", timeout: 60_000 }),
      )
    })
  })
})
