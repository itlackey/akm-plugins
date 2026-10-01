import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { installFakeAkm, readCallLog } from "../evals/lib/fake-akm"
import { spawnPlan } from "../claude/shared/spawn-plan"
import { IS_WINDOWS, hostEnv, makeBinDir, runClaudeHandler, sandboxPath, whichOn, type ClaudeHandler } from "./host-runtime"

// The Claude Code hooks, run the way Claude Code runs them: every handler in
// .claude-plugin/plugin.json is exec form, so there is no shell between the host and
// `bun claude/hooks/akm-hook.ts <mode>`. These tests take the handlers out of the
// manifest and run them through that exec path, with the repo's fake akm on PATH,
// on every platform CI covers. On Windows the fake is akm.cmd, as npm installs it.

const repoRoot = path.resolve(import.meta.dir, "..")
const pluginDir = path.join(repoRoot, "claude")
const hookSource = readFileSync(path.join(pluginDir, "hooks/akm-hook.ts"), "utf8")
const manifest = JSON.parse(readFileSync(path.join(pluginDir, ".claude-plugin/plugin.json"), "utf8"))
const fixtureStash = path.join(repoRoot, "evals/fixtures/stash")
const SESSION_ID = "019c3f2e-7a41-7d10-b8a5-0f3c2d9e6b14"

const handlers: Array<{ event: string; matcher?: string; handler: ClaudeHandler }> = Object.entries(manifest.hooks as Record<string, any[]>).flatMap(
  ([event, groups]) => groups.flatMap((group) => group.hooks.map((handler: ClaudeHandler) => ({ event, matcher: group.matcher as string | undefined, handler }))),
)

const tempDirs: string[] = []

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "akm-hook-commands-"))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  // A detached akm child may still hold a file for a moment; Windows will not
  // delete an open file, and a leftover temp directory is not a test failure.
  if (IS_WINDOWS) await Bun.sleep(300)
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {}
  }
})

/** Poll until `probe` returns a value: the akm index / extract children are detached and outlive the hook. */
async function waitFor<T>(probe: () => T | undefined, timeoutMs = IS_WINDOWS ? 30_000 : 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const value = probe()
      if (value !== undefined) return value
    } catch {
      // Not there yet.
    }
    if (Date.now() >= deadline) throw new Error("waitFor timed out")
    await Bun.sleep(50)
  }
}

/** Wait for the detached akm children the hooks started, so the sandbox is quiet before it is deleted. */
async function settle(sandbox: Sandbox, expected: { index: number; extract?: boolean }) {
  await waitFor(() => (readCallLog(sandbox.callLog).filter((call) => call.argv[0] === "index").length >= expected.index ? true : undefined))
  if (expected.extract) {
    await waitFor(() => (readFileSync(path.join(sandbox.stateDir, "extract.log"), "utf8").includes("LLM_NOT_CONFIGURED") ? true : undefined))
  }
}

type Sandbox = { root: string; home: string; xdgState: string; project: string; binDir: string; callLog: string; stateDir: string }

/** One temp tree per test: a home, a project to run in, a bin dir with the fake akm (unless `withAkm` is false). */
function makeSandbox(options: { withAkm?: boolean; binDirName?: string } = {}): Sandbox {
  const root = makeTempDir()
  const sandbox: Sandbox = {
    root,
    home: path.join(root, "home"),
    xdgState: path.join(root, "xdg-state"),
    project: path.join(root, "project"),
    binDir: makeBinDir(root, options.binDirName),
    callLog: path.join(root, "akm-calls.log"),
    stateDir: path.join(root, "xdg-state", "akm-claude"),
  }
  for (const dir of [sandbox.home, sandbox.project]) mkdirSync(dir, { recursive: true })
  if (options.withAkm !== false) installFakeAkm({ binDir: sandbox.binDir, callLog: sandbox.callLog, assets: { stashDir: fixtureStash } })
  return sandbox
}

function sandboxEnv(sandbox: Sandbox, extra: Record<string, string | undefined> = {}) {
  return hostEnv(
    {
      HOME: sandbox.home,
      XDG_STATE_HOME: sandbox.xdgState,
      PATH: sandboxPath(sandbox.binDir),
      // A test that exercises proposal submission turns this on itself.
      AKM_AUTO_LEARNING: "0",
      ...extra,
    },
    (name) => /^(AKM_|XDG_|CLAUDE_PLUGIN_|PLUGIN_)/.test(name),
  )
}

