import { describe, it, expect, mock, beforeEach } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"

// Mock execFileSync before importing the plugin
const mockExecFileSync = mock(() => "mock output")
mock.module("node:child_process", () => ({
  execFileSync: mockExecFileSync,
}))

const { AgentikitPlugin } = await import("../opencode/index.ts")

// Minimal stub that satisfies the PluginInput shape
function createPluginInput(overrides?: Partial<PluginInput>): PluginInput {
  return {
    client: {} as any,
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

    it("registers all four tools", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const toolNames = Object.keys(hooks.tool!)
      expect(toolNames).toContain("agentikit_search")
      expect(toolNames).toContain("agentikit_open")
      expect(toolNames).toContain("agentikit_run")
      expect(toolNames).toContain("agentikit_index")
      expect(toolNames).toHaveLength(4)
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

    it("agentikit_open has required args schema", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const open = hooks.tool!.agentikit_open
      expect(open.args.ref).toBeDefined()
      expect(open.args.view_mode).toBeDefined()
      expect(open.args.heading).toBeDefined()
      expect(open.args.start_line).toBeDefined()
      expect(open.args.end_line).toBeDefined()
    })

    it("agentikit_run has ref arg", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const run = hooks.tool!.agentikit_run
      expect(run.args.ref).toBeDefined()
    })

    it("agentikit_index has no required args", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      const index = hooks.tool!.agentikit_index
      expect(Object.keys(index.args)).toHaveLength(0)
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
        "agentikit",
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
        "agentikit",
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
        "agentikit",
        ["search", "hello", "--limit", "5"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("agentikit_open calls CLI with ref", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.agentikit_open.execute(
        { ref: "tool://my-tool" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "agentikit",
        ["open", "tool://my-tool"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("agentikit_open passes view_mode and heading", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.agentikit_open.execute(
        { ref: "knowledge://doc", view_mode: "section", heading: "Install" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "agentikit",
        ["open", "knowledge://doc", "--view", "section", "--heading", "Install"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("agentikit_open passes line range", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.agentikit_open.execute(
        { ref: "knowledge://doc", view_mode: "lines", start_line: 10, end_line: 20 } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "agentikit",
        ["open", "knowledge://doc", "--view", "lines", "--start", "10", "--end", "20"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("agentikit_run calls CLI with ref", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.agentikit_run.execute(
        { ref: "tool://my-script" } as any,
        {} as any,
      )
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "agentikit",
        ["run", "tool://my-script"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("agentikit_index calls CLI with no extra args", async () => {
      const hooks = await AgentikitPlugin(createPluginInput())
      await hooks.tool!.agentikit_index.execute({} as any, {} as any)
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "agentikit",
        ["index"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("returns JSON error when CLI fails", async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error("command not found: agentikit")
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
  })
})
