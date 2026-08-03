import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const realChildProcess = await import("node:child_process")

const mockExecFileSync = mock((_command: string, args?: string[]) => {
  if (args?.[0] === "--version") return "akm 0.9.0-rc.14\n"
  if (args?.[0] === "feedback" || args?.[0] === "remember") return JSON.stringify({ ok: true })
  return "mock output"
})
const mockExecSync = mock(() => "exec output")
const mockSpawn = mock(() => ({
  on: mock(() => undefined),
  unref: mock(() => undefined),
}))

const mockAkmSearch = mock(async (input: Record<string, unknown>) => ({
  schemaVersion: 1,
  bundleDir: "/tmp/akm-bundle",
  source: input.source ?? "local",
  hits: [{ type: "skill", ref: "skills/review", quality: input.includeProposed ? "proposed" : "curated" }],
}))
const mockAkmShowUnified = mock(async (input: Record<string, unknown>) => ({
  type: "knowledge",
  ref: input.ref,
  content: "mock concept",
}))
const mockAkmCurate = mock(async (input: Record<string, unknown>) => ({
  query: input.query,
  summary: "one match",
  items: [{ type: "skill", ref: "skills/review" }],
}))

mock.module("node:child_process", () => ({
  ...realChildProcess,
  execFileSync: mockExecFileSync,
  execSync: mockExecSync,
  spawn: mockSpawn,
}))
mock.module("akm-cli/dist/commands/read/search.js", () => ({ akmSearch: mockAkmSearch }))
mock.module("akm-cli/dist/commands/read/show.js", () => ({ akmShowUnified: mockAkmShowUnified }))
mock.module("akm-cli/dist/commands/read/curate.js", () => ({ akmCurate: mockAkmCurate }))

const pluginModule = await import("../opencode/index.ts")
const { AkmPlugin } = pluginModule

function createMockClient() {
  return {
    app: {
      log: mock(async () => ({ data: {}, error: undefined })),
      agents: mock(async () => ({ data: [{ name: "general" }], error: undefined })),
    },
    session: {
      create: mock(async () => ({ data: { id: "child-session" }, error: undefined })),
      get: mock(async () => ({ data: { id: "session", parentID: "parent" }, error: undefined })),
      messages: mock(async () => ({ data: [], error: undefined })),
      prompt: mock(async () => ({ data: { parts: [] }, error: undefined })),
    },
  }
}

function createPluginInput(client = createMockClient()): PluginInput {
  return {
    client: client as any,
    project: {} as any,
    directory: "/tmp/project",
    worktree: "/tmp/project",
    serverUrl: new URL("http://localhost:3000"),
    $: {} as any,
  }
}

