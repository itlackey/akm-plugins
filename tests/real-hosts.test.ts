import { afterEach, describe, expect, it } from "bun:test"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { installFakeAkm, readCallLog } from "../evals/lib/fake-akm"
import { IS_WINDOWS, hostEnv, makeBinDir, sandboxPath } from "./host-runtime"

// The real Claude Code and the real Codex, started offline against this checkout's plugin, with the repo's fake
// akm on PATH: what the other hook tests emulate from the hosts' documentation and source, run by the hosts
// themselves. Neither host is given a credential or makes a model call:
//
// - `claude -p "<prompt>"` with no login runs SessionStart, UserPromptSubmit and SessionEnd hooks, then stops at
//   "Not logged in" before anything is sent anywhere.
// - `codex exec` runs its SessionStart and UserPromptSubmit hooks before the model request, and the model
//   provider here is a dead local port, so the request is refused on the machine.
//
// Skipped unless AKM_REAL_CLAUDE_BIN / AKM_REAL_CODEX_BIN point at the host's executable (the Windows CI job installs
// both from npm). The state they write goes under a temp tree; nothing outside it is read or written.

const repoRoot = path.resolve(import.meta.dir, "..")
const fixtureStash = path.join(repoRoot, "evals/fixtures/stash")
const claudeBin = process.env.AKM_REAL_CLAUDE_BIN
const codexBin = process.env.AKM_REAL_CODEX_BIN
const claudeManifest = JSON.parse(readFileSync(path.join(repoRoot, "claude/.claude-plugin/plugin.json"), "utf8"))
const claudeHandlerCount = Object.values(claudeManifest.hooks as Record<string, Array<{ hooks: unknown[] }>>).reduce(
  (total, groups) => total + groups.reduce((sum, group) => sum + group.hooks.length, 0),
  0,
)

// What Codex hashes to decide whether the user already trusted a hook: the command for the platform (`command`, or
// `commandWindows` on Windows) with the timeout and status message, not the version or the install path. Changing any
// of them asks every Codex user to trust the hooks again, so a change here is a decision. The same on Codex 0.147.0,
// 0.159.0 and 0.159.3.
const TRUST_HASHES = {
  posix: {
    sessionStart: "sha256:179686e716a7d991572fa95bdb62da4ba36bdf04ccd5b51d9a06316270b7708f",
    userPromptSubmit: "sha256:fd4b7b7159980e2bba6c702636a67a6e808c5e03236ab15cf1b998d88520a3b5",
  },
  windows: {
    sessionStart: "sha256:e7e57212c07fed2b3a1379af5e9673427775519d8fc3a0a7956037eb63dc0e2b",
    userPromptSubmit: "sha256:c66747d1d7ca0b86602c058a8b4d7c3b765e5826295de7abb5791d993e9c9d74",
  },
}

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {}
  }
})

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const value = probe()
      if (value !== undefined) return value
    } catch {
      // Not there yet.
    }
    if (Date.now() >= deadline) throw new Error("waitFor timed out")
    await Bun.sleep(100)
  }
}

/** A home, a project, a PATH holding the fake akm, and an environment that carries no host credential or setting of the machine's own. */
function makeSandbox() {
  const root = mkdtempSync(path.join(tmpdir(), "akm-real-host-"))
  tempDirs.push(root)
  const home = path.join(root, "home")
  const project = path.join(root, "project")
  const xdgState = path.join(root, "xdg-state")
  const callLog = path.join(root, "akm-calls.log")
  for (const dir of [home, project, xdgState]) mkdirSync(dir, { recursive: true })
  const binDir = makeBinDir(root)
  installFakeAkm({ binDir, callLog, assets: { stashDir: fixtureStash } })
  const env = (extra: Record<string, string>) =>
    hostEnv(
      {
        HOME: home,
        XDG_STATE_HOME: xdgState,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".data"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        PATH: sandboxPath(binDir),
        AKM_AUTO_LEARNING: "0",
        AKM_BUNDLE_DIR: fixtureStash,
        ...extra,
      },
      (name) => /^(AKM_|XDG_|CLAUDE|ANTHROPIC_|CODEX_|OPENAI_|PLUGIN_)/i.test(name),
    )
  return { root, home, project, xdgState, callLog, env }
}

function lines(file: string) {
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
}

