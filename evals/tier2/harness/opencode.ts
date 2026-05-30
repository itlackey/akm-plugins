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
import { pathToFileURL } from "node:url"
import { existsSync, readFileSync } from "node:fs"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"

let envPatched = false
let envPatchOriginals: Record<string, Function> | null = null

const REPO_ROOT = path.resolve(import.meta.dir, "../../..")

// In Bun, child_process functions invoked WITHOUT an explicit `env`
// option inherit the env captured at process startup, not the current
// process.env. (Node's docs say the default is process.env, but the
// runtime difference is real and observable — see fixture
// `tests/opencode-plugin.test.ts` mocking pattern.) Mutations our
// harness makes to process.env therefore do not reach the plugin's
// execFileSync/spawn calls — including the PATH override needed to
// route `akm` invocations to the fake-akm shim.
//
// The fix is a thin shim that fills in `options.env = process.env` when
// callers omit it. We patch the CJS module instance so plugin code that
// imports from "node:child_process" sees the patched functions.
//
// Scope concerns: every caller in this eval framework that spawns child
// processes WANTS the live process.env (the alternative — spawning with
// stale startup env — is what we're working around). The patch is
// installed once and is idempotent. uninstallEnvPatch() restores the
// originals, useful in tests or in long-lived processes that load the
// harness multiple times.
//
// What we DON'T do: replace this with subprocess-per-scenario. That
// would cold-start the plugin (~500ms × scenarios) and require a
// JSON-RPC protocol for hook IO, with no upside other than avoiding
// this monkey-patch.
function patchChildProcessEnv() {
  if (envPatched) return
  envPatched = true
  envPatchOriginals = {}
  const requireCjs = createRequire(import.meta.url)
  const cp = requireCjs("node:child_process") as Record<string, any>
  const mergeEnv = (options: Record<string, any>) => ({ ...process.env, ...(options.env ?? {}) })
  const normalizeOutput = (value: string | Uint8Array<ArrayBufferLike> | null | undefined, encoding?: string) => {
    const buffer = typeof value === "string" ? Buffer.from(value) : Buffer.from(value ?? [])
    return encoding ? buffer.toString(encoding === "buffer" ? "utf8" : encoding) : buffer
  }
  const buildError = (
    commandLabel: string,
    stdout: Buffer,
    stderr: Buffer,
    status: number,
    code?: string,
  ) => {
    const error = new Error(stderr.toString("utf8") || stdout.toString("utf8") || `Command failed: ${commandLabel}`) as Error & {
      status?: number
      code?: string
      stdout?: Buffer
      stderr?: Buffer
    }
    error.status = status
    if (code) error.code = code
    error.stdout = stdout
    error.stderr = stderr
    return error
  }
  for (const name of ["execFileSync", "execSync", "spawn", "spawnSync", "execFile", "exec"]) {
    const original = cp[name] as Function
    if (typeof original !== "function") continue
    envPatchOriginals[name] = original
    if (name === "execFileSync") {
      cp[name] = function patchedExecFileSync(command: string, args: string[] = [], options: Record<string, any> = {}) {
        const merged = { ...options, env: mergeEnv(options) }
        const result = Bun.spawnSync([command, ...args], {
          cwd: merged.cwd,
          env: merged.env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        })
        const stdout = Buffer.from(result.stdout ?? [])
        const stderr = Buffer.from(result.stderr ?? [])
        if (result.exitCode !== 0) throw buildError([command, ...args].join(" "), stdout, stderr, result.exitCode ?? 1, result.signalCode ?? undefined)
        return normalizeOutput(stdout, merged.encoding)
      }
      continue
    }
    if (name === "execSync") {
      cp[name] = function patchedExecSync(command: string, options: Record<string, any> = {}) {
        const merged = { ...options, env: mergeEnv(options) }
        const result = Bun.spawnSync(["sh", "-lc", command], {
          cwd: merged.cwd,
          env: merged.env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        })
        const stdout = Buffer.from(result.stdout ?? [])
        const stderr = Buffer.from(result.stderr ?? [])
        if (result.exitCode !== 0) throw buildError(command, stdout, stderr, result.exitCode ?? 1, result.signalCode ?? undefined)
        return normalizeOutput(stdout, merged.encoding)
      }
      continue
    }
    if (name === "spawn") {
      cp[name] = function patchedSpawn(command: string, args: string[] = [], options: Record<string, any> = {}) {
        const merged = { ...options, env: mergeEnv(options) }
        const subprocess = Bun.spawn([command, ...args], {
          cwd: merged.cwd,
          env: merged.env,
          stdin: "ignore",
          stdout: merged.stdio === "ignore" ? "ignore" : "pipe",
          stderr: merged.stdio === "ignore" ? "ignore" : "pipe",
        })
        return {
          on(event: string, handler: (...handlerArgs: any[]) => void) {
            if (event === "error") {
              subprocess.exited.then((code) => {
                if ((code ?? 0) !== 0) {
                  handler(buildError([command, ...args].join(" "), Buffer.alloc(0), Buffer.alloc(0), code ?? 1))
                }
              }).catch((error) => handler(error))
            }
            return this
          },
          unref() {
            return this
          },
        }
      }
      continue
    }
  }
}

export function uninstallEnvPatch() {
  if (!envPatched || !envPatchOriginals) return
  const requireCjs = createRequire(import.meta.url)
  const cp = requireCjs("node:child_process") as Record<string, any>
  for (const [name, original] of Object.entries(envPatchOriginals)) {
    cp[name] = original
  }
  envPatched = false
  envPatchOriginals = null
}

// Stub fetch so ensureLatestAkmInstalled doesn't try to hit the real
// npm registry during plugin import or construction. Returning a 404
// makes getLatestNpmPackageVersion return null, which causes the plugin
// to gracefully use the on-PATH akm (our fake) without attempting to
// `bun install -g` the real CLI globally.
function stubFetch() {
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

async function loadPlugin(): Promise<{ AkmPlugin: Plugin }> {
  patchChildProcessEnv()
  const restore = stubFetch()
  try {
    const pluginUrl = pathToFileURL(path.join(REPO_ROOT, "opencode/index.ts"))
    return await import(`${pluginUrl.href}?eval-harness=${Date.now()}`)
  } finally {
    restore()
  }
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

const REF_RE = /\b(skill|command|agent|knowledge|memory|lesson|script|workflow|task|vault|wiki):[A-Za-z0-9._\/-]+/g
const CURATED_FILE_RE = /AKM stash curation written to `([^`]+)`/g

function hydrateCuratedContext(context: string): string {
  let expanded = context
  for (const match of context.matchAll(CURATED_FILE_RE)) {
    const filePath = match[1]
    try {
      if (filePath && existsSync(filePath)) {
        expanded = `${expanded}\n${readFileSync(filePath, "utf8")}`
      }
    } catch {
      // Best-effort only; keep the original host-injected context if the file disappears.
    }
  }
  return expanded
}

export function parseRefs(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of hydrateCuratedContext(text).matchAll(REF_RE)) {
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
  const restore = stubFetch()
  try {
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
  } finally {
    restore()
  }
}