function handlerFor(mode: string, extra?: string) {
  const entry = handlers.find(({ handler }) => handler.args?.[1] === mode && (extra === undefined || handler.args?.[2] === extra))
  if (!entry) throw new Error(`no handler for ${mode}`)
  return entry.handler
}

function runHandler(handler: ClaudeHandler, sandbox: Sandbox, payload: unknown, env: Record<string, string | undefined> = {}) {
  const inputPath = path.join(makeTempDir(), "stdin.json")
  writeFileSync(inputPath, JSON.stringify(payload))
  return runClaudeHandler(handler, { pluginRoot: pluginDir, cwd: sandbox.project, env: sandboxEnv(sandbox, env), stdin: Bun.file(inputPath) })
}

function readLines(filePath: string) {
  return readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean)
}

/** The stdin a hook gets for each mode: the common fields plus what that event adds. */
function payloadFor(mode: string, sandbox: Sandbox): unknown {
  const common = { session_id: SESSION_ID, cwd: sandbox.project }
  switch (mode) {
    case "curate-prompt":
      return { ...common, prompt: "help me plan the akm release rollout this afternoon" }
    case "user-prompt-expansion":
      return { ...common, command: "/akm-search release rollout" }
    case "post-tool":
    case "auto-feedback":
      return { ...common, tool: "Bash", input: { command: "akm workflow run workflows/release" }, output: '{"workflowRef":"workflows/release"}' }
    case "post-tool-nonbash":
      return { ...common, tool: "Read", input: { file_path: path.join(sandbox.project, "notes.md") }, output: "" }
    case "post-tool-batch":
      return { ...common, tools: [{ tool: "Bash", input: { command: "echo hi" } }] }
    case "subagent-start":
      return { ...common, agent: "Explore", prompt: "look around the repository" }
    case "task-created":
      return { ...common, task_id: "t1", title: "write the tests" }
    case "task-completed":
      return { ...common, task_id: "t1", summary: "wrote the tests" }
    case "post-compact":
      return { ...common, summary: "compacted the session" }
    case "extract-session": {
      const transcript = path.join(sandbox.root, `${SESSION_ID}.jsonl`)
      writeFileSync(transcript, '{"type":"user"}\n')
      return { ...common, reason: "other", transcript_path: transcript }
    }
    default:
      return { ...common, reason: "other" }
  }
}

describe("Claude plugin manifest hook commands", () => {
  it("declares every hook in exec form: bun runs the hook script, no shell in between", () => {
    expect(handlers.length).toBeGreaterThan(0)
    for (const { handler } of handlers) {
      expect(handler.type).toBe("command")
      // Exec form is what makes one declaration valid on Windows with or without Git Bash,
      // on macOS and on Linux. `sh ...` would not start under PowerShell.
      expect(handler.command).toBe("bun")
      expect(Array.isArray(handler.args)).toBe(true)
      const [script, mode, ...rest] = handler.args as string[]
      expect(script).toBe("${CLAUDE_PLUGIN_ROOT}/hooks/akm-hook.ts")
      // Arguments are passed verbatim, so each is a bare word: no quoting, no placeholder but the script.
      for (const arg of [mode, ...rest]) expect(arg).toMatch(/^[a-z]+(?:-[a-z]+)*$/)
      expect(rest.length).toBeLessThanOrEqual(1)
      // The mode has to be one the hook dispatches on.
      expect(hookSource).toContain(`case "${mode}":`)
    }
    expect(existsSync(path.join(pluginDir, "hooks/akm-hook.ts"))).toBe(true)
  })

  it("every registered handler runs through the exec path and dispatches to a real mode", async () => {
    const sandbox = makeSandbox()
    for (const { event, handler } of handlers) {
      const mode = (handler.args as string[])[1]
      const result = runHandler(handler, sandbox, payloadFor(mode, sandbox), {
        // The post-tool handlers validate refs against the bundle without asking akm for it.
        AKM_BUNDLE_DIR: fixtureStash,
      })
      expect({ event, mode, exitCode: result.exitCode, stderr: result.stderr }).toEqual({ event, mode, exitCode: 0, stderr: "" })
      // Hooks answer with nothing or with one JSON object; Claude Code ignores anything else.
      if (result.stdout.trim()) expect(JSON.parse(result.stdout)).toBeInstanceOf(Object)
    }
    // An unrecognised mode is logged as runtime_error: none of the manifest's may be.
    expect(readLines(path.join(sandbox.stateDir, "session.log")).filter((line) => line.includes("runtime_error"))).toEqual([])
    // session-start and session-end each reindex, and extract-session starts `akm proposal extract`.
    await settle(sandbox, { index: 2, extract: true })
  })
})