describe.skipIf(!claudeBin)("the real Claude Code", () => {
  it(
    "installs the plugin from this checkout and runs its hooks through exec form, offline and without a login",
    async () => {
      const sandbox = makeSandbox()
      const configDir = path.join(sandbox.root, "claude-config")
      const debugLog = path.join(sandbox.root, "claude-debug.log")
      const env = sandbox.env({ CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" })
      const claude = (args: string[]) =>
        Bun.spawnSync([claudeBin as string, ...args], { cwd: sandbox.project, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000 })

      const added = claude(["plugin", "marketplace", "add", repoRoot])
      expect({ step: "marketplace add", exit: added.exitCode, out: added.stdout.toString() + added.stderr.toString() }).toMatchObject({ exit: 0 })
      const installed = claude(["plugin", "install", "akm@akm-plugins"])
      expect({ step: "plugin install", exit: installed.exitCode, out: installed.stdout.toString() + installed.stderr.toString() }).toMatchObject({ exit: 0 })

      const prompt = "help me plan the akm release rollout this afternoon"
      const run = claude(["-p", prompt, "--debug-file", debugLog])
      // No login, so it stops there: the answer is "Not logged in" and nothing has been sent anywhere.
      expect((run.stdout.toString() + run.stderr.toString()).toLowerCase()).toContain("not logged in")

      // Claude Code registered exactly this manifest's handlers, from the plugin it installed.
      const debug = readFileSync(debugLog, "utf8")
      expect(debug).toContain(`Registered ${claudeHandlerCount} hooks`)
      // SessionStart, through `bun <plugin root>/hooks/akm-hook.ts session-start` with no shell: the hook found akm and
      // asked it for its version, and Claude Code accepted what the hook printed.
      expect(debug).toMatch(/Hook SessionStart:startup \(SessionStart\) success/)
      const stateDir = path.join(sandbox.xdgState, "akm-claude")
      expect(lines(path.join(stateDir, "session.log"))[0]).toContain("akm_ready\tpath")
      // UserPromptSubmit: the prompt was recorded and handed to akm to curate.
      expect(readFileSync(path.join(stateDir, "feedback.log"), "utf8")).toContain(`user\tprompt\t${prompt}`)
      const calls = readCallLog(sandbox.callLog)
      expect(calls.some((call) => call.argv[0] === "--version")).toBe(true)
      expect(calls.find((call) => call.argv[0] === "curate" && call.argv[1] === prompt)).toBeTruthy()
      expect(lines(path.join(stateDir, "events.jsonl")).map((line) => JSON.parse(line).harness)).not.toContain("codex")
      // SessionEnd: the reindex it starts detached outlives Claude Code's own hook runner.
      expect(debug).toMatch(/SessionEnd:other \[bun \$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/akm-hook\.ts session-end\] completed with status 0/)
      await waitFor(() => (readCallLog(sandbox.callLog).some((call) => call.argv[0] === "index") ? true : undefined), 60_000)
    },
    240_000,
  )
})

type RpcClient = { request: (method: string, params: unknown) => Promise<any>; notify: (method: string) => void; close: () => void }

/** A just-enough JSON-RPC client for `codex app-server` over stdio. */
function startAppServer(env: Record<string, string>, cwd: string): RpcClient {
  const proc = Bun.spawn([codexBin as string, "app-server"], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  const waiters = new Map<number, (message: any) => void>()
  ;(async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk)
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          const message = JSON.parse(line)
          if (typeof message.id === "number") waiters.get(message.id)?.(message)
        } catch {}
      }
    }
  })()
  let nextId = 1
  return {
    request(method, params) {
      const id = nextId++
      const answer = new Promise((resolve) => waiters.set(id, resolve))
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      proc.stdin.flush()
      return Promise.race([answer, new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer to ${method}`)), 60_000))])
    },
    notify(method) {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`)
      proc.stdin.flush()
    },
    close() {
      proc.kill()
    },
  }
}

