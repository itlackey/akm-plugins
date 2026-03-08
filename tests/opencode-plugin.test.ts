import { describe, it, expect, mock, beforeEach } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"

// Mock execFileSync before importing the plugin
const mockExecFileSync = mock(() => "mock output")
mock.module("node:child_process", () => ({
  execFileSync: mockExecFileSync,
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
      expect(toolNames).toContain("agentikit_search")
      expect(toolNames).toContain("agentikit_show")
      expect(toolNames).toContain("agentikit_index")
      expect(toolNames).toContain("agentikit_dispatch_agent")
      expect(toolNames).toContain("agentikit_exec_cmd")
      expect(toolNames).toHaveLength(5)
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

    it("agentikit_search has required args schema", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const search = hooks.tool!.agentikit_search
      expect(search.args.query).toBeDefined()
      expect(search.args.type).toBeDefined()
      expect(search.args.limit).toBeDefined()
    })

    it("agentikit_show has required args schema", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const show = hooks.tool!.agentikit_show
      expect(show.args.ref).toBeDefined()
      expect(show.args.view_mode).toBeDefined()
      expect(show.args.heading).toBeDefined()
      expect(show.args.start_line).toBeDefined()
      expect(show.args.end_line).toBeDefined()
    })

    it("agentikit_index has no required args", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const index = hooks.tool!.agentikit_index
      expect(Object.keys(index.args)).toHaveLength(0)
    })

    it("agentikit_dispatch_agent has required args schema", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const dispatch = hooks.tool!.agentikit_dispatch_agent
      expect(dispatch.args.ref).toBeDefined()
      expect(dispatch.args.query).toBeDefined()
      expect(dispatch.args.task_prompt).toBeDefined()
      expect(dispatch.args.dispatch_agent).toBeDefined()
      expect(dispatch.args.as_subtask).toBeDefined()
    })

    it("agentikit_exec_cmd has required args schema", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const cmd = hooks.tool!.agentikit_exec_cmd
      expect(cmd.args.ref).toBeDefined()
      expect(cmd.args.query).toBeDefined()
      expect(cmd.args.arguments).toBeDefined()
      expect(cmd.args.dispatch_agent).toBeDefined()
      expect(cmd.args.as_subtask).toBeDefined()
    })
  })

  describe("tool execution", () => {
    it("agentikit_search calls CLI with correct args", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const result = await hooks.tool!.agentikit_search.execute(
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

    it("agentikit_search passes type filter", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.agentikit_search.execute(
        { query: "hello", type: "skill" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["search", "hello", "--type", "skill"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("agentikit_search passes limit", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.agentikit_search.execute(
        { query: "hello", limit: 5 } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["search", "hello", "--limit", "5"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("agentikit_show calls CLI with ref", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.agentikit_show.execute(
        { ref: "tool://my-tool" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["show", "tool://my-tool"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("agentikit_show passes view_mode and heading", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.agentikit_show.execute(
        { ref: "knowledge://doc", view_mode: "section", heading: "Install" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["show", "knowledge://doc", "--view", "section", "--heading", "Install"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("agentikit_show passes line range", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.agentikit_show.execute(
        { ref: "knowledge://doc", view_mode: "lines", start_line: 10, end_line: 20 } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["show", "knowledge://doc", "--view", "lines", "--start", "10", "--end", "20"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("agentikit_index calls CLI with no extra args", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.agentikit_index.execute({} as any, {} as any)
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
      const result = await hooks.tool!.agentikit_search.execute(
        { query: "test" } as any,
        {} as any,
      )
      const parsed = JSON.parse(result)
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toContain("command not found")
    })

    it("agentikit_dispatch_agent creates child session and prompts with stash metadata", async () => {
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
      const result = await hooks.tool!.agentikit_dispatch_agent.execute(
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

    it("agentikit_dispatch_agent can resolve ref from query", async () => {
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
      const result = await hooks.tool!.agentikit_dispatch_agent.execute(
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

    it("agentikit_dispatch_agent can run in current session", async () => {
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
      const result = await hooks.tool!.agentikit_dispatch_agent.execute(
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

    it("agentikit_dispatch_agent fails for non-agent payload", async () => {
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
      const result = await hooks.tool!.agentikit_dispatch_agent.execute(
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

    it("agentikit_exec_cmd renders arguments and prompts current session", async () => {
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
      const result = await hooks.tool!.agentikit_exec_cmd.execute(
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

    it("agentikit_exec_cmd resolves command ref from query", async () => {
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
      const result = await hooks.tool!.agentikit_exec_cmd.execute(
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
})
