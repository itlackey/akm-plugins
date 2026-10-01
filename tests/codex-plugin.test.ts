import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { installFakeAkm, readCallLog } from "../evals/lib/fake-akm"

// The Codex plugin is the Claude plugin directory with a second manifest
// (claude/.codex-plugin/plugin.json) and a marketplace file at the repo root
// (.agents/plugins/marketplace.json). It registers two of the Claude hook's
// modes and nothing else, so these tests pin the manifests, then run the
// manifests' own hook commands the way Codex does: through `sh`, in the session
// cwd, with PLUGIN_ROOT / PLUGIN_DATA set and the event as JSON on stdin.

const repoRoot = path.resolve(import.meta.dir, "..")
const pluginDir = path.join(repoRoot, "claude")
const codexManifestPath = path.join(pluginDir, ".codex-plugin/plugin.json")
const claudeManifestPath = path.join(pluginDir, ".claude-plugin/plugin.json")
const codexMarketplacePath = path.join(repoRoot, ".agents/plugins/marketplace.json")
const claudeMarketplacePath = path.join(repoRoot, ".claude-plugin/marketplace.json")
const hookSourcePath = path.join(pluginDir, "hooks/akm-hook.ts")
const fixtureStash = path.join(repoRoot, "evals/fixtures/stash")

const tempDirs: string[] = []

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "akm-codex-plugin-"))
  tempDirs.push(dir)
  return dir
}

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(readFileSync(filePath, "utf8"))
}

function readLines(filePath: string) {
  return readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean)
}

