import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { installFakeAkm, readCallLog } from "../evals/lib/fake-akm"
import {
  IS_WINDOWS,
  codexEffectiveCommand,
  codexShells,
  hostEnv,
  installScriptedAkm,
  makeBinDir,
  runClaudeHandler,
  sandboxPath,
  substituteCodexPlaceholders,
  whichOn,
} from "./host-runtime"

// The Codex plugin is the Claude plugin directory with a second manifest
// (claude/.codex-plugin/plugin.json) and a marketplace file at the repo root
// (.agents/plugins/marketplace.json). It registers two of the Claude hook's
// modes and nothing else, so these tests pin the manifests, then run the
// manifests' own hook commands the way Codex does: through the session's shell
// (`sh -c`; on Windows PowerShell, with cmd.exe as the fallback), in the session
// cwd, with PLUGIN_ROOT / PLUGIN_DATA set and the event as JSON on stdin. Codex
// takes `commandWindows` over `command` on Windows, so that is the command run
// there. POSIX CI also runs `commandWindows` through sh: it is plain `bun ...`.

const repoRoot = path.resolve(import.meta.dir, "..")
const pluginDir = path.join(repoRoot, "claude")
const codexManifestPath = path.join(pluginDir, ".codex-plugin/plugin.json")
const claudeManifestPath = path.join(pluginDir, ".claude-plugin/plugin.json")
const codexMarketplacePath = path.join(repoRoot, ".agents/plugins/marketplace.json")
const claudeMarketplacePath = path.join(repoRoot, ".claude-plugin/marketplace.json")
const hookSourcePath = path.join(pluginDir, "hooks/akm-hook.ts")
const fixtureStash = path.join(repoRoot, "evals/fixtures/stash")
const commandsDir = path.join(pluginDir, "commands")

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
async function waitFor<T>(probe: () => T | undefined, timeoutMs = IS_WINDOWS ? 30_000 : 5000): Promise<T> {
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

/**
 * Why Codex's install-time conversion of a plugin command into a skill would skip `text`, or undefined when it converts.
 * A mirror of command_migration.rs and command_migration/plugin.rs in codex-rs/core-plugins (rust-v0.160.0; the same in
 * 0.159.3): a command that fails any check is dropped without a word. `file` is the command's file name, and the text has
 * LF line endings, which .gitattributes guarantees.
 */
function codexSkipReason(file: string, text: string): string | undefined {
  const source = file.replace(/\.md$/, "")
  const parsed = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(text)
  let description: unknown
  try {
    description = parsed ? Bun.YAML.parse(parsed[1])?.description : undefined
  } catch {}
  const body = (parsed ? parsed[2] : text).trim()
  const name = `source-command-${source}`.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase()
  const quoted = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
  const rendered = `---\nname: ${quoted(name)}\ndescription: ${quoted(String(description))}\n---\n\n# ${name}\n\nUse this skill when the user asks to run the migrated source command \`${source}\`.\n\n## Command Template\n\n${body}\n`

  if (source === "README") return "a README is not a command"
  if (typeof description !== "string" || !description.trim()) return "no description in the frontmatter"
  if (name.length > 64) return "skill name over 64 characters"
  if (/\$ARGUMENTS|\$\d/.test(body)) return "argument placeholder"
  if (body.includes("{{") && body.includes("}}")) return "{{ }} template"
  if (body.includes("!`") || body.includes("! `")) return "shell expansion"
  if (body.split(/\s+/).some((token) => token.length > 1 && token.startsWith("@"))) return "@file reference"
  // Only plugin commands are held to a size: the rendered skill, frontmatter and heading included.
  if (new TextEncoder().encode(rendered).length > 4000) return "rendered skill over 4,000 bytes"
  return undefined
}

afterEach(() => {
  // A detached child may still hold a file for a moment, and Windows will not
  // delete an open one: retry, and a leftover temp directory is not a test failure.
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch {}
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
      // Pinned whole: the harness label, the state dir and the guard are part of the contract. This is the command
      // Codex runs on macOS and Linux, and Codex hashes it (not `commandWindows`): any edit to it asks every Codex
      // user to trust the hook again, and real-hosts.test.ts pins the hashes this text produces.
      expect(handler.command).toBe(
        `[ -f "\${PLUGIN_ROOT}/hooks/akm-hook.sh" ] || exit 0; AKM_PLUGIN_HARNESS=codex AKM_PLUGIN_STATE_DIR="\${PLUGIN_DATA}" sh "\${PLUGIN_ROOT}/hooks/akm-hook.sh" ${mode}`,
      )
      expect(hookSource).toContain(`case "${mode}":`)
      const claudeHandler = claude.hooks[event][0].hooks[0]
      // Claude's own handler is exec form, so it needs neither sh nor a Windows variant.
      expect(claudeHandler.command).toBe("bun")
      expect(claudeHandler.args).toEqual(["\${CLAUDE_PLUGIN_ROOT}/hooks/akm-hook.ts", mode])
      // The hook budgets its own work against these (UserPromptSubmit's
      // retrospective and curate legs, SessionStart's version probe).
      expect(handler.timeout).toBe(claudeHandler.timeout)
    }
  })

  it("guards the POSIX command against the plugin directory being deleted under a running session", () => {
    const codex = readJson(codexManifestPath)
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      const handler = codex.hooks.hooks[event][0].hooks[0]
      // Codex 0.147's start-up marketplace upgrade runs while the first session after a release is being created:
      // that session starts with the previous version's absolute hook path, and the upgrade then deletes that
      // version's directory. `sh <missing script>` exits 2, which Codex counts as a block (SessionStart Failed, the
      // user's first prompt Blocked and never sent). The guard has to be the first thing the command does.
      expect(handler.command.startsWith(`[ -f "\${PLUGIN_ROOT}/hooks/akm-hook.sh" ] || exit 0; `)).toBe(true)
      // Windows is left alone on purpose: `bun <missing script>` exits 1, which Codex reports as Failed, not Blocked.
      expect(handler.commandWindows).not.toContain("exit 0")
    }
  })

  it("gives Windows a command that is plain `bun`, with the harness as an argument", () => {
    const codex = readJson(codexManifestPath)
    const modes: Record<string, string> = { SessionStart: "session-start", UserPromptSubmit: "curate-prompt" }
    for (const [event, mode] of Object.entries(modes)) {
      const handler = codex.hooks.hooks[event][0].hooks[0]
      // Codex runs a Windows hook through PowerShell (pwsh, else powershell.exe) and, when it knows no shell, cmd.exe:
      // `NAME=value command` and `sh` are not either's syntax, and Git Bash is not something a Windows machine has.
      // One quoted path and bare words is valid in PowerShell, cmd.exe and sh alike.
      expect(handler.commandWindows).toBe(`bun "\${PLUGIN_ROOT}/hooks/akm-hook.ts" ${mode} --harness=codex`)
      // The state directory comes from PLUGIN_DATA, which Codex exports to the hook, not from a variable set in the command.
      expect(handler.commandWindows).not.toMatch(/AKM_|\bsh\b|&&|\|\||;/)
      expect(handler.timeout).toBeGreaterThan(0)
    }
  })

  it("does not leave the skill naming Claude-only slash commands as if Codex had them", () => {
    const skill = readFileSync(path.join(pluginDir, "skills/akm/SKILL.md"), "utf8")
    expect(skill).toMatch(/`\/akm-\*` slash\s+commands exist only in Claude Code/)
    expect(skill).toMatch(/such as Codex, run the\s+`akm` CLI forms/)
  })

  it("keeps every command free of argument placeholders, which Codex cannot expand and Claude Code does not need", () => {
    // Codex turns a plugin's commands/*.md into skills when it installs the plugin, and drops any command whose body has
    // $ARGUMENTS or a $1-style placeholder. Claude Code does not need one: when no placeholder in a command receives the
    // user's input it appends "ARGUMENTS: <what the user typed>" to the end of the command (code.claude.com/docs/en/skills,
    // "Pass arguments to skills"). So each command points at that line instead, and in Codex at the user's request.
    const files = readdirSync(commandsDir).filter((file) => file.endsWith(".md")).sort()
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(path.join(commandsDir, file), "utf8")
      expect({ file, placeholder: /\$ARGUMENTS|\$\d/.test(text) }).toEqual({ file, placeholder: false })
      expect({ file, pointsAtAppendedLine: text.includes("`ARGUMENTS:`") }).toEqual({ file, pointsAtAppendedLine: true })
    }
  })

  it("keeps every command one that Codex converts into a skill when it installs the plugin", () => {
    // tests/real-hosts.test.ts checks the same against the real Codex; this runs everywhere and says why a command is dropped.
    for (const file of readdirSync(commandsDir).filter((name) => name.endsWith(".md")).sort()) {
      const skipped = codexSkipReason(file, readFileSync(path.join(commandsDir, file), "utf8"))
      expect({ file, skipped }).toEqual({ file, skipped: undefined })
    }

    // The mirror is not a no-op: it skips each thing Codex skips.
    const command = (body: string, frontmatter = "description: A command") => `---\n${frontmatter}\n---\n\n${body}\n`
    expect(codexSkipReason("akm-x.md", command("Run `akm search x`."))).toBeUndefined()
    for (const [file, text] of [
      ["README.md", command("Run it.")],
      ["akm-x.md", "Run it.\n"],
      ["akm-x.md", command("Run it.", "argument-hint: x")],
      ["akm-x.md", command('Run `akm search "$ARGUMENTS"`.')],
      ["akm-x.md", command("Run `akm show $1`.")],
      ["akm-x.md", command("Run {{query}}.")],
      ["akm-x.md", command("Run !`akm info`.")],
      ["akm-x.md", command("Read @notes.md first.")],
      [`${"a".repeat(60)}.md`, command("Run it.")],
      ["akm-x.md", command("x".repeat(4000))],
    ]) {
      expect({ file, skipped: codexSkipReason(file, text) !== undefined }).toEqual({ file, skipped: true })
    }
  })
})