describe.skipIf(!codexBin)("the real Codex", () => {
  it(
    "installs the plugin from this checkout and runs both hooks, offline, with the Windows command on Windows",
    async () => {
      const sandbox = makeSandbox()
      const codexHome = path.join(sandbox.root, "codex-home")
      mkdirSync(codexHome, { recursive: true })
      const env = sandbox.env({ CODEX_HOME: codexHome })
      const codex = (args: string[]) => Bun.spawnSync([codexBin as string, ...args], { cwd: sandbox.project, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000 })

      const added = codex(["plugin", "marketplace", "add", repoRoot])
      expect({ step: "marketplace add", exit: added.exitCode, out: added.stdout.toString() + added.stderr.toString() }).toMatchObject({ exit: 0 })
      const installed = codex(["plugin", "add", "akm@akm-plugins"])
      expect({ step: "plugin add", exit: installed.exitCode, out: installed.stdout.toString() + installed.stderr.toString() }).toMatchObject({ exit: 0 })

      // Exactly the two hooks, untrusted until reviewed, with this platform's command: Codex hashes the effective one.
      const server = startAppServer(env, sandbox.project)
      let hooks: Array<{ eventName: string; key: string; trustStatus: string; currentHash: string; command: string }>
      try {
        await server.request("initialize", { clientInfo: { name: "akm-plugins-test", version: "0.0.0" } })
        server.notify("initialized")
        hooks = (await server.request("hooks/list", { cwds: [sandbox.project] })).result.data[0].hooks
      } finally {
        server.close()
      }
      expect(hooks.map((hook) => hook.eventName).sort()).toEqual(["sessionStart", "userPromptSubmit"])
      expect(hooks.every((hook) => hook.trustStatus === "untrusted")).toBe(true)
      expect(Object.fromEntries(hooks.map((hook) => [hook.eventName, hook.currentHash]))).toEqual(TRUST_HASHES[IS_WINDOWS ? "windows" : "posix"])
      for (const hook of hooks) {
        expect(hook.command).toContain(IS_WINDOWS ? "--harness=codex" : "AKM_PLUGIN_HARNESS=codex")
        expect(hook.command).not.toContain("${")
      }

      // Trust them the way /hooks does, and point the model provider at a port nothing listens on. Top-level keys
      // go first: after a table header they would belong to that table.
      const configPath = path.join(codexHome, "config.toml")
      const existing = readFileSync(configPath, "utf8")
      writeFileSync(
        configPath,
        [
          'model = "dead"',
          'model_provider = "dead"',
          "",
          "[model_providers.dead]",
          'name = "dead"',
          'base_url = "http://127.0.0.1:9/v1"',
          'wire_api = "responses"',
          "requires_openai_auth = false",
          "request_max_retries = 0",
          "stream_max_retries = 0",
          "",
          existing,
        ].join("\n"),
      )
      for (const hook of hooks) appendFileSync(configPath, `\n[hooks.state."${hook.key}"]\ntrusted_hash = "${hook.currentHash}"\n`)

      const prompt = "help me plan the akm release rollout this afternoon"
      const proc = Bun.spawn([codexBin as string, "exec", "--skip-git-repo-check", "--json", "-s", "danger-full-access", prompt], {
        cwd: sandbox.project,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      try {
        // Both hooks fire before the model request, which then fails; newer Codex keeps retrying, so stop it once they have.
        const dataDir = path.join(codexHome, "plugins", "data", "akm-akm-plugins")
        const events = await waitFor(() => {
          const logged = lines(path.join(dataDir, "events.jsonl")).map((line) => JSON.parse(line))
          return logged.some((event) => event.event === "prompt_recall") ? logged : undefined
        }, 90_000)
        expect(events.map((event) => event.event)).toEqual(["session_started", "prompt_recall"])
        expect(events.every((event) => event.harness === "codex")).toBe(true)
        expect(new Set(events.map((event) => event.sessionId)).size).toBe(1)
        const calls = readCallLog(sandbox.callLog)
        expect(calls.some((call) => call.argv[0] === "--version")).toBe(true)
        expect(calls.find((call) => call.argv[0] === "curate" && call.argv[1] === prompt)).toBeTruthy()
        expect(readFileSync(path.join(dataDir, "feedback.log"), "utf8")).toContain(`user\tprompt\t${prompt}`)
        // Nothing of Codex's went to Claude's state.
        expect(existsSync(path.join(sandbox.xdgState, "akm-claude"))).toBe(false)
        expect(existsSync(path.join(sandbox.home, ".local/state/akm-claude"))).toBe(false)
      } finally {
        proc.kill()
        if (IS_WINDOWS) Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(proc.pid)], { stdout: "ignore", stderr: "ignore" })
      }
    },
    300_000,
  )
})
