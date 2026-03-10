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

describe("agentikit-opencode plugin", () => {
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
      expect(toolNames).toContain("akm_submit")
      expect(toolNames).toHaveLength(14)
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
      expect(search.args.usage).toBeDefined()
    })

    it("akm_registry_search has required args schema", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const search = hooks.tool!.akm_registry_search
      expect(search.args.query).toBeDefined()
      expect(search.args.type).toBeDefined()
      expect(search.args.limit).toBeDefined()
      expect(search.args.usage).toBeDefined()
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
        ["search", "test-query"],
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
        ["search", "hello", "--type", "skill"],
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
        ["search", "hello", "--limit", "5"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_search passes usage mode", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_search.execute(
        { query: "hello", usage: "item" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["search", "hello", "--usage", "item"],
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
        ["search", "lint", "--source", "registry"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_registry_search passes usage mode", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_registry_search.execute(
        { query: "lint", usage: "guide" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["search", "lint", "--source", "registry", "--usage", "guide"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_show calls CLI with ref", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_show.execute(
        { ref: "tool://my-tool" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["show", "tool://my-tool"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_show passes view_mode and heading", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_show.execute(
        { ref: "knowledge://doc", view_mode: "section", heading: "Install" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["show", "knowledge://doc", "--view", "section", "--heading", "Install"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_show passes line range", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_show.execute(
        { ref: "knowledge://doc", view_mode: "lines", start_line: 10, end_line: 20 } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["show", "knowledge://doc", "--view", "lines", "--start", "10", "--end", "20"],
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
        ["add", "my-kit"],
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
        ["add", "github:itlackey/my-kit"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_list calls CLI with no extra args", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_list.execute({} as any, {} as any)
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["list"],
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
        ["remove", "npm:@scope/kit"],
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
        ["update", "owner/repo", "--force"],
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
        ["update", "--all"],
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
      expect(mockExecFileSync).not.toHaveBeenCalled()
    })

    it("akm_clone calls CLI with optional flags", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_clone.execute(
        {
          ref: "npm:@scope/pkg//tool:deploy.sh",
          name: "my-deploy.sh",
          dest: "/tmp/worktree",
          force: true,
        } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["clone", "npm:@scope/pkg//tool:deploy.sh", "--name", "my-deploy.sh", "--dest", "/tmp/worktree", "--force"],
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
        ["search", "hello", "--source", "registry"],
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
        ["search", "deploy", "--type", "script"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("akm_index calls CLI with no extra args", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_index.execute({} as any, {} as any)
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["index"],
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
        body: { parentID: "parent-session-1", title: "agentikit:coach.md" },
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
          return JSON.stringify({ hits: [{ type: "agent", openRef: "agent:coach.md" }] })
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
        ["search", "coach", "--type", "agent", "--limit", "1", "--usage", "none", "--source", "local"],
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
          return JSON.stringify({ hits: [{ type: "command", openRef: "command:review.md" }] })
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
    it("search response includes timing, warnings, tip, and usageGuide", async () => {
      const searchResponse = JSON.stringify({
        hits: [{ type: "tool", openRef: "tool:deploy.sh" }],
        source: "local",
        stashDir: "/home/user/.agentikit/stash",
        timing: 42,
        warnings: ["Index is stale"],
        tip: "Run akm index to refresh",
        usageGuide: "Use akm show <ref> to view details",
      })
      mockExecFileSync.mockReturnValue(searchResponse)

      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_search.execute(
        { query: "deploy" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.stashDir).toBe("/home/user/.agentikit/stash")
      expect(parsed.timing).toBe(42)
      expect(parsed.warnings).toEqual(["Index is stale"])
      expect(parsed.tip).toBe("Run akm index to refresh")
      expect(parsed.usageGuide).toBe("Use akm show <ref> to view details")
    })

    it("search hits include name, description, score, whyMatched, runCmd, kind", async () => {
      const searchResponse = JSON.stringify({
        hits: [{
          type: "tool",
          openRef: "tool:deploy.sh",
          name: "deploy.sh",
          description: "Deploy the application",
          score: 0.95,
          whyMatched: "name match",
          runCmd: "bash deploy.sh",
          kind: "shell",
          usage: "deploy.sh [env]",
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
      expect(hit.whyMatched).toBe("name match")
      expect(hit.runCmd).toBe("bash deploy.sh")
      expect(hit.kind).toBe("shell")
      expect(hit.usage).toBe("deploy.sh [env]")
    })

    it("show agent response includes registryId and editable", async () => {
      const agentResponse = JSON.stringify({
        type: "agent",
        name: "reviewer.md",
        path: "/stash/agents/reviewer.md",
        prompt: "You are a code reviewer.",
        registryId: "agentikit-registry/reviewer",
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
      expect(parsed.registryId).toBe("agentikit-registry/reviewer")
      expect(parsed.editable).toBe(false)
    })

    it("show command response includes registryId, editable, and agent", async () => {
      const commandResponse = JSON.stringify({
        type: "command",
        name: "lint.md",
        path: "/stash/commands/lint.md",
        template: "Run lint on $1",
        registryId: "agentikit-registry/lint",
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
      expect(parsed.registryId).toBe("agentikit-registry/lint")
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
        ["config", "list"],
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
        ["config", "get", "stashDir"],
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
        ["config", "set", "stashDir", "/tmp/stash"],
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

    it("run by ref executes the runCmd from show response", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "tool",
            name: "deploy.sh",
            path: "/stash/tools/deploy.sh",
            runCmd: "cd /stash && bash deploy.sh",
          })
        }
        return "mock output"
      })
      mockExecSync.mockReturnValue("deployed successfully")

      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_run.execute(
        { ref: "tool:deploy.sh" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.tool).toBe("deploy.sh")
      expect(parsed.runCmd).toBe("cd /stash && bash deploy.sh")
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
            hits: [{ type: "tool", openRef: "tool:build.sh" }],
          })
        }
        if (args[0] === "show") {
          return JSON.stringify({
            type: "tool",
            name: "build.sh",
            path: "/stash/tools/build.sh",
            runCmd: "bash build.sh",
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
      expect(parsed.tool).toBe("build.sh")
      expect(parsed.output).toBe("build complete")
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["search", "build", "--type", "tool", "--limit", "1", "--usage", "none", "--source", "local"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("run with args appends args to runCmd", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "tool",
            name: "deploy.sh",
            path: "/stash/tools/deploy.sh",
            runCmd: "bash deploy.sh",
          })
        }
        return "mock output"
      })
      mockExecSync.mockReturnValue("deployed to prod")

      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_run.execute(
        { ref: "tool:deploy.sh", args: "--env production" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(true)
      expect(parsed.runCmd).toBe("bash deploy.sh --env production")
      expect(mockExecSync).toHaveBeenCalledWith(
        "bash deploy.sh --env production",
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("returns error for non-tool type", async () => {
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
      expect(parsed.error).toContain("not a tool payload")
    })

    it("returns error when runCmd is missing", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "tool",
            name: "broken.sh",
            path: "/stash/tools/broken.sh",
          })
        }
        return "mock output"
      })

      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_run.execute(
        { ref: "tool:broken.sh" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("missing runCmd")
    })

    it("returns error when execution fails", async () => {
      mockExecFileSync.mockImplementation((_cmd, args) => {
        if (args[0] === "show") {
          return JSON.stringify({
            type: "tool",
            name: "fail.sh",
            path: "/stash/tools/fail.sh",
            runCmd: "bash fail.sh",
          })
        }
        return "mock output"
      })
      mockExecSync.mockImplementation(() => {
        throw new Error("exit code 1: script failed")
      })

      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_run.execute(
        { ref: "tool:fail.sh" } as any,
        {} as any,
      )

      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("Failed to execute runCmd")
      expect(parsed.error).toContain("exit code 1")
    })
  })

  describe("akm_submit tool", () => {
    it("tool exists with description and execute function", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const submit = hooks.tool!.akm_submit
      expect(submit).toBeDefined()
      expect(submit.description).toBeTruthy()
      expect(typeof submit.execute).toBe("function")
    })

    it("submit calls CLI as 'akm submit'", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_submit.execute(
        {} as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["submit"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("submit with dry_run calls CLI as 'akm submit --dry-run'", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.akm_submit.execute(
        { dry_run: true } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["submit", "--dry-run"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("returns JSON error when CLI fails", async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("submit permission denied")
      })
      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.akm_submit.execute(
        {} as any,
        {} as any,
      )
      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("submit permission denied")
    })
  })
})