describe("Codex hook runtime", () => {
  const SESSION_ID = "019c3f2e-7a41-7d10-b8a5-0f3c2d9e6b14"

  /** The command Codex runs for `event` on this platform: `commandWindows` on Windows, `command` elsewhere. */
  function codexCommand(event: "SessionStart" | "UserPromptSubmit") {
    return codexEffectiveCommand(readJson(codexManifestPath).hooks.hooks[event][0].hooks[0])
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
  function makeSandbox(options: { withAkm?: boolean; withBun?: boolean } = {}): Sandbox {
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
    for (const dir of [sandbox.home, sandbox.xdgState, sandbox.project]) mkdirSync(dir, { recursive: true })
    sandbox.binDir = makeBinDir(root, "bin", options.withBun !== false)
    if (options.withAkm !== false) {
      installFakeAkm({ binDir: sandbox.binDir, callLog: sandbox.callLog, assets: { stashDir: fixtureStash } })
    }
    return sandbox
  }

  /**
   * Run a manifest hook command as Codex does: through the session's shell in the
   * session cwd, event JSON on stdin, PLUGIN_ROOT / PLUGIN_DATA (and the
   * Claude-named aliases Codex also sets) in the environment. Codex also
   * substitutes the ${PLUGIN_ROOT} / ${PLUGIN_DATA} placeholders in the command
   * text itself, so both are done here and the shell sees the same command
   * either way. `shell` is the one Codex prefers on this OS unless a test
   * names another.
   */
  function runCommand(
    command: string,
    sandbox: Sandbox,
    payload: unknown,
    env: Record<string, string | undefined> = {},
    shell = codexShells()[0],
  ) {
    const inputPath = path.join(makeTempDir(), "stdin.json")
    writeFileSync(inputPath, JSON.stringify(payload))
    const substituted = substituteCodexPlaceholders(command, { pluginRoot: pluginDir, pluginData: sandbox.dataDir })
    return shell.run(substituted, { cwd: sandbox.project, env: codexEnv(sandbox, env), stdin: Bun.file(inputPath) })
  }

  /** The environment Codex gives a plugin hook: the exported plugin variables, over a sandboxed home and PATH. */
  function codexEnv(sandbox: Sandbox, env: Record<string, string | undefined> = {}) {
    return hostEnv(
      {
        HOME: sandbox.home,
        XDG_STATE_HOME: sandbox.xdgState,
        PATH: sandboxPath(sandbox.binDir),
        PLUGIN_ROOT: pluginDir,
        PLUGIN_DATA: sandbox.dataDir,
        CLAUDE_PLUGIN_ROOT: pluginDir,
        CLAUDE_PLUGIN_DATA: sandbox.dataDir,
        // A test that opts into proposal submission sets this itself.
        AKM_AUTO_LEARNING: "0",
        ...env,
      },
      (name) => /^(AKM_|XDG_|CLAUDE_PLUGIN_|PLUGIN_)/.test(name),
    )
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

  it("submits no feedback under Codex: not for a tool result, not when the user says it worked", () => {
    // Codex's PostToolUse gives a Bash command's output but no exit status, and it has no failure event, so a failed akm
    // command cannot be told from a successful one. The manifest registers no tool hook, and the hook submits no feedback
    // even when it is handed what makes it submit under Claude Code. Both submitters are driven with that here: the
    // PostToolUse event auto-feedback takes (the Windows command's shape, plain bun, with its mode swapped), and the row a
    // post-tool hook leaves in memory.log for a retrospective "that worked" to credit.
    const sandbox = makeSandbox()
    mkdirSync(sandbox.dataDir, { recursive: true })
    writeFileSync(
      path.join(sandbox.dataDir, "memory.log"),
      `2026-01-01T00:00:00Z\tsystem\tBash\tworkflows/release\takm workflow run workflows/release\t${SESSION_ID}\n`,
    )
    const env = { AKM_BUNDLE_DIR: fixtureStash }
    const toolEvent = {
      session_id: SESSION_ID,
      cwd: sandbox.project,
      tool_name: "Bash",
      tool_input: { command: "akm workflow run workflows/release" },
      tool_response: "",
    }
    const autoFeedback = readJson(codexManifestPath).hooks.hooks.UserPromptSubmit[0].hooks[0].commandWindows.replace("curate-prompt", "auto-feedback success")

    expect(runCommand(autoFeedback, sandbox, toolEvent, env).exitCode).toBe(0)
    runCodexHook("UserPromptSubmit", sandbox, { prompt: "thanks, that worked great for the release" }, env)

    expect(readCallLog(sandbox.callLog).filter((call) => call.argv[0] === "feedback")).toEqual([])
    expect(readEvents(sandbox.dataDir).filter((event) => event.event === "feedback_recorded")).toEqual([])
  })

  it("does not take a prompt a subagent received for the user's own words", () => {
    // Codex stamps `agent_id` (and `agent_type`) on the input of a hook that
    // fires inside a subagent; both are optional properties of its
    // user-prompt-submit.command.input schema (0.147.0). The prompt such an event
    // carries is the main agent's task for the subagent, not something the user
    // typed, so it is no memory intent and no learning signal. (Nor praise for the
    // concepts the session touched, which Claude Code's hook is tested for in
    // claude-plugin.test.ts: Codex's submits no feedback at all.)
    const prompt = "remember that the memory cleanup worked with minimal changes"
    const submit = (extra: Record<string, unknown>) => {
      const sandbox = makeSandbox()
      runCodexHook(
        "UserPromptSubmit",
        sandbox,
        { prompt, ...extra },
        // Capture the signal, but never spawn a detached proposal worker.
        { AKM_AUTO_LEARNING: "1", AKM_AUTO_CURATE: "0", AKM_LEARNING_PROPOSAL_MIN_CONFIDENCE: "1" },
      )
      return {
        memoryLog: existsSync(path.join(sandbox.dataDir, "memory.log")) ? readFileSync(path.join(sandbox.dataDir, "memory.log"), "utf8") : "",
        feedbackLog: existsSync(path.join(sandbox.dataDir, "feedback.log")) ? readFileSync(path.join(sandbox.dataDir, "feedback.log"), "utf8") : "",
        buffer: path.join(sandbox.dataDir, "sessions", `${SESSION_ID}.md`),
        signals: path.join(sandbox.dataDir, "learning-signals.jsonl"),
      }
    }

    const typed = submit({})
    expect(typed.memoryLog).toContain(`\tuser\tintent\t${prompt}`)
    expect(readFileSync(typed.buffer, "utf8")).toContain("user memory intent")
    expect(readFileSync(typed.signals, "utf8")).toContain('"kind":"explicit-memory"')
    expect(typed.feedbackLog).toContain(`user\tprompt\t${prompt}`)

    const subagent = submit({ agent_id: "019c3f2e-7b00-7c11-8d3a-5e6f4a1b2c3d", agent_type: "worker" })
    expect(subagent.feedbackLog).not.toContain("user\tprompt")
    expect(subagent.memoryLog).not.toContain("\tuser\tintent\t")
    expect(existsSync(subagent.buffer)).toBe(false)
    expect(existsSync(subagent.signals)).toBe(false)
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
    expect(payload.systemMessage).toContain("bun install -g akm-cli@^0.9.25")
    expect(readLines(path.join(sandbox.dataDir, "session.log"))[0]).toContain("akm_missing")
    expectNoClaudeState(sandbox)
  })

  it("labels learning signals and their proposal outcomes as Codex", async () => {
    const sandbox = makeSandbox({ withAkm: false })
    // The same kind of fake the Claude proposal test uses: log calls, accept `proposal new`.
    installScriptedAkm(
      sandbox.binDir,
      `import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(sandbox.callLog)}, args.join(" ") + "\\n")
if (args[0] === "--version") {
  console.log("akm 0.9.25")
  process.exit(0)
}
console.log(JSON.stringify({ ok: true, ref: "instructions/use-pnpm", proposal: { id: "proposal-1", ref: "instructions/use-pnpm" } }))
`,
    )

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
    const handler = readJson(claudeManifestPath).hooks.UserPromptSubmit[0].hooks[0]
    const inputPath = path.join(makeTempDir(), "stdin.json")
    writeFileSync(inputPath, JSON.stringify(codexEvent("UserPromptSubmit", sandbox.project, { prompt: "help me plan the akm release rollout this afternoon" })))

    // Claude's own manifest handler, run as Claude Code runs it, in an environment that also carries the Codex
    // plugin variables: no --harness and no AKM_PLUGIN_*, so PLUGIN_DATA must not become its state directory.
    const result = runClaudeHandler(handler, { pluginRoot: pluginDir, cwd: sandbox.project, env: codexEnv(sandbox), stdin: Bun.file(inputPath) })

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
    const events = readEvents(path.join(sandbox.xdgState, "akm-claude"))
    expect(events.map((event) => event.harness)).toEqual(["claude-code"])
    expect(existsSync(sandbox.dataDir)).toBe(false)
  })

  it("runs both hooks under every shell Codex may use on this OS", () => {
    // Windows: pwsh and powershell.exe as `-NoProfile -Command`, and cmd.exe as `/C "<line>"` when Codex knows no shell.
    // Elsewhere: sh. Each gets its own sandbox, so each proves its own state, labels and output.
    for (const shell of codexShells()) {
      const sandbox = makeSandbox()
      const command = (event: "SessionStart" | "UserPromptSubmit") => codexCommand(event)
      const session = runCommand(command("SessionStart"), sandbox, codexEvent("SessionStart", sandbox.project), {}, shell)
      const prompt = runCommand(command("UserPromptSubmit"), sandbox, codexEvent("UserPromptSubmit", sandbox.project, { prompt: "help me plan the akm release rollout this afternoon" }), {}, shell)

      expect({ shell: shell.name, exitCode: session.exitCode, stderr: session.stderr }).toEqual({ shell: shell.name, exitCode: 0, stderr: "" })
      expect({ shell: shell.name, exitCode: prompt.exitCode, stderr: prompt.stderr }).toEqual({ shell: shell.name, exitCode: 0, stderr: "" })
      expectCodexOutput(session.stdout, "SessionStart")
      expect(expectCodexOutput(prompt.stdout, "UserPromptSubmit").hookSpecificOutput.additionalContext).toContain("commands/bump-version")
      expect(readEvents(sandbox.dataDir).map((event) => `${event.harness}:${event.event}`)).toEqual(["codex:session_started", "codex:prompt_recall"])
      expectNoClaudeState(sandbox)
    }
  })

  it.skipIf(!IS_WINDOWS)("answers in JSON that survives PowerShell re-encoding a native command's output with a non-UTF-8 console code page", () => {
    // PowerShell decodes what `bun` writes with [Console]::OutputEncoding (the OEM code page) and writes it back with
    // the same one. Single-byte code pages return the bytes unchanged; double-byte ones (932 here, as on a Japanese
    // Windows) turn a UTF-8 em dash into "?", and the primer and the curated text both contain one.
    for (const shell of codexShells().filter((candidate) => candidate.name.includes("owershell") || candidate.name.startsWith("pwsh"))) {
      const sandbox = makeSandbox()
      const prompt = "help me plan the akm release rollout \u2014 \u65e5\u672c\u8a9e this afternoon"
      const command = `[Console]::OutputEncoding = [Text.Encoding]::GetEncoding(932); ${codexCommand("UserPromptSubmit")}`

      const result = runCommand(command, sandbox, codexEvent("UserPromptSubmit", sandbox.project, { prompt }), {}, shell)

      expect({ shell: shell.name, exitCode: result.exitCode, stderr: result.stderr }).toEqual({ shell: shell.name, exitCode: 0, stderr: "" })
      const payload = expectCodexOutput(result.stdout, "UserPromptSubmit")
      expect({ shell: shell.name, dash: payload.hookSpecificOutput.additionalContext.includes("\u2014") }).toEqual({ shell: shell.name, dash: true })
      // What Codex sent on stdin arrived intact too.
      expect(readCallLog(sandbox.callLog).find((call) => call.argv[0] === "curate")?.argv[1]).toBe(prompt)
    }
  })

  it.skipIf(IS_WINDOWS)("exits 0 and does nothing when the plugin directory it points at has been deleted", () => {
    for (const event of ["SessionStart", "UserPromptSubmit"] as const) {
      const sandbox = makeSandbox()
      const deleted = path.join(sandbox.root, "plugins/cache/akm-plugins/akm/0.9.0-deleted-by-the-upgrade")
      // The text Codex built when the session started; the directory is gone by the time the hook runs.
      const command = codexCommand(event).replaceAll("${PLUGIN_ROOT}", deleted)
      expect(existsSync(deleted)).toBe(false)

      const result = runCommand(command, sandbox, codexEvent(event, sandbox.project, { prompt: "help me plan the akm release rollout this afternoon" }))

      // Nothing on stdout or stderr, no block (exit 2) and no failure: the session runs without the AKM hooks.
      expect({ event, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }).toEqual({ event, exitCode: 0, stdout: "", stderr: "" })
      expect(existsSync(sandbox.dataDir)).toBe(false)
      expect(readCallLog(sandbox.callLog)).toEqual([])
    }
  })

  it.skipIf(IS_WINDOWS)("behaves the same through sh when it is handed the Windows command", () => {
    // commandWindows is plain `bun "..." <mode> --harness=codex`, valid in every shell, so POSIX CI can run the
    // Windows path of the hook (the --harness flag and PLUGIN_DATA as the state directory) too.
    const codex = readJson(codexManifestPath)
    for (const [event, mode] of [["SessionStart", "session-start"], ["UserPromptSubmit", "curate-prompt"]] as const) {
      const sandbox = makeSandbox()
      const command = codex.hooks.hooks[event][0].hooks[0].commandWindows as string
      expect(command).toContain(` ${mode} --harness=codex`)
      const result = runCommand(command, sandbox, codexEvent(event, sandbox.project, { prompt: "help me plan the akm release rollout this afternoon" }))

      expect(result.exitCode).toBe(0)
      expectCodexOutput(result.stdout, event)
      const events = readEvents(sandbox.dataDir)
      expect(events.every((entry) => entry.harness === "codex")).toBe(true)
      expect(existsSync(path.join(sandbox.dataDir, "session.log")) || existsSync(path.join(sandbox.dataDir, "feedback.log"))).toBe(true)
      expectNoClaudeState(sandbox)
    }
  })

  it.skipIf(IS_WINDOWS)("says Codex, not Claude, when bun is missing, and stays silent for other modes", () => {
    // The POSIX command goes through akm-hook.sh, which answers when bun is not on PATH. A Windows machine without
    // bun gets the shell's own error instead: there is no wrapper to degrade through there.
    const sandbox = makeSandbox({ withBun: false })
    expect(whichOn("bun", sandboxPath(sandbox.binDir))).toBeUndefined()

    const payload = expectCodexOutput(runCodexHook("SessionStart", sandbox), "SessionStart")

    expect(payload.hookSpecificOutput.additionalContext).toContain("AKM Codex hooks are currently disabled because the Bun runtime is not available on PATH.")
    expect(payload.systemMessage).toContain("AKM Codex hooks are disabled: the Bun runtime is not on PATH.")
    expect(JSON.stringify(payload)).not.toContain("Claude")
    expect(readLines(path.join(sandbox.dataDir, "session.log"))[0]).toContain("runtime_disabled\tbun_unavailable\tCodex AKM hooks are disabled until Bun is installed and on PATH.")
    expect(runCodexHook("UserPromptSubmit", sandbox, { prompt: "help me plan the akm release rollout this afternoon" })).toBe("")
    expectNoClaudeState(sandbox)
  })
})