describe("Claude hooks through the manifest commands", () => {
  it("session-start finds akm, prints the primer, and keeps state under XDG_STATE_HOME", async () => {
    const sandbox = makeSandbox()
    writeFileSync(path.join(sandbox.project, "package.json"), JSON.stringify({ name: "release-tooling", description: "Release tooling" }))
    const env = sandboxEnv(sandbox)
    // No Git Bash on this machine as far as the hook can tell: `sh` is not on PATH.
    if (IS_WINDOWS) expect(whichOn("sh", env.PATH ?? "")).toBeUndefined()

    const result = runHandler(handlerFor("session-start"), sandbox, payloadFor("session-start", sandbox))

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout)
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart")
    expect(payload.hookSpecificOutput.additionalContext).toContain("# AKM is available in this session")
    const calls = readCallLog(sandbox.callLog)
    expect(calls.some((call) => call.argv[0] === "--version")).toBe(true)
    expect(calls.find((call) => call.argv[0] === "curate")?.argv[1]).toContain("release-tooling")
    expect(readLines(path.join(sandbox.stateDir, "session.log"))[0]).toContain("akm_ready\tpath")
    expect(readLines(path.join(sandbox.stateDir, "events.jsonl")).map((line) => JSON.parse(line).harness)).toEqual(["claude-code"])
    // It also starts a detached `akm index`.
    await settle(sandbox, { index: 1 })
  })

  it("curate-prompt hands the prompt to akm as typed and injects what akm returns", () => {
    const sandbox = makeSandbox()
    const prompt = "help me plan the akm release rollout this afternoon"

    const result = runHandler(handlerFor("curate-prompt"), sandbox, { ...(payloadFor("curate-prompt", sandbox) as object), prompt })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout)
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
    expect(payload.hookSpecificOutput.additionalContext).toContain("AKM PROVENANCE")
    expect(payload.hookSpecificOutput.additionalContext).toContain("commands/bump-version")
    expect(readCallLog(sandbox.callLog).find((call) => call.argv[0] === "curate")?.argv[1]).toBe(prompt)
  })

  it("curate-prompt runs akm from a directory with a space in its path, with a multi-word query", () => {
    // `C:\Users\Jane Doe\AppData\Roaming\npm\akm.cmd` is a real install location, and cmd.exe
    // mis-parses a quoted argument beside a quoted program path that holds a space.
    const sandbox = makeSandbox({ binDirName: "akm bin dir" })
    const prompt = "help me plan the akm release rollout this afternoon"

    const result = runHandler(handlerFor("curate-prompt"), sandbox, { ...(payloadFor("curate-prompt", sandbox) as object), prompt })

    expect(result.exitCode).toBe(0)
    expect(readCallLog(sandbox.callLog).find((call) => call.argv[0] === "curate")?.argv[1]).toBe(prompt)
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain("commands/bump-version")
  })

  it("curate-prompt curates a prompt full of shell metacharacters and runs none of it", () => {
    const sandbox = makeSandbox()
    const marker = path.join(sandbox.root, "pwned.txt")
    // Quotes, & | < > ^ % and a line break are what cmd.exe re-parses in akm.cmd's command line. On Windows
    // they reach akm as spaces (they cannot be quoted for cmd.exe); everywhere else they arrive untouched.
    const prompt = `plan the akm release rollout "now" & echo pwned > "${marker}" | type x < y ^ 100% done`

    const result = runHandler(handlerFor("curate-prompt"), sandbox, { ...(payloadFor("curate-prompt", sandbox) as object), prompt })

    expect(result.exitCode).toBe(0)
    expect(existsSync(marker)).toBe(false)
    const curate = readCallLog(sandbox.callLog).find((call) => call.argv[0] === "curate")
    expect(curate?.argv[1]).toBe(IS_WINDOWS ? prompt.replace(/["%&|<>^\r\n]/g, " ") : prompt)
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain("AKM PROVENANCE")
  })

  it("auto-feedback submits positive feedback through akm for a ref a successful akm command used", () => {
    const sandbox = makeSandbox()

    const result = runHandler(handlerFor("auto-feedback", "success"), sandbox, payloadFor("auto-feedback", sandbox), { AKM_BUNDLE_DIR: fixtureStash })

    expect(result.exitCode).toBe(0)
    const feedback = readCallLog(sandbox.callLog).find((call) => call.argv[0] === "feedback")
    expect(feedback?.argv.slice(0, 3)).toEqual(["feedback", "workflows/release", "--positive"])
    // The reason carries `;` and `=`, which are fine for cmd.exe, and was not mangled on the way.
    expect(feedback?.argv[feedback.argv.indexOf("--reason") + 1]).toContain("source=tool_success; confidence=")
  })

  it("session-end starts akm index detached, and extract-session keeps akm's output in extract.log", async () => {
    const sandbox = makeSandbox()

    expect(runHandler(handlerFor("session-end"), sandbox, payloadFor("session-end", sandbox)).exitCode).toBe(0)
    expect(runHandler(handlerFor("extract-session"), sandbox, payloadFor("extract-session", sandbox)).exitCode).toBe(0)

    // Both children outlive the hook, so the fake akm runs after it has returned.
    await settle(sandbox, { index: 1, extract: true })
    const extract = readFileSync(path.join(sandbox.stateDir, "extract.log"), "utf8")
    expect(readCallLog(sandbox.callLog).some((call) => call.argv.join(" ") === `proposal extract --type claude --session-id ${SESSION_ID}`)).toBe(true)
    // akm wrote that to its stderr, which the hook pointed at the log file.
    expect(extract).toContain("proposal_extract\t" + SESSION_ID)
  })

  it("keeps its state under the home directory, never the project, when no state directory is configured", () => {
    const sandbox = makeSandbox()
    // Windows sets USERPROFILE and no HOME; the hook used to fall back to "." there, which put
    // .local/state/akm-claude inside whatever project the session was in.
    const result = runHandler(handlerFor("curate-prompt"), sandbox, payloadFor("curate-prompt", sandbox), {
      XDG_STATE_HOME: undefined,
      HOME: IS_WINDOWS ? undefined : sandbox.home,
      USERPROFILE: IS_WINDOWS ? sandbox.home : undefined,
    })

    expect(result.exitCode).toBe(0)
    expect(existsSync(path.join(sandbox.home, ".local/state/akm-claude/feedback.log"))).toBe(true)
    expect(existsSync(path.join(sandbox.project, ".local"))).toBe(false)
  })
})

describe.skipIf(!IS_WINDOWS)("Claude hooks on Windows, with akm as npm installs it", () => {
  it("takes akm.cmd, never the extensionless sh script beside it", async () => {
    const sandbox = makeSandbox()
    // npm's shim set: an extensionless sh script, akm.cmd and akm.ps1. The script is not a program on Windows.
    expect(existsSync(path.join(sandbox.binDir, "akm"))).toBe(true)
    expect(existsSync(path.join(sandbox.binDir, "akm.cmd"))).toBe(true)
    writeFileSync(path.join(sandbox.binDir, "akm.ps1"), "throw 'the PowerShell shim is not a program either'\r\n")

    const result = runHandler(handlerFor("session-start"), sandbox, payloadFor("session-start", sandbox))

    expect(result.exitCode).toBe(0)
    // PATHEXT spells the extension in capitals; the file system does not care.
    expect(readLines(path.join(sandbox.stateDir, "session.log"))[0].toLowerCase()).toContain(`akm_ready\tpath\t${path.join(sandbox.binDir, "akm.cmd")}`.toLowerCase())
    await settle(sandbox, { index: 1 })
  })

  it("prefers akm.exe to akm.cmd, in PATHEXT order", () => {
    const sandbox = makeSandbox()
    // Not a program that runs: only which file the hook chose is under test, and it names its choice when
    // the version probe cannot run it. A bun-installed akm is an akm.exe.
    writeFileSync(path.join(sandbox.binDir, "akm.exe"), "")

    runHandler(handlerFor("session-start"), sandbox, payloadFor("session-start", sandbox))

    expect(readLines(path.join(sandbox.stateDir, "session.log"))[0].toLowerCase()).toContain(
      `akm_version_mismatch\tpath\t${path.join(sandbox.binDir, "akm.exe")}\t`.toLowerCase(),
    )
  })
})

describe("spawnPlan: how the hook starts akm", () => {
  const shim = "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\akm.cmd"

  it("leaves everything alone outside Windows, and anything that is not a batch file on Windows", () => {
    expect(spawnPlan("/usr/local/bin/akm", ["curate", 'a "b" & c'], "linux")).toEqual({ command: "/usr/local/bin/akm", args: ["curate", 'a "b" & c'] })
    expect(spawnPlan(shim, ["curate", 'a "b" & c'], "darwin")).toEqual({ command: shim, args: ["curate", 'a "b" & c'] })
    expect(spawnPlan("C:\\Users\\Jane\\.bun\\bin\\akm.exe", ["curate", 'a "b" & c'], "win32")).toEqual({
      command: "C:\\Users\\Jane\\.bun\\bin\\akm.exe",
      args: ["curate", 'a "b" & c'],
    })
  })

  it("runs a .cmd or .bat through cmd.exe as one verbatim line that /s unwraps", () => {
    for (const file of [shim, shim.replace(/cmd$/, "BAT")]) {
      const plan = spawnPlan(file, ["curate", "plan the release", "--limit", "5", ""], "win32")
      expect(plan.windowsVerbatimArguments).toBe(true)
      expect(plan.command.toLowerCase()).toMatch(/cmd(\.exe)?$/)
      // The program path and every argument is quoted, so a space in either (a profile directory, a prompt)
      // cannot split it, and the whole line is wrapped once more for /s.
      expect(plan.args).toEqual(["/d", "/s", "/c", `""${file}" "curate" "plan the release" "--limit" "5" """`])
    }
  })

  it("turns the characters cmd.exe would re-parse into spaces, and doubles a trailing backslash", () => {
    const [, , , line] = spawnPlan(shim, ['a "b" & c | d < e > f ^ g 100%', "line1\r\nline2", "C:\\dir\\"], "win32").args
    expect(line).toBe(`""${shim}" "a  b    c   d   e   f   g 100 " "line1  line2" "C:\\dir\\\\""`)
    // Every argument sits between quotes, and none of those characters is left inside them.
    for (const token of line.slice(1, -1).match(/"[^"]*"/g) ?? []) expect(token.slice(1, -1)).not.toMatch(/["%&|<>^\r\n]/)
  })
})

describe.skipIf(!IS_WINDOWS || !process.env.AKM_REAL_NPM_BIN)("Claude hooks against akm-cli as npm installed it", () => {
  it("session-start takes the real akm.cmd, not the sh script beside it, and accepts the version it prints", async () => {
    const realBin = process.env.AKM_REAL_NPM_BIN as string
    expect(existsSync(path.join(realBin, "akm"))).toBe(true)
    expect(existsSync(path.join(realBin, "akm.cmd"))).toBe(true)
    const sandbox = makeSandbox({ withAkm: false })
    // akm.cmd starts node, which starts bun: both have to be reachable, as they are on a machine that has akm installed.
    const node = Bun.which("node")
    expect(node).toBeTruthy()

    const result = runHandler(handlerFor("session-start"), sandbox, payloadFor("session-start", sandbox), {
      PATH: [realBin, sandboxPath(sandbox.binDir), path.dirname(node as string)].join(";"),
    })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toContain("# AKM is available in this session")
    expect(readLines(path.join(sandbox.stateDir, "session.log"))[0].toLowerCase()).toContain(`akm_ready\tpath\t${path.join(realBin, "akm.cmd")}\t0.9.20`.toLowerCase())
  })
})