function createToolContext() {
  return {
    sessionID: "run-1",
    messageID: "message-1",
    userID: "user-1",
    agent: "build",
    channel: "review",
    directory: "/tmp/project",
    worktree: "/tmp/project",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as any
}

describe("akm-opencode plugin", () => {
  beforeEach(() => {
    mockExecFileSync.mockClear()
    mockExecFileSync.mockImplementation((_command: string, args?: string[]) => {
      if (args?.[0] === "--version") return "akm 0.9.0-rc.14\n"
      if (args?.[0] === "feedback" || args?.[0] === "remember") return JSON.stringify({ ok: true })
      return "mock output"
    })
    mockExecSync.mockClear()
    mockSpawn.mockClear()
    mockAkmSearch.mockClear()
    mockAkmShowUnified.mockClear()
    mockAkmCurate.mockClear()
    mockAkmSearch.mockImplementation(async (input: Record<string, unknown>) => ({
      schemaVersion: 1,
      bundleDir: "/tmp/akm-bundle",
      source: input.source ?? "local",
      hits: [{ type: "skill", ref: "skills/review", quality: input.includeProposed ? "proposed" : "curated" }],
    }))
    mockAkmShowUnified.mockImplementation(async (input: Record<string, unknown>) => ({
      type: "knowledge",
      ref: input.ref,
      content: "mock concept",
    }))
    mockAkmCurate.mockImplementation(async (input: Record<string, unknown>) => ({
      query: input.query,
      summary: "one match",
      items: [{ type: "skill", ref: "skills/review" }],
    }))
    ;(pluginModule as { __resetResolvedAkmForTests?: () => void }).__resetResolvedAkmForTests?.()
  })

  describe("plugin loading", () => {
    it("exports one plugin function without duplicate loader entry points", () => {
      expect(typeof AkmPlugin).toBe("function")
      expect((pluginModule as Record<string, unknown>).server).toBeUndefined()
      expect((pluginModule as Record<string, unknown>).default).toBeUndefined()
    })

    it("registers exactly the five public tools", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      expect(Object.keys(hooks.tool!).sort()).toEqual([
        "akm_curate",
        "akm_feedback",
        "akm_remember",
        "akm_search",
        "akm_show",
      ])
    })

    it("keeps lifecycle hooks alongside the reduced tool surface", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      expect(hooks.event).toBeDefined()
      expect(hooks["chat.message"]).toBeDefined()
      expect(hooks["experimental.chat.system.transform"]).toBeDefined()
      expect(hooks["tool.execute.after"]).toBeDefined()
      expect(hooks["shell.env"]).toBeDefined()
      expect(hooks["tool.execute.before"]).toBeUndefined()
      expect(hooks["experimental.session.compacting"]).toBeUndefined()
      expect((hooks as Record<string, unknown>).stop).toBeUndefined()
    })

    it("does not initialize agent configuration on session creation", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.event!({ event: { type: "session.created", properties: { sessionID: "session-1" } } } as any)

      expect(mockExecFileSync.mock.calls.some(([, args]) => Array.isArray(args) && args.includes("config"))).toBe(false)
    })

    it("logs shell.env failures through OpenCode app logging", async () => {
      const client = createMockClient()
      const hooks = await AkmPlugin(createPluginInput(client))
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

  describe("public tools", () => {
    it("searches in process with current source fields", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_search.execute({
        query: "review",
        type: "skill",
        limit: 3,
        source: "all",
        include_proposed: true,
      } as any, createToolContext())

      expect(mockAkmSearch).toHaveBeenCalledWith({
        query: "review",
        type: "skill",
        limit: 3,
        source: "all",
        includeProposed: true,
      })
      expect(mockExecFileSync.mock.calls.some(([, args]) => Array.isArray(args) && args[0] === "search")).toBe(false)
      expect(JSON.parse(result).warnings).toContain("Do not treat proposed assets as curated until accepted.")
    })

    it("shows a concept-ID reference in process", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      const result = await hooks.tool!.akm_show.execute({
        ref: "knowledge/deploy#Rollback",
        detail: "full",
      } as any, createToolContext())

      expect(mockAkmShowUnified).toHaveBeenCalledWith({
        ref: "knowledge/deploy#Rollback",
        detail: "full",
      })
      expect(mockExecFileSync.mock.calls.some(([, args]) => Array.isArray(args) && args[0] === "show")).toBe(false)
      expect(JSON.parse(result).ref).toBe("knowledge/deploy#Rollback")
    })

    it("curates in process without unsupported scope fields", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_curate.execute({
        query: "deploy safely",
        type: "knowledge",
        limit: 4,
        source: "team-playbook",
      } as any, createToolContext())

      expect(mockAkmCurate).toHaveBeenCalledWith({
        query: "deploy safely",
        type: "knowledge",
        limit: 4,
        source: "team-playbook",
      })
      expect(mockExecFileSync.mock.calls.some(([, args]) => Array.isArray(args) && args[0] === "curate")).toBe(false)
    })

    it("degrades in-process failures into logged structured results", async () => {
      const client = createMockClient()
      mockAkmSearch.mockImplementationOnce(async () => {
        throw new Error("index unavailable")
      })
      const hooks = await AkmPlugin(createPluginInput(client))
      const result = await hooks.tool!.akm_search.execute({ query: "review" } as any, createToolContext())

      expect(JSON.parse(result)).toEqual({ ok: false, error: "index unavailable" })
      expect(client.app.log).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.objectContaining({ message: "AKM in-process call failed" }),
      }))
    })

    it("records feedback through the CLI with supported flags only", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_feedback.execute({
        ref: "skills/review",
        sentiment: "positive",
        note: "useful",
      } as any, createToolContext())

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        ["feedback", "skills/review", "--positive", "--reason", "useful", "--format", "json"],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })

    it("records memories through the CLI with supported scope flags", async () => {
      const hooks = await AkmPlugin(createPluginInput())
      await hooks.tool!.akm_remember.execute({
        content: "Deployment needs VPN",
        name: "ops-vpn",
        force: true,
      } as any, createToolContext())

      expect(mockExecFileSync).toHaveBeenCalledWith(
        "akm",
        [
          "remember",
          "Deployment needs VPN",
          "--name",
          "ops-vpn",
          "--force",
          "--user",
          "user-1",
          "--agent",
          "build",
          "--run",
          "run-1",
          "--channel",
          "review",
          "--format",
          "json",
        ],
        expect.objectContaining({ encoding: "utf8" }),
      )
    })
  })

  describe("memory-candidates atomic updates", () => {
    it("rewrites candidate status through a temp-file rename", async () => {
      const fs = await import("node:fs")
      const { appendCandidates, updateCandidateStatus } = await import("../claude/shared/memory-candidates")
      const dir = mkdtempSync(path.join(tmpdir(), "akm-candidates-atomic-"))
      const candidateLog = path.join(dir, "memory-candidates.jsonl")
      const renameSpy = spyOn(fs, "renameSync")
      try {
        appendCandidates(candidateLog, [{
          id: "cand-atomic-3",
          createdAt: new Date().toISOString(),
          harness: "opencode" as const,
          sessionId: "sess-atomic-3",
          type: "lesson" as const,
          scope: "project" as const,
          content: "Roll forward, never roll back the schema migration.",
          evidence: ["Roll forward, never roll back the schema migration."],
          confidence: 0.7,
          recommendedAction: "distill" as const,
          status: "pending" as const,
        }])
        renameSpy.mockClear()

        const updated = updateCandidateStatus(candidateLog, "cand-atomic-3", "promoted")
        expect(updated?.status).toBe("promoted")
        expect(renameSpy).toHaveBeenCalledTimes(1)
        const [tmpPath, destPath] = renameSpy.mock.calls[0] as unknown as [string, string]
        expect(tmpPath).toContain(".tmp")
        expect(destPath).toBe(candidateLog)
      } finally {
        renameSpy.mockRestore()
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("removes the temp file when the atomic rename fails", async () => {
      const fs = await import("node:fs")
      const { appendCandidates, readCandidates, updateCandidateStatus } = await import("../claude/shared/memory-candidates")
      const dir = mkdtempSync(path.join(tmpdir(), "akm-candidates-atomic-"))
      const candidateLog = path.join(dir, "memory-candidates.jsonl")
      const renameSpy = spyOn(fs, "renameSync")
      try {
        appendCandidates(candidateLog, [{
          id: "cand-rename-fail-1",
          createdAt: new Date().toISOString(),
          harness: "opencode" as const,
          sessionId: "sess-rename-fail-1",
          type: "lesson" as const,
          scope: "project" as const,
          content: "Rename failures must not orphan temp files.",
          evidence: ["Rename failures must not orphan temp files."],
          confidence: 0.7,
          recommendedAction: "distill" as const,
          status: "pending" as const,
        }])
        renameSpy.mockImplementation(() => {
          throw new Error("EXDEV: simulated cross-device rename failure")
        })

        expect(() => updateCandidateStatus(candidateLog, "cand-rename-fail-1", "promoted")).toThrow(
          "simulated cross-device rename failure",
        )
      } finally {
        renameSpy.mockRestore()
      }
      try {
        expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false)
        expect(readCandidates(candidateLog)[0].status).toBe("pending")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("lands successful updates without temp-file residue", async () => {
      const { appendCandidates, readCandidates, updateCandidateStatus } = await import("../claude/shared/memory-candidates")
      const dir = mkdtempSync(path.join(tmpdir(), "akm-candidates-atomic-"))
      const candidateLog = path.join(dir, "memory-candidates.jsonl")
      try {
        appendCandidates(candidateLog, [{
          id: "cand-atomic-1",
          createdAt: new Date().toISOString(),
          harness: "opencode" as const,
          sessionId: "sess-atomic-1",
          type: "lesson" as const,
          scope: "project" as const,
          content: "Always run the migration dry-run first.",
          evidence: ["Always run the migration dry-run first."],
          confidence: 0.7,
          recommendedAction: "distill" as const,
          status: "pending" as const,
        }])

        expect(updateCandidateStatus(candidateLog, "cand-atomic-1", "promoted")?.status).toBe("promoted")
        expect(readCandidates(candidateLog)[0].status).toBe("promoted")
        expect(readdirSync(dir)).toEqual(["memory-candidates.jsonl"])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("leaves the file untouched for an unknown candidate ID", async () => {
      const { appendCandidates, readCandidates, updateCandidateStatus } = await import("../claude/shared/memory-candidates")
      const dir = mkdtempSync(path.join(tmpdir(), "akm-candidates-atomic-"))
      const candidateLog = path.join(dir, "memory-candidates.jsonl")
      try {
        appendCandidates(candidateLog, [{
          id: "cand-atomic-2",
          createdAt: new Date().toISOString(),
          harness: "opencode" as const,
          sessionId: "sess-atomic-2",
          type: "lesson" as const,
          scope: "project" as const,
          content: "Cache invalidation needs a version bump.",
          evidence: ["Cache invalidation needs a version bump."],
          confidence: 0.7,
          recommendedAction: "distill" as const,
          status: "pending" as const,
        }])

        expect(updateCandidateStatus(candidateLog, "does-not-exist", "rejected")).toBeUndefined()
        expect(readCandidates(candidateLog)[0].status).toBe("pending")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
