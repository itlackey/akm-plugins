// Tier-2 harness for the OpenCode plugin (akm-opencode).
//
// The OpenCode plugin is TypeScript that imports @opencode-ai/plugin and
// spawns `akm` via execFileSync. We instantiate AkmPlugin with a mock
// client and drive its lifecycle hooks directly, mirroring the test
// pattern in tests/opencode-plugin.test.ts:1-80.
//
// Retrieval is held constant by installing the same fake-akm shim used
// by the Claude harness onto PATH — the plugin's child_process spawns
// will hit the deterministic shim.
//
// Note on env handling: Bun caches process.env at startup, so mutations
// from inside the harness are NOT visible to child_process spawns
// unless we pass env explicitly. We monkey-patch execFileSync/execSync
// once below to merge in the live process.env when callers omit it.

import path from "node:path"
import { createRequire } from "node:module"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"

let cachedPlugin: any | null = null
let envPatched = false

const REPO_ROOT = path.resolve(import.meta.dir, "../../..")

// Bun caches process.env at startup, so child_process spawns ignore env
// mutations made after import unless callers pass env explicitly. We
// monkey-patch the CJS instance of node:child_process to inject the live
// process.env when callers omit it. The plugin only ever uses the CJS
// build via its own `import { execFileSync } from "node:child_process"`,
// which Bun resolves to the same underlying object — so this patch
// reaches every callsite transparently.
function patchChildProcessEnv() {
  if (envPatched) return
  envPatched = true
  const requireCjs = createRequire(import.meta.url)
  const cp = requireCjs("node:child_process") as Record<string, any>
  for (const name of ["execFileSync", "execSync", "spawn", "spawnSync", "execFile", "exec"]) {
    const original = cp[name] as Function
    if (typeof original !== "function") continue
    cp[name] = function patched(...args: any[]) {
      let optionsIdx = -1
      for (let i = args.length - 1; i >= 0; i--) {
        if (args[i] && typeof args[i] === "object" && !Array.isArray(args[i]) && typeof args[i] !== "function") {
          optionsIdx = i
          break
        }
      }
      const options = optionsIdx >= 0 ? { ...args[optionsIdx] } : {}
      if (!options.env) options.env = { ...process.env }
      if (optionsIdx >= 0) args[optionsIdx] = options
      else args.push(options)
      return original.apply(this, args)
    }
  }
}

// Stub fetch so ensureLatestAkmInstalled doesn't try to hit the real
// npm registry on plugin construction. Returning a 404 makes
// getLatestNpmPackageVersion return null, which causes the plugin to
// gracefully use the on-PATH akm (our fake) without attempting to
// `bun install -g` the real CLI globally.
function stubFetch() {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

async function loadPlugin(): Promise<{ AkmPlugin: Plugin }> {
  if (cachedPlugin) return cachedPlugin
  patchChildProcessEnv()
  const restore = stubFetch()
  try {
    cachedPlugin = await import(path.join(REPO_ROOT, "opencode/index.ts"))
  } finally {
    restore()
  }
  return cachedPlugin
}

export type CapturedLogEntry = {
  level: string
  message: string
  service?: string
  extra?: Record<string, unknown>
}

export type MockClient = {
  app: {
    log: (args: { query?: unknown; body: { service: string; level: string; message: string; extra?: Record<string, unknown> } }) => Promise<{ data: unknown; error: undefined }>
    agents: () => Promise<{ data: Array<{ name: string }>; error: undefined }>
  }
  session: {
    create: () => Promise<{ data: { id: string }; error: undefined }>
    get: () => Promise<{ data: { id: string; parentID?: string }; error: undefined }>
    messages: () => Promise<{ data: Array<unknown>; error: undefined }>
    prompt: () => Promise<{ data: { parts: Array<unknown> }; error: undefined }>
  }
  __logs: CapturedLogEntry[]
}

export function createMockClient(): MockClient {
  const logs: CapturedLogEntry[] = []
  return {
    app: {
      log: async (args) => {
        const body = args?.body
        if (body) {
          logs.push({
            level: body.level,
            message: body.message,
            service: body.service,
            extra: body.extra,
          })
        }
        return { data: {}, error: undefined }
      },
      agents: async () => ({
        data: [{ name: "general" }, { name: "akm-curator" }],
        error: undefined,
      }),
    },
    session: {
      create: async () => ({ data: { id: "child-session-1" }, error: undefined }),
      get: async () => ({ data: { id: "child-session-1", parentID: "parent-session-root" }, error: undefined }),
      messages: async () => ({ data: [], error: undefined }),
      prompt: async () => ({ data: { parts: [{ type: "text", text: "ok" }] }, error: undefined }),
    },
    __logs: logs,
  }
}

export type OpenCodeHarness = {
  hooks: any
  client: MockClient
  // Trigger curation for a prompt and capture the system-prompt blocks the
  // plugin would inject. Returns the joined block text plus the refs
  // extracted from it.
  curateAndExtract(args: { sessionID: string; prompt: string }): Promise<{ context: string; refs: string[]; durationMs: number }>
  // Drive a tool.execute.after with synthetic output and return a snapshot
  // of any logs the plugin wrote (feedback subsystem entries are what we
  // care about).
  toolAfter(args: { sessionID: string; tool: string; toolArgs: Record<string, unknown>; output: string; title?: string }): Promise<{ logs: CapturedLogEntry[]; durationMs: number }>
}

const REF_RE = /\b(skill|command|agent|knowledge|memory|script|workflow|vault|wiki|lesson):[A-Za-z0-9._\/-]+/g

export function parseRefs(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(REF_RE)) {
    if (!seen.has(m[0])) {
      seen.add(m[0])
      out.push(m[0])
    }
  }
  return out
}

export async function createOpenCodeHarness(env: Record<string, string>): Promise<OpenCodeHarness> {
  // Apply env at process scope — the plugin reads env at import time, so
  // this must happen before loadPlugin().
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v
  }
  const { AkmPlugin } = await loadPlugin()
  const client = createMockClient()
  const input: PluginInput = {
    client: client as any,
    project: {} as any,
    directory: env.AKM_STASH_DIR ?? "/tmp/test-project",
    worktree: env.AKM_STASH_DIR ?? "/tmp/test-project",
    serverUrl: new URL("http://localhost:3000"),
    $: {} as any,
  }
  const hooks = await AkmPlugin(input)

  return {
    hooks,
    client,
    async curateAndExtract({ sessionID, prompt }) {
      const start = performance.now()
      // chat.message triggers per-prompt curation and stashes results in
      // sessionCurated[sid]. The system.transform hook then drains those
      // into the system prompt array.
      await hooks["chat.message"](
        { sessionID, messageID: `msg-${sessionID}`, agent: "build" },
        { parts: [{ type: "text", text: prompt }] },
      )
      const output: { system: string[] } = { system: [] }
      await hooks["experimental.chat.system.transform"]({ sessionID }, output)
      const durationMs = performance.now() - start
      const context = output.system.join("\n")
      return { context, refs: parseRefs(context), durationMs }
    },
    async toolAfter({ sessionID, tool, toolArgs, output, title }) {
      const before = client.__logs.length
      const start = performance.now()
      await hooks["tool.execute.after"](
        { tool, sessionID, callID: `call-${sessionID}`, args: toolArgs },
        { output, title: title ?? tool },
      )
      const durationMs = performance.now() - start
      return { logs: client.__logs.slice(before), durationMs }
    },
  }
}