/**
 * Poll until `probe` returns a value. The proposal worker is detached and
 * unref'd, so the hook returns before it has written anything.
 */
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const value = probe()
      if (value !== undefined) return value
    } catch {
      // Not ready yet (the file may not exist) — keep polling.
    }
    if (Date.now() >= deadline) throw new Error("waitFor timed out")
    await Bun.sleep(25)
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("Codex plugin metadata", () => {
  it("declares the manifest fields Codex reads, consistent with the Claude manifest", () => {
    const codex = readJson(codexManifestPath)
    const claude = readJson(claudeManifestPath)

    expect(codex.name).toBe("akm")
    expect(codex.name).toBe(claude.name)
    // The installed copy lives under plugins/cache/<marketplace>/<name>/<version>/,
    // so a version that drifts from the Claude one is a second release line.
    expect(codex.version).toBe(claude.version)
    expect(codex.description).toBe(claude.description)
    for (const field of ["license", "homepage", "repository"]) expect(codex[field]).toBe(claude[field])
    expect(codex.author).toEqual(claude.author)
    expect(codex.keywords).toEqual(claude.keywords)

    expect(codex.interface.displayName).toBe(claude.displayName)
    for (const field of ["shortDescription", "longDescription", "developerName", "category", "websiteURL"]) {
      expect(typeof codex.interface[field]).toBe("string")
      expect(codex.interface[field].length).toBeGreaterThan(0)
    }
    expect(codex.interface.capabilities.length).toBeGreaterThan(0)
    // Codex shows at most three starter prompts, each capped at 128 characters.
    expect(codex.interface.defaultPrompt.length).toBeLessThanOrEqual(3)
    for (const prompt of codex.interface.defaultPrompt) expect(prompt.length).toBeLessThanOrEqual(128)

    // Codex has no userConfig or slash commands; nothing Claude-only is declared.
    for (const field of ["userConfig", "commands", "mcpServers", "apps"]) expect(codex[field]).toBeUndefined()
  })

  it("is written the way the release workflow rewrites it", () => {
    // release.yml restamps the version with JSON.stringify(_, null, 2) + "\n" and
    // commits only when the result differs, so any other formatting shows up as
    // a spurious diff in the release commit.
    const raw = readFileSync(codexManifestPath, "utf8")
    expect(raw).toBe(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`)
  })

  it("points at the Claude plugin's skill, which exists", () => {
    const codex = readJson(codexManifestPath)
    // Codex takes a directory of skills; the Claude manifest lists the one skill.
    expect(codex.skills).toBe("./skills/")
    expect(readJson(claudeManifestPath).skills).toEqual(["./skills/akm"])
    const skill = path.join(pluginDir, codex.skills, "akm/SKILL.md")
    expect(existsSync(skill)).toBe(true)
    expect(readFileSync(skill, "utf8")).toMatch(/^---\nname: akm\n/)
  })

  it("lists akm in the repo marketplace from the Claude plugin directory", () => {
    const marketplace = readJson(codexMarketplacePath)
    const claudeMarketplace = readJson(claudeMarketplacePath)

    // Same marketplace name on both hosts, so `akm@akm-plugins` means one thing.
    expect(marketplace.name).toBe("akm-plugins")
    expect(marketplace.name).toBe(claudeMarketplace.name)
    expect(marketplace.plugins).toHaveLength(1)

    const [entry] = marketplace.plugins
    expect(entry.name).toBe("akm")
    expect(entry.name).toBe(readJson(codexManifestPath).name)
    expect(entry.source).toEqual({ source: "local", path: "./claude" })
    // source.path is relative to the marketplace root, which is the repo root.
    const pluginRoot = path.join(repoRoot, entry.source.path)
    expect(statSync(pluginRoot).isDirectory()).toBe(true)
    expect(pluginRoot).toBe(pluginDir)
    expect(existsSync(path.join(pluginRoot, ".codex-plugin/plugin.json"))).toBe(true)

    // The enumerations Codex 0.147.0 accepts (its plugin-creator spec lists the
    // same); akm needs no authentication, and "no auth" is not one of them.
    expect(entry.policy.installation).toBe("AVAILABLE")
    expect(["ON_INSTALL", "ON_USE"]).toContain(entry.policy.authentication)
    expect(entry.category).toBe(readJson(codexManifestPath).interface.category)
  })

  it("registers exactly the SessionStart and UserPromptSubmit hooks, inline", () => {
    const codex = readJson(codexManifestPath)
    // An inline `hooks` object replaces default discovery of hooks/hooks.json
    // in Codex, but Claude Code also reads that default path: a file there would
    // register the hooks twice on Claude.
    expect(existsSync(path.join(pluginDir, "hooks/hooks.json"))).toBe(false)
    expect(typeof codex.hooks).toBe("object")
    expect(Object.keys(codex.hooks)).toEqual(["hooks"])
    expect(Object.keys(codex.hooks.hooks).sort()).toEqual(["SessionStart", "UserPromptSubmit"])
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      const groups = codex.hooks.hooks[event]
      expect(groups).toHaveLength(1)
      expect(groups[0].matcher).toBeUndefined()
      expect(groups[0].hooks).toHaveLength(1)
      expect(groups[0].hooks[0].type).toBe("command")
    }
    // None of the Claude-only lifecycle hooks, auto-feedback or extraction.
    expect(JSON.stringify(codex.hooks)).not.toMatch(/PostToolUse|SessionEnd|SubagentStart|PostCompact|auto-feedback|extract-session/)
  })

  it("runs the Claude hook's existing session-start and curate-prompt modes", () => {
    const codex = readJson(codexManifestPath)
    const claude = readJson(claudeManifestPath)
    const hookSource = readFileSync(hookSourcePath, "utf8")
    expect(existsSync(path.join(pluginDir, "hooks/akm-hook.sh"))).toBe(true)

    const modes: Record<string, string> = { SessionStart: "session-start", UserPromptSubmit: "curate-prompt" }
    for (const [event, mode] of Object.entries(modes)) {
      const handler = codex.hooks.hooks[event][0].hooks[0]
      // Pinned whole: the harness label and state dir are part of the contract.
      expect(handler.command).toBe(
        `AKM_PLUGIN_HARNESS=codex AKM_PLUGIN_STATE_DIR="\${PLUGIN_DATA}" sh "\${PLUGIN_ROOT}/hooks/akm-hook.sh" ${mode}`,
      )
      expect(hookSource).toContain(`case "${mode}":`)
      const claudeHandler = claude.hooks[event][0].hooks[0]
      expect(claudeHandler.command).toBe(`sh "\${CLAUDE_PLUGIN_ROOT}/hooks/akm-hook.sh" ${mode}`)
      // The hook budgets its own work against these (UserPromptSubmit's
      // retrospective and curate legs, SessionStart's version probe).
      expect(handler.timeout).toBe(claudeHandler.timeout)
    }
  })

  it("does not leave the skill naming Claude-only slash commands as if Codex had them", () => {
    const skill = readFileSync(path.join(pluginDir, "skills/akm/SKILL.md"), "utf8")
    expect(skill).toMatch(/`\/akm-\*` slash\s+commands exist only in Claude Code/)
    expect(skill).toMatch(/such as Codex, run the\s+`akm` CLI forms/)
  })
})

describe("Codex hook runtime", () => {
  const SESSION_ID = "019c3f2e-7a41-7d10-b8a5-0f3c2d9e6b14"

  function codexCommand(event: "SessionStart" | "UserPromptSubmit") {
    return readJson(codexManifestPath).hooks.hooks[event][0].hooks[0].command as string
  }

  /** The stdin Codex sends a hook: the common fields plus the event's own. */
  function codexEvent(event: "SessionStart" | "UserPromptSubmit", cwd: string, extra: Record<string, unknown> = {}) {
    return {
      session_id: SESSION_ID,
      transcript_path: null,
      cwd,
      hook_event_name: event,
      model: "gpt-5.5",
      permission_mode: "default",
      ...(event === "SessionStart" ? { source: "startup" } : { turn_id: "019c3f2e-7a55-7a02-9c1e-6d84a51b03f7", prompt: "" }),
      ...extra,
    }
  }

  type Sandbox = {
    root: string
    home: string
    xdgState: string
    dataDir: string
    project: string
    binDir: string
    callLog: string
  }

  /**
   * One temp tree per test: a HOME and XDG_STATE_HOME to prove nothing lands
   * in akm-claude, a PLUGIN_DATA directory, a project to run in, and a bin dir
   * holding `bun` (the wrapper needs it) and, unless `withAkm` is false, the
   * repo's fake akm over the eval fixture stash.
   */
  function makeSandbox(options: { withAkm?: boolean } = {}): Sandbox {
    const root = makeTempDir()
    const sandbox: Sandbox = {
      root,
      home: path.join(root, "home"),
      xdgState: path.join(root, "xdg-state"),
      dataDir: path.join(root, "plugin-data"),
      project: path.join(root, "project"),
      binDir: path.join(root, "bin"),
      callLog: path.join(root, "akm-calls.log"),
    }
    for (const dir of [sandbox.home, sandbox.xdgState, sandbox.project, sandbox.binDir]) mkdirSync(dir, { recursive: true })
    symlinkSync(process.execPath, path.join(sandbox.binDir, "bun"))
    if (options.withAkm !== false) {
      installFakeAkm({ binDir: sandbox.binDir, callLog: sandbox.callLog, assets: { stashDir: fixtureStash } })
    }
    return sandbox
  }

  /**
   * Run a manifest hook command as Codex does: through `sh -c` in the session
   * cwd, event JSON on stdin, PLUGIN_ROOT / PLUGIN_DATA (and the Claude-named
   * aliases Codex also sets) in the environment. Codex also substitutes the
   * ${PLUGIN_ROOT} / ${PLUGIN_DATA} placeholders in the command text itself, so
   * both are done here and the shell sees the same command either way.
   */
  function runCommand(command: string, sandbox: Sandbox, payload: unknown, env: Record<string, string> = {}) {
    const inputPath = path.join(makeTempDir(), "stdin.json")
    writeFileSync(inputPath, JSON.stringify(payload))
    const baseEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("AKM_") && !key.startsWith("XDG_") && !key.startsWith("CLAUDE_PLUGIN_") && !key.startsWith("PLUGIN_"),
      ),
    )
    const substituted = command.replaceAll("${PLUGIN_ROOT}", pluginDir).replaceAll("${PLUGIN_DATA}", sandbox.dataDir)
    const result = Bun.spawnSync(["sh", "-c", substituted], {
      cwd: sandbox.project,
      env: {
        ...baseEnv,
        HOME: sandbox.home,
        XDG_STATE_HOME: sandbox.xdgState,
        PATH: `${sandbox.binDir}:/usr/bin:/bin`,
        PLUGIN_ROOT: pluginDir,
        PLUGIN_DATA: sandbox.dataDir,
        CLAUDE_PLUGIN_ROOT: pluginDir,
        CLAUDE_PLUGIN_DATA: sandbox.dataDir,
        // A test that opts into proposal submission sets this itself.
        AKM_AUTO_LEARNING: "0",
        ...env,
      },
      stdio: [Bun.file(inputPath), "pipe", "pipe"],
    })
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
  }

  function runCodexHook(
    event: "SessionStart" | "UserPromptSubmit",
    sandbox: Sandbox,
    extra: Record<string, unknown> = {},
    env: Record<string, string> = {},
  ) {
    const result = runCommand(codexCommand(event), sandbox, codexEvent(event, sandbox.project, extra), env)
    expect(result.exitCode).toBe(0)
    return result.stdout
  }

  /** What Codex accepts on stdout for these two events (its generated output schema). */
  function expectCodexOutput(stdout: string, eventName: string) {
    const payload = JSON.parse(stdout)
    const allowed = ["continue", "decision", "hookSpecificOutput", "reason", "stopReason", "suppressOutput", "systemMessage"]
    expect(Object.keys(payload).filter((key) => !allowed.includes(key))).toEqual([])
    expect(Object.keys(payload.hookSpecificOutput).sort()).toEqual(["additionalContext", "hookEventName"])
    expect(payload.hookSpecificOutput.hookEventName).toBe(eventName)
    expect(typeof payload.hookSpecificOutput.additionalContext).toBe("string")
    return payload
  }

  function readEvents(dir: string) {
    return readLines(path.join(dir, "events.jsonl")).map((line) => JSON.parse(line))
  }

  function expectNoClaudeState(sandbox: Sandbox) {
    expect(existsSync(path.join(sandbox.xdgState, "akm-claude"))).toBe(false)
    expect(existsSync(path.join(sandbox.home, ".local/state/akm-claude"))).toBe(false)
  }

  it("UserPromptSubmit curates the Codex prompt field and keeps its state in PLUGIN_DATA", () => {
    const sandbox = makeSandbox()
    const prompt = "help me plan the akm release rollout this afternoon"

    const stdout = runCodexHook("UserPromptSubmit", sandbox, { prompt })

    const payload = expectCodexOutput(stdout, "UserPromptSubmit")
    expect(payload.hookSpecificOutput.additionalContext).toContain("AKM PROVENANCE")
    expect(payload.hookSpecificOutput.additionalContext).toContain("commands/bump-version")
    // The prompt Codex sent is the query akm curate received.
    const curate = readCallLog(sandbox.callLog).find((call) => call.argv[0] === "curate")
    expect(curate?.argv[1]).toBe(prompt)

    // Everything the hook wrote is under PLUGIN_DATA, keyed by Codex's session id
    // and labelled Codex. events.jsonl in particular used to follow
    // XDG_STATE_HOME/akm-claude whatever AKM_PLUGIN_STATE_DIR said.
    const events = readEvents(sandbox.dataDir)
    expect(events.map((event) => event.event)).toEqual(["prompt_recall"])
    expect(events.every((event) => event.harness === "codex")).toBe(true)
    expect(events[0].sessionId).toBe(SESSION_ID)
    expect(readLines(path.join(sandbox.dataDir, "feedback.log"))[0]).toContain(`user\tprompt\t${prompt}`)
    expect(existsSync(path.join(sandbox.dataDir, "curated", `prompt-${SESSION_ID}.md`))).toBe(true)
    expectNoClaudeState(sandbox)
  })

  it("UserPromptSubmit still answers with nothing for a prompt that is not worth curating", () => {
    const sandbox = makeSandbox()

    expect(runCodexHook("UserPromptSubmit", sandbox, { prompt: "thanks" })).toBe("")

    expect(readCallLog(sandbox.callLog).filter((call) => call.argv[0] === "curate")).toEqual([])
    expect(readEvents(sandbox.dataDir).map((event) => event.harness)).toEqual(["codex"])
    expectNoClaudeState(sandbox)
  })

  it("credits nothing when the user praises the session: no hook records concept use under Codex", () => {
    const sandbox = makeSandbox()

    // "that worked" is the retrospective-feedback trigger. On Claude it credits
    // refs the PostToolUse hook logged for the session; Codex registers no such
    // hook, so there is nothing to credit and akm must never be asked to.
    runCodexHook("UserPromptSubmit", sandbox, { prompt: "thanks, that worked great for the release" })

    expect(readCallLog(sandbox.callLog).filter((call) => call.argv[0] === "feedback")).toEqual([])
    expect(existsSync(path.join(sandbox.dataDir, "memory.log"))).toBe(false)
  })

  it("does not take a prompt a subagent received for the user's own words", () => {
    // Codex stamps `agent_id` (and `agent_type`) on the input of a hook that
    // fires inside a subagent; both are optional properties of its
    // user-prompt-submit.command.input schema (0.147.0). The prompt such an event
    // carries is the main agent's task for the subagent, not something the user
    // typed, so it is no memory intent, no learning signal and no praise for the
    // concepts the session touched.
    const prompt = "remember that the memory cleanup worked with minimal changes"
    const submit = (extra: Record<string, unknown>) => {
      const sandbox = makeSandbox()
      // The row a PostToolUse hook would leave for a concept the session used,
      // which a retrospective "that worked" would credit.
      mkdirSync(sandbox.dataDir, { recursive: true })
      writeFileSync(
        path.join(sandbox.dataDir, "memory.log"),
        `2026-01-01T00:00:00Z\tsystem\tBash\tskills/code-review\takm show skills/code-review\t${SESSION_ID}\n`,
      )
      runCodexHook(
        "UserPromptSubmit",
        sandbox,
        { prompt, ...extra },
        // Capture the signal, but never spawn a detached proposal worker.
        { AKM_AUTO_LEARNING: "1", AKM_AUTO_CURATE: "0", AKM_LEARNING_PROPOSAL_MIN_CONFIDENCE: "1" },
      )
      return {
        memoryLog: readFileSync(path.join(sandbox.dataDir, "memory.log"), "utf8"),
        feedbackLog: existsSync(path.join(sandbox.dataDir, "feedback.log")) ? readFileSync(path.join(sandbox.dataDir, "feedback.log"), "utf8") : "",
        buffer: path.join(sandbox.dataDir, "sessions", `${SESSION_ID}.md`),
        signals: path.join(sandbox.dataDir, "learning-signals.jsonl"),
        feedbackCalls: readCallLog(sandbox.callLog).filter((call) => call.argv[0] === "feedback"),
      }
    }

    const typed = submit({})
    expect(typed.memoryLog).toContain(`\tuser\tintent\t${prompt}`)
    expect(readFileSync(typed.buffer, "utf8")).toContain("user memory intent")
    expect(readFileSync(typed.signals, "utf8")).toContain('"kind":"explicit-memory"')
    expect(typed.feedbackCalls.map((call) => call.argv[1])).toEqual(["skills/code-review"])
    expect(typed.feedbackLog).toContain(`user\tprompt\t${prompt}`)

    const subagent = submit({ agent_id: "019c3f2e-7b00-7c11-8d3a-5e6f4a1b2c3d", agent_type: "worker" })
    expect(subagent.memoryLog).not.toContain("\tuser\tintent\t")
    expect(existsSync(subagent.buffer)).toBe(false)
    expect(existsSync(subagent.signals)).toBe(false)
    expect(subagent.feedbackCalls).toEqual([])
  })

  it("SessionStart prints the primer for Codex's stdin and keeps its state in PLUGIN_DATA", () => {
    const sandbox = makeSandbox()
    writeFileSync(path.join(sandbox.project, "package.json"), JSON.stringify({ name: "release-tooling", description: "Release tooling" }))

    const stdout = runCodexHook("SessionStart", sandbox)

    const payload = expectCodexOutput(stdout, "SessionStart")
    expect(payload.hookSpecificOutput.additionalContext).toContain("# AKM is available in this session")
    expect(payload.hookSpecificOutput.additionalContext).toContain("The public plugin surface is limited to search, show, curate, feedback, and remember.")
    // The version check ran against the akm on PATH, in the session cwd.
    expect(readCallLog(sandbox.callLog).some((call) => call.argv[0] === "--version")).toBe(true)
    expect(readCallLog(sandbox.callLog).find((call) => call.argv[0] === "curate")?.argv[1]).toContain("release-tooling")

    expect(readLines(path.join(sandbox.dataDir, "session.log"))[0]).toContain("akm_ready\tpath")
    const events = readEvents(sandbox.dataDir)
    expect(events.map((event) => event.event)).toEqual(["session_started"])
    expect(events[0].harness).toBe("codex")
    expect(events[0].sessionId).toBe(SESSION_ID)
    expectNoClaudeState(sandbox)
  })

  it("SessionStart tells the model and the user when akm is missing, in Codex's output shape", () => {
    const sandbox = makeSandbox({ withAkm: false })

    const payload = expectCodexOutput(runCodexHook("SessionStart", sandbox), "SessionStart")

    expect(payload.hookSpecificOutput.additionalContext).toContain("# AKM is NOT available in this session")
    expect(payload.systemMessage).toContain("bun install -g akm-cli@^0.9.20")
    expect(readLines(path.join(sandbox.dataDir, "session.log"))[0]).toContain("akm_missing")
    expectNoClaudeState(sandbox)
  })

  it("labels learning signals and their proposal outcomes as Codex", async () => {
    const sandbox = makeSandbox({ withAkm: false })
    // The same fake the Claude proposal test uses: log calls, accept `proposal new`.
    writeFileSync(
      path.join(sandbox.binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> '${sandbox.callLog}'
if [ "$1" = "--version" ]; then echo "akm 0.9.20"; exit 0; fi
printf '{"ok":true,"ref":"instructions/use-pnpm","proposal":{"id":"proposal-1","ref":"instructions/use-pnpm"}}\\n'
exit 0
`,
    )
    chmodSync(path.join(sandbox.binDir, "akm"), 0o755)

    runCodexHook(
      "UserPromptSubmit",
      sandbox,
      { prompt: "no, use pnpm not npm for this repository" },
      { AKM_AUTO_LEARNING: "1", AKM_AUTO_CURATE: "0", AKM_AUTO_SKILL_PROPOSALS: "0" },
    )

    // The worker is detached: it writes learning_proposal once akm answers.
    const events = await waitFor(() => {
      const all = readEvents(sandbox.dataDir)
      return all.some((event) => event.event === "learning_proposal") ? all : undefined
    })
    expect(events.map((event) => event.event).sort()).toEqual(["learning_proposal", "learning_signal"])
    expect(events.every((event) => event.harness === "codex")).toBe(true)
    expect(JSON.parse(readLines(path.join(sandbox.dataDir, "learning-signals.jsonl"))[0]).harness).toBe("codex")
    expect(readFileSync(sandbox.callLog, "utf8")).toMatch(/proposal new instruction use-pnpm-not-npm-repository-[a-f0-9]{8} --file /)
    expectNoClaudeState(sandbox)
  })

  it("leaves the Claude plugin's labels and state directory alone", () => {
    const sandbox = makeSandbox()
    const claude = readJson(claudeManifestPath)
    const command = claude.hooks.UserPromptSubmit[0].hooks[0].command as string
    const inputPayload = codexEvent("UserPromptSubmit", sandbox.project, { prompt: "help me plan the akm release rollout this afternoon" })

    // Claude's own manifest command, with only its own placeholder substituted:
    // no AKM_PLUGIN_HARNESS and no AKM_PLUGIN_STATE_DIR, as a Claude Code install runs it.
    const result = runCommand(command.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginDir), sandbox, inputPayload)

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
    const events = readEvents(path.join(sandbox.xdgState, "akm-claude"))
    expect(events.map((event) => event.harness)).toEqual(["claude-code"])
    expect(existsSync(sandbox.dataDir)).toBe(false)
  })
})
