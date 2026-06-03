import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "..")
const hookScript = path.join(repoRoot, "claude/hooks/akm-hook.ts")
const pluginJsonPath = path.join(repoRoot, "claude/.claude-plugin/plugin.json")
const claudePackageJsonPath = path.join(repoRoot, "claude/package.json")
const marketplaceJsonPath = path.join(repoRoot, ".claude-plugin/marketplace.json")
const claudeSessionRememberArgsRe = /--format json -q remember --name claude-session-\d{8}-sess-cap/

const tempDirs: string[] = []

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "akm-claude-plugin-"))
  tempDirs.push(dir)
  return dir
}

function readLogLines(filePath: string) {
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
}

function getFirstLogEntry(stateDir: string, logName: string) {
  return readLogLines(path.join(stateDir, `akm-claude/${logName}`))[0]
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function runHook(args: string[], options?: { input?: string; env?: Record<string, string> }) {
  let stdin: "ignore" | Blob = "ignore"

  if (options?.input !== undefined) {
    const inputPath = path.join(makeTempDir(), "stdin.txt")
    writeFileSync(inputPath, options.input)
    stdin = Bun.file(inputPath)
  }

  const result = Bun.spawnSync([process.execPath, hookScript, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...options?.env,
    },
    stdio: [stdin, "pipe", "pipe"],
  })

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || `Hook exited with code ${result.exitCode}`)
  }

  return result.stdout.toString()
}

function runShellShim(args: string[], options?: { input?: string; env?: Record<string, string> }) {
  let stdin: "ignore" | Blob = "ignore"

  if (options?.input !== undefined) {
    const inputPath = path.join(makeTempDir(), "stdin.txt")
    writeFileSync(inputPath, options.input)
    stdin = Bun.file(inputPath)
  }

  return Bun.spawnSync(["sh", path.join(repoRoot, "claude/hooks/akm-hook.sh"), ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...options?.env,
    },
    stdio: [stdin, "pipe", "pipe"],
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("Claude plugin metadata", () => {
  it("registers the skill, hooks, and package metadata consistently", () => {
    const plugin = JSON.parse(readFileSync(pluginJsonPath, "utf8"))
    const pkg = JSON.parse(readFileSync(claudePackageJsonPath, "utf8"))
    const marketplace = JSON.parse(readFileSync(marketplaceJsonPath, "utf8"))
    const hookSource = readFileSync(hookScript, "utf8")

    expect(plugin.skills).toEqual(["./skills/akm"])
    expect(pkg.files).toContain("shared")
    expect(plugin.hooks.SessionStart).toBeDefined()
    expect(plugin.hooks.UserPromptSubmit).toBeDefined()
    expect(plugin.hooks.UserPromptExpansion).toBeDefined()
    expect(plugin.hooks.PostToolUse).toBeDefined()
    expect(plugin.hooks.PostToolUseFailure).toBeDefined()
    expect(plugin.hooks.PostToolBatch).toBeDefined()
    expect(plugin.hooks.Stop).toBeDefined()
    expect(plugin.hooks.SubagentStart).toBeDefined()
    expect(plugin.hooks.SubagentStop).toBeDefined()
    expect(plugin.hooks.TaskCreated).toBeDefined()
    expect(plugin.hooks.TaskCompleted).toBeDefined()
    expect(plugin.hooks.PreCompact).toBeDefined()
    expect(plugin.hooks.PostCompact).toBeDefined()
    expect(plugin.hooks.SessionEnd).toBeDefined()
    expect(plugin.version).toBe(pkg.version)
    expect(marketplace.plugins[0].version).toBe(plugin.version)

    // SessionStart wires the new session-start subcommand
    const sessionStart = plugin.hooks.SessionStart[0].hooks[0].command as string
    expect(sessionStart).toContain("session-start")

    // UserPromptSubmit wires curate-prompt
    const userPromptSubmit = plugin.hooks.UserPromptSubmit[0].hooks[0].command as string
    expect(userPromptSubmit).toContain("curate-prompt")

    const userPromptExpansion = plugin.hooks.UserPromptExpansion[0].hooks[0].command as string
    expect(userPromptExpansion).toContain("user-prompt-expansion")

    // PreToolUse no longer registers a Bash matcher — risky-command gating
    // was removed in 0.8.0 in favor of platform permission rules (see
    // claude/README.md "Locking down destructive commands"). The PreToolUse
    // array still exists for Agent / Read / Write / Edit / Glob / Grep
    // matchers used by model-alias resolution and ref observation.
    expect(plugin.hooks.PreToolUse).toBeDefined()
    const preToolMatchers = plugin.hooks.PreToolUse.map(
      (entry: { matcher?: string }) => entry.matcher,
    )
    expect(preToolMatchers).not.toContain("Bash")
    expect(preToolMatchers).toContain("Agent")

    // PostToolUse runs both post-tool and auto-feedback
    const postToolCommands = plugin.hooks.PostToolUse[0].hooks.map(
      (h: { command: string }) => h.command,
    )
    expect(postToolCommands.some((c: string) => c.includes("post-tool success"))).toBe(true)
    expect(postToolCommands.some((c: string) => c.includes("auto-feedback success"))).toBe(true)

    // Stop / SubagentStop / PreCompact capture memories
    expect(plugin.hooks.Stop[0].hooks[0].command as string).toContain("capture-memory session-end")
    expect(plugin.hooks.SubagentStop[0].hooks[0].command as string).toContain(
      "capture-memory subagent-end",
    )
    expect(plugin.hooks.SubagentStart[0].hooks[0].command as string).toContain("subagent-start")
    expect(plugin.hooks.TaskCreated[0].hooks[0].command as string).toContain("task-created")
    expect(plugin.hooks.TaskCompleted[0].hooks[0].command as string).toContain("task-completed")
    expect(plugin.hooks.PreCompact[0].hooks[0].command as string).toContain(
      "capture-memory pre-compact",
    )
    expect(plugin.hooks.PostCompact[0].hooks[0].command as string).toContain("post-compact")
    expect(plugin.hooks.PostToolBatch[0].hooks[0].command as string).toContain("post-tool-batch")
    expect(plugin.hooks.SessionEnd[0].hooks[0].command as string).toContain("session-end")

    expect(hookSource).toContain('from "../shared/feedback-signals"')
    expect(hookSource).toContain('from "../shared/memory-candidates"')
    expect(hookSource).toContain('from "../shared/memory-events"')
    expect(hookSource).toContain('from "../shared/recall-policy"')
    expect(hookSource).toContain('from "../shared/redaction"')
  })

  it("ships the slash commands and curator agent referenced by the docs", () => {
    const commandsDir = path.join(repoRoot, "claude/commands")
    const agentsDir = path.join(repoRoot, "claude/agents")
    for (const name of [
      "akm-search",
      "akm-show",
      "akm-memory-audit",
      "akm-memory-candidates",
      "akm-memory-promote",
      "akm-memory-reject",
      "akm-agent",
      "akm-cmd",
      "akm-curate",
      "akm-remember",
      "akm-feedback",
      "akm-evolve",
      "akm-wiki",
      "akm-workflow",
      "akm-env",
      "akm-secret",
      "akm-proposal",
      "akm-review-proposals",
      "akm-improve",
      "akm-propose",
      "akm-setup",
      "akm-help",
    ]) {
      const file = path.join(commandsDir, `${name}.md`)
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, "utf8")).toMatch(/^---/)
    }
    expect(existsSync(path.join(commandsDir, "akm-save.md"))).toBe(false)
    expect(existsSync(path.join(commandsDir, "akm-add.md"))).toBe(false)
    expect(existsSync(path.join(agentsDir, "akm-curator.md"))).toBe(true)
  })

  it("re-exports shared helpers to prevent silent drift", async () => {
    // Every duplicated file under claude/shared/ MUST be a one-line shim that
    // re-exports the canonical version at shared/. ref-extraction.ts is the
    // sole intentional exception — its drift is tracked in-file because the
    // resolver contract test exercises both copies against the same fixture.
    const shimmedFiles = [
      "memory-candidates",
      "memory-events",
      "redaction",
      "feedback-signals",
      "recall-policy",
    ]
    for (const name of shimmedFiles) {
      const contents = readFileSync(path.join(repoRoot, `claude/shared/${name}.ts`), "utf8")
      expect(contents.trim()).toBe(`export * from "../../shared/${name}"`)
    }
  })

  it("v0.8.0 slash commands carry the canonical proposal-flow guard rails", () => {
    const commandsDir = path.join(repoRoot, "claude/commands")
    const proposal = readFileSync(path.join(commandsDir, "akm-proposal.md"), "utf8")
    expect(proposal).toContain("akm --format json -q proposal list")
    expect(proposal).toContain("akm --format json -q proposal accept <id>")
    expect(proposal).toContain("akm --format json -q proposal reject <id>")
    expect(proposal).toMatch(/[Cc]onfirm with the user/)

    const review = readFileSync(path.join(commandsDir, "akm-review-proposals.md"), "utf8")
    expect(review).toContain("proposal list --status pending")
    expect(review).toMatch(/[Dd]o not call `?akm proposal accept/)

    const improve = readFileSync(path.join(commandsDir, "akm-improve.md"), "utf8")
    expect(improve).toContain("improve")
    expect(improve).toContain("replaces the old reflect/distill split")

    const setup = readFileSync(path.join(commandsDir, "akm-setup.md"), "utf8")
    expect(setup).toContain("agent.default")
  })

  it("keeps the curated akm_help registry table in parity across embeds", () => {
    const registryPath = path.join(repoRoot, "docs/akm-help-registry.md")
    const helpCommandPath = path.join(repoRoot, "claude/commands/akm-help.md")
    const skillPath = path.join(repoRoot, "claude/skills/akm/SKILL.md")

    const registry = readFileSync(registryPath, "utf8")
    const helpCommand = readFileSync(helpCommandPath, "utf8")
    const skill = readFileSync(skillPath, "utf8")

    // Pull every command-column cell from the canonical doc — it's column 2 in
    // a markdown table where columns are separated by " | ". We skip the
    // header and separator rows.
    const tableRows = registry
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| ---") && !line.startsWith("| Task |"))
    expect(tableRows.length).toBeGreaterThan(0)

    for (const row of tableRows) {
      // Strip the surrounding pipes, then split on " | " to get the cells:
      // [task, command, notes, keywords].
      const trimmed = row.replace(/^\|\s?/, "").replace(/\s?\|$/, "")
      const cells = trimmed.split(" | ")
      expect(cells.length).toBe(4)
      const command = cells[1].trim()
      expect(helpCommand).toContain(command)
      expect(skill).toContain(command)
    }
  })

  it("/akm-help frontmatter and body advertise the help-discovery flow", () => {
    const helpCommandPath = path.join(repoRoot, "claude/commands/akm-help.md")
    const body = readFileSync(helpCommandPath, "utf8")

    expect(body).toMatch(/^---\s*\ndescription:[^\n]+\nargument-hint:[^\n]+\n---/m)
    // Live fallback hint
    expect(body).toContain("akm --help")
    // Curated table header (parity with the canonical doc)
    expect(body).toContain("| Task | Command | Notes | Keywords |")
  })

  it("tracks cross-plugin parity work in the root README with current issue numbers", () => {
    const readmePath = path.join(repoRoot, "README.md")
    const body = readFileSync(readmePath, "utf8")

    expect(body).toContain("## Feature parity tracker")
    expect(body).toContain("| Session-start retrieval | #27 | Shipped in both plugins |")
    expect(body).toContain("| Auto-attach scope | #28 | Shipped in both plugins |")
    expect(body).toContain("| Conversation-derived feedback | #29 | Deferred to 0.9.0")
    expect(body).toContain("| Session-end `akm index` | #30 | Shipped in both plugins |")
    expect(body).toContain("| Harness-provided LLM fallback | #31 | Deferred to 0.9.0")
    expect(body).toContain("| Shared secret redaction | #64 | Shipped in both plugins |")
    expect(body).toContain("| Structured memory events | #55 | Shipped in both plugins |")
    expect(body).toContain("| Claude PreToolUse safety guard | #56 | Shipped in Claude |")
    expect(body).toContain("| Checkpoint + candidates | #57 | Shipped in both plugins |")
    expect(body).toContain("| Memory audit and candidate review | #58 | Shipped in both plugins |")
    expect(body).toContain("| Shared recall policy | #59 | Shipped in both plugins |")
    expect(body).toContain("| Confidence-scored auto-feedback | #60 | Shipped in both plugins |")
    expect(body).toContain("| Expanded Claude lifecycle coverage | #61 | Shipped in Claude |")
    expect(body).toContain("| Subagent context/result capture | #62 | Shipped in both plugins |")
    expect(body).toContain("| Workflow compliance telemetry | #63 | Shipped in both plugins |")
  })

  it("documents the Claude CLI one-shot agent dispatch path", () => {
    const commandPath = path.join(repoRoot, "claude/commands/akm-agent.md")
    const body = readFileSync(commandPath, "utf8")

    expect(body).toContain("--agents")
    expect(body).toContain("--agent")
    expect(body).toContain("--model")
    expect(body).toContain("--tools")
    expect(body).toContain("--print")
    expect(body).toContain("-p")
  })
})

describe("Claude hook scripts", () => {
  it("reuses akm on PATH when its version satisfies the required range", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })

    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
if [ "$1" = "--version" ]; then
  echo "akm 0.8.3"
  exit 0
fi
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["ensure-akm"], {
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    expect(getFirstLogEntry(stateDir, "session.log")).toContain("akm_ready\tpath")
    expect(getFirstLogEntry(stateDir, "session.log")).toContain("0.8.3")
  })

  it("records user feedback and memory intent from prompt submissions", () => {
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    runHook(["user-feedback"], {
      input: JSON.stringify({
        prompt: "Please remember that the release checklist worked great with akm.",
      }),
      env: {
        HOME: tempDir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    expect(getFirstLogEntry(stateDir, "feedback.log")).toContain("user\tprompt\tPlease remember that the release checklist worked great with akm.")
    expect(getFirstLogEntry(stateDir, "memory.log")).toContain("user\tintent\tPlease remember that the release checklist worked great with akm.")
  })

  it("records successful system feedback and memory refs for akm Bash calls", () => {
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    runHook(["post-tool", "success"], {
      input: JSON.stringify({
        tool: "Bash",
        input: { command: "akm show memory:release-retro --format json" },
        output: "{\"type\":\"memory\",\"ref\":\"memory:release-retro\",\"content\":\"Remember the rollback steps.\"}",
      }),
      env: {
        HOME: tempDir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    expect(getFirstLogEntry(stateDir, "feedback.log")).toContain("system\tsuccess\tBash\takm show memory:release-retro --format json")
    expect(getFirstLogEntry(stateDir, "memory.log")).toContain("system\tBash\tmemory:release-retro\takm show memory:release-retro --format json")
  })

  it("records failed system feedback for akm Bash failures", () => {
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    runHook(["post-tool", "failure"], {
      input: JSON.stringify({
        tool: "Bash",
        input: { command: "akm feedback skill:release --negative --note stale" },
        output: "{\"ok\":false,\"error\":\"network unavailable\"}",
      }),
      env: {
        HOME: tempDir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    expect(getFirstLogEntry(stateDir, "feedback.log")).toContain("system\tfailure\tBash\takm feedback skill:release --negative --note stale")
  })

  describe("pre-tool-agent model alias resolution", () => {
    function runPreToolAgent(model: string | null, options?: { env?: Record<string, string> }) {
      const payload: Record<string, unknown> = { tool_input: model === null ? {} : { model } }
      return runHook(["pre-tool-agent"], {
        input: JSON.stringify(payload),
        env: {
          HOME: process.env.HOME ?? "/tmp",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          ...options?.env,
        },
      })
    }

    it("passes full Claude model IDs through unchanged (no silent downgrade to sonnet)", () => {
      const fullIds = [
        "claude-opus-4-7",
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
        "claude-3-5-sonnet-20241022",
      ]
      for (const id of fullIds) {
        const stdout = runPreToolAgent(id)
        // Empty stdout means resolveModel returned the input unchanged — no
        // rewrite was emitted. The Agent tool keeps the full ID intact.
        expect(stdout.trim()).toBe("")
      }
    })

    it("keeps the four short aliases (sonnet/opus/haiku/inherit) as-is", () => {
      for (const alias of ["sonnet", "opus", "haiku", "inherit"]) {
        const stdout = runPreToolAgent(alias)
        expect(stdout.trim()).toBe("")
      }
    })

    it("remaps known cross-provider aliases to the configured Claude short alias", () => {
      const stdout = runPreToolAgent("balanced")
      const payload = JSON.parse(stdout)
      expect(payload.hookSpecificOutput.hookEventName).toBe("PreToolUse")
      expect(payload.hookSpecificOutput.permissionDecision).toBe("allow")
      expect(payload.hookSpecificOutput.updatedInput.model).toBe("sonnet")
    })

    it("falls back unknown aliases to sonnet so dispatch is never rejected upstream", () => {
      const stdout = runPreToolAgent("totally-made-up-alias")
      const payload = JSON.parse(stdout)
      expect(payload.hookSpecificOutput.updatedInput.model).toBe("sonnet")
    })
  })

  it("shell shim notifies the agent and disables Claude hooks when Bun is unavailable", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })

    const result = runShellShim(["session-start"], {
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout.toString())
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart")
    expect(payload.hookSpecificOutput.additionalContext).toContain("disabled because the Bun runtime is not available")
    const sessionLog = readLogLines(path.join(stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("runtime_disabled\tbun_unavailable"))).toBe(true)
  })

  it("curate-prompt falls back to feedback logging and buffers memory intents per session", () => {
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    runHook(["curate-prompt"], {
      input: JSON.stringify({
        session_id: "sess-curate-1",
        prompt: "please remember the steps we used to ship the akm release",
      }),
      env: {
        HOME: tempDir,
        // No akm on PATH — curate call bails silently, but the feedback
        // logging and session buffer should still be written.
        PATH: "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    expect(getFirstLogEntry(stateDir, "feedback.log")).toContain(
      "user\tprompt\tplease remember the steps we used to ship the akm release",
    )
    expect(getFirstLogEntry(stateDir, "memory.log")).toContain(
      "user\tintent\tplease remember the steps we used to ship the akm release",
    )
    const bufferPath = path.join(stateDir, "akm-claude/sessions/sess-curate-1.md")
    expect(existsSync(bufferPath)).toBe(true)
    expect(readFileSync(bufferPath, "utf8")).toContain("user memory intent")
  })

  it("curate-prompt injects hookSpecificOutput when akm returns curation results", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })

    // Fake akm that returns deterministic curate output and otherwise ignores
    // its args. Matches the global-option-before-subcommand calling shape.
    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
for arg in "$@"; do
  case "$arg" in
    curate) echo "[knowledge] release-plan"; echo "  ref: knowledge:release-plan"; exit 0 ;;
  esac
done
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    const stdout = runHook(["curate-prompt"], {
      input: JSON.stringify({
        session_id: "sess-curate-2",
        prompt: "help me plan the akm release rollout this afternoon",
      }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
        AKM_CURATE_TIMEOUT: "2",
      },
    })

    const payload = JSON.parse(stdout.trim())
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
    expect(payload.hookSpecificOutput.additionalContext).toContain("AKM stash curation written to")
    expect(payload.hookSpecificOutput.additionalContext).toContain("curated/prompt-sess-curate-2.md")
  })

  it("curate-prompt recalls release workflow prompts", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })

    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
for arg in "$@"; do
  case "$arg" in
    curate) echo "[command] bump-version"; echo "  ref: command:bump-version"; echo "[workflow] release"; echo "  ref: workflow:release"; exit 0 ;;
  esac
done
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    const stdout = runHook(["curate-prompt"], {
      input: JSON.stringify({
        session_id: "sess-curate-release-1",
        prompt: "Cut a new semver release and publish - bump version everywhere and tag the release.",
      }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const payload = JSON.parse(stdout.trim())
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit")
    expect(payload.hookSpecificOutput.additionalContext).toContain("AKM stash curation written to")
    expect(payload.hookSpecificOutput.additionalContext).toContain("curated/prompt-sess-curate-release-1.md")
  })

  it("curate-prompt skips curation for very short prompts", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })

    // akm would emit curation output, but the prompt is below the min length.
    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
echo "[knowledge] should-not-appear"
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    const stdout = runHook(["curate-prompt"], {
      input: JSON.stringify({ session_id: "sess-short", prompt: "hi" }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    expect(stdout.trim()).toBe("")
  })

  it("session-start injects hints and curated context before the first user message", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const invokeLog = path.join(tempDir, "akm-invocations.log")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    const quotedLog = shellQuote(invokeLog)

    mkdirSync(path.join(tempDir, ".config", "akm"), { recursive: true })
    writeFileSync(path.join(tempDir, ".config", "akm", "config.json"), `${JSON.stringify({})}\n`)

    // Fake akm: version/install, index no-op, hints + curated output.
    // The version MUST satisfy the plugin's required range (^0.8.0 in 0.8.0+)
    // so the new SessionStart consent gate treats akm as healthy and proceeds
    // with the normal injected-context flow.
    // Fake-akm helper: persist `akm config set <dottedKey> <jsonOrString>` calls
    // into $HOME/.config/akm/config.json so tests that assert against the file
    // still observe the plugin's writes after #463 moved them through the CLI.
    const fakeAkmConfigSet = path.join(binDir, "fake-akm-config-set.cjs")
    writeFileSync(
      fakeAkmConfigSet,
      `const fs = require("node:fs");
const path = require("node:path");
const [, , configPath, dottedKey, rawValue] = process.argv;
const segs = dottedKey.split(".");
let v;
try { v = JSON.parse(rawValue); } catch { v = rawValue; }
const cur = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
let node = cur;
for (let i = 0; i < segs.length - 1; i++) {
  if (typeof node[segs[i]] !== "object" || node[segs[i]] === null) node[segs[i]] = {};
  node = node[segs[i]];
}
node[segs[segs.length - 1]] = v;
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(cur, null, 2) + "\\n");
`,
    )

    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${quotedLog}
case "$1" in
  --version) echo "akm 0.8.3"; exit 0 ;;
  config)
    if [ "$2" = "set" ]; then
      # Strip the akm-cli 0.8.0+ hook-driven flags before passing positional args.
      # The plugin now calls: akm config set --silent --layer user <key> <value>
      # The fake helper only understands positional <key> <value>.
      shift 2
      while :; do
        case "$1" in
          --silent) shift ;;
          --layer) shift 2 ;;
          *) break ;;
        esac
      done
      node ${shellQuote(fakeAkmConfigSet)} "$HOME/.config/akm/config.json" "$1" "$2"
      exit $?
    fi
    exit 0 ;;
esac
for arg in "$@"; do
  case "$arg" in
    hints) echo "# Stash hints"; echo "akm search <query>"; exit 0 ;;
    index) exit 0 ;;
    curate) echo "# curated"; echo "- skill:deploy"; exit 0 ;;
  esac
done
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    const stdout = runHook(["session-start"], {
      input: JSON.stringify({ session_id: "sess-start-1" }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const payload = JSON.parse(stdout.trim())
    const config = JSON.parse(readFileSync(path.join(tempDir, ".config", "akm", "config.json"), "utf8"))
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart")
    expect(payload.hookSpecificOutput.additionalContext).toContain("AKM is available")
    expect(payload.hookSpecificOutput.additionalContext).toContain("Stash hints")
    expect(payload.hookSpecificOutput.additionalContext).toContain("AKM stash curation written to")
    expect(payload.hookSpecificOutput.additionalContext).toContain("curated/session-sess-start-1.md")
    // 0.8.0 canonical shape: defaults.agent + profiles.agent.<name>; the legacy
    // agent.default slot is no longer written so akm's auto-migrate doesn't
    // clobber sibling keys on load.
    expect(config.defaults.agent).toBe("claude")
    expect(config.profiles.agent.claude).toEqual({ platform: "claude" })
    expect(config.agent).toBeUndefined()

    const invocations = readFileSync(invokeLog, "utf8")
    expect(invocations).toContain("curate")
    expect(invocations).toContain("--shape agent")
    expect(invocations).not.toContain("--for-agent")
    expect(invocations).not.toContain("--detail agent")
    expect(invocations).toContain("--run sess-start-1")
  })

  it("session-start respects AKM_CONTEXT_BUDGET_CHARS", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })

    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
case "$1" in
  --version) echo "akm 9.9.9"; exit 0 ;;
esac
for arg in "$@"; do
  case "$arg" in
    hints) python3 - <<'PY'
print("H" * 180)
PY
      exit 0 ;;
    curate) python3 - <<'PY'
print("C" * 180)
PY
      exit 0 ;;
    index) exit 0 ;;
  esac
done
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    const stdout = runHook(["session-start"], {
      input: JSON.stringify({ session_id: "sess-budget-1" }),
      env: {
        AKM_CONTEXT_BUDGET_CHARS: "220",
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const payload = JSON.parse(stdout.trim())
    expect(payload.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(220)
    expect(payload.hookSpecificOutput.additionalContext).toContain("[truncated for context]")
  })

  it("auto-feedback records positive feedback for successful stash asset usage", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const feedbackLog = path.join(tempDir, "akm-feedback.log")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    const quotedLog = shellQuote(feedbackLog)

    // Fake akm that records every invocation to a log file for assertion.
    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
if [ "$1" = "index" ]; then
  printf 'index\\n' >> ${quotedLog}
  exit 0
fi
printf '%s\\n' "$*" >> ${quotedLog}
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["auto-feedback", "success"], {
      input: JSON.stringify({
        session_id: "sess-auto-1",
        tool: "Bash",
        input: { command: "akm show skill:code-review" },
        output: "{\"ref\":\"skill:code-review\"}",
      }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const recorded = readFileSync(feedbackLog, "utf8")
    expect(recorded).toContain("feedback skill:code-review --positive")
    expect(recorded).toContain("--note")
  })

  it("auto-feedback records negative feedback and skips memory refs", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const feedbackLog = path.join(tempDir, "akm-feedback.log")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    const quotedLog = shellQuote(feedbackLog)

    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${quotedLog}
if printf '%s' "$*" | grep -q 'remember'; then
  printf '{"ok":true}\\n'
  exit 0
fi
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["auto-feedback", "failure"], {
      input: JSON.stringify({
        session_id: "sess-auto-2",
        tool: "Bash",
        input: { command: "akm show command:release && akm show memory:notes" },
        output: "error: template missing",
      }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const recorded = readFileSync(feedbackLog, "utf8")
    expect(recorded).toContain("feedback command:release --negative")
    expect(recorded).not.toContain("feedback memory:notes")
  })

  it("auto-feedback logs local failures instead of exiting when feedback recording fails", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })

    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
if [ "$3" = "feedback" ] || [ "$4" = "feedback" ]; then
  exit 1
fi
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["auto-feedback", "success"], {
      input: JSON.stringify({
        session_id: "sess-auto-fail",
        tool: "Bash",
        input: { command: "akm show skill:code-review" },
        output: "{\"ref\":\"skill:code-review\"}",
      }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const feedbackLog = readLogLines(path.join(stateDir, "akm-claude/feedback.log"))
    expect(feedbackLog.some((line) => line.includes("system\tfeedback_failed\tskill:code-review\tsuccess"))).toBe(true)
    const sessionLog = readLogLines(path.join(stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("akm_failed\tauto-feedback") && line.includes("feedback skill:code-review"))).toBe(true)
  })

  it("post-tool recognizes lesson:* refs (v0.7.0)", () => {
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    runHook(["post-tool", "success"], {
      input: JSON.stringify({
        tool: "Bash",
        session_id: "sess-lesson-1",
        input: { command: "akm show lesson:rollback-pattern" },
        output: "{\"type\":\"lesson\",\"ref\":\"lesson:rollback-pattern\"}",
      }),
      env: {
        HOME: tempDir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    expect(getFirstLogEntry(stateDir, "memory.log")).toContain("lesson:rollback-pattern")
  })

  it("auto-feedback skips lesson:* refs (v0.7.0)", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const feedbackLog = path.join(tempDir, "akm-feedback.log")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    const quotedLog = shellQuote(feedbackLog)

    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${quotedLog}
if printf '%s' "$*" | grep -q 'remember'; then
  printf '{"ok":true}\\n'
  exit 0
fi
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["auto-feedback", "success"], {
      input: JSON.stringify({
        tool: "Bash",
        input: { command: "akm show lesson:rollback-pattern" },
        output: "{\"type\":\"lesson\",\"ref\":\"lesson:rollback-pattern\"}",
      }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const recorded = existsSync(feedbackLog) ? readFileSync(feedbackLog, "utf8") : ""
    expect(recorded).not.toContain("feedback lesson:rollback-pattern")
  })

  it("auto-feedback skips proposed-quality refs (v0.7.0)", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const callLog = path.join(tempDir, "akm-calls.log")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    const quotedLog = shellQuote(callLog)

    // Fake akm: when asked to `show <ref>`, return a JSON body with
    // quality:"proposed". Record every invocation so we can confirm no
    // feedback call was made.
    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${quotedLog}
case "$*" in
  *show*skill:draft-rollback*)
    echo '{"type":"skill","ref":"skill:draft-rollback","quality":"proposed"}'
    exit 0
    ;;
esac
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["auto-feedback", "success"], {
      input: JSON.stringify({
        tool: "Bash",
        input: { command: "akm show skill:draft-rollback" },
        output: "{\"type\":\"skill\",\"ref\":\"skill:draft-rollback\",\"quality\":\"proposed\"}",
      }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const calls = readFileSync(callLog, "utf8")
    // The probe call must have happened, but no feedback call should follow.
    expect(calls).toContain("show skill:draft-rollback")
    expect(calls).not.toContain("feedback skill:draft-rollback")

    const skipLog = readLogLines(path.join(stateDir, "akm-claude/feedback.log"))
    expect(skipLog.some((line) => line.includes("skip_proposed\tskill:draft-rollback"))).toBe(true)
  })

  it("auto-feedback is a no-op when the command did not invoke akm", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const feedbackLog = path.join(tempDir, "akm-feedback.log")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    const quotedLog = shellQuote(feedbackLog)

    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${quotedLog}
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["auto-feedback", "success"], {
      input: JSON.stringify({
        tool: "Bash",
        input: { command: "echo skill:code-review" },
        output: "skill:code-review",
      }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    expect(existsSync(feedbackLog)).toBe(false)
  })

  it("capture-memory flushes the session buffer through akm remember on session end", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const rememberLog = path.join(tempDir, "remember.log")
    const rememberBody = path.join(tempDir, "remember.body")
    mkdirSync(binDir, { recursive: true })
    const sessionsDir = path.join(stateDir, "akm-claude/sessions")
    mkdirSync(sessionsDir, { recursive: true })

    const bufferPath = path.join(sessionsDir, "sess-cap-1.md")
    writeFileSync(
      bufferPath,
      "## 2026-04-22T03:00:00Z — user memory intent\nremember the rollout\n\n## 2026-04-22T03:05:00Z — Bash success\n- ref: skill:rollout\n",
    )

    const quotedLog = shellQuote(rememberLog)
    const quotedBody = shellQuote(rememberBody)
    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${quotedLog}
if printf '%s' "$*" | grep -q 'remember'; then
  cat > ${quotedBody}
fi
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["capture-memory", "session-end"], {
      input: JSON.stringify({ session_id: "sess-cap-1" }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const args = readFileSync(rememberLog, "utf8")
    expect(args).toMatch(/--format json -q remember --name claude-session-\d{8}-sess-cap --force/)
    const body = readFileSync(rememberBody, "utf8")
    expect(body).toContain("# Session summary")
    expect(body).toContain("Reason: session-end")
    expect(body).toContain("## Full-detail evidence files")
    expect(body).toContain("events.jsonl")
    expect(body).toContain("memory-candidates.jsonl")
    expect(body).toContain("session.log")
    expect(body).toContain("## Evidence aggregates")
    expect(body).toContain("- ref: skill:rollout")
    expect(existsSync(bufferPath)).toBe(false)
  })

  it("capture-memory scrubs sensitive assignment shapes from durable memories", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const rememberBody = path.join(tempDir, "remember.body")
    mkdirSync(binDir, { recursive: true })
    const sessionsDir = path.join(stateDir, "akm-claude/sessions")
    mkdirSync(sessionsDir, { recursive: true })

    writeFileSync(
      path.join(sessionsDir, "sess-leak-1.md"),
      "## 2026-04-22T12:00:00Z — user memory intent\nremember the staging deploy steps, including DATABASE_URL=postgres://staging-pw-DO-NOT-LEAK@db.example.com that I just typed by accident\n\n## 2026-04-22T12:02:00Z — tool ref\n- ref: skill:code-review\n",
    )

    const quotedBody = shellQuote(rememberBody)
    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
if printf '%s' "$*" | grep -q 'remember'; then
  cat > ${quotedBody}
fi
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["capture-memory", "session-end"], {
      input: JSON.stringify({ session_id: "sess-leak-1" }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const body = readFileSync(rememberBody, "utf8")
    expect(body).toContain("DATABASE_URL: [REDACTED:DATABASE_URL]")
    expect(body).not.toContain("DATABASE_URL=")
    expect(body).not.toContain("DO-NOT-LEAK")
  })

  it("capture-memory writes checkpoint memories for proposal prep without clearing the final buffer", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const rememberLog = path.join(tempDir, "remember.log")
    const rememberBody = path.join(tempDir, "remember.body")
    mkdirSync(binDir, { recursive: true })
    const sessionsDir = path.join(stateDir, "akm-claude/sessions")
    mkdirSync(sessionsDir, { recursive: true })

    const bufferPath = path.join(sessionsDir, "sess-prep-1.md")
    writeFileSync(
      bufferPath,
      "## 2026-04-22T03:00:00Z — user memory intent\nremember the rollout\n\n## 2026-04-22T03:05:00Z — Bash success\n- ref: skill:rollout\n",
    )

    const quotedLog = shellQuote(rememberLog)
    const quotedBody = shellQuote(rememberBody)
    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${quotedLog}
if printf '%s' "$*" | grep -q 'remember'; then
  cat > ${quotedBody}
fi
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["capture-memory", "proposal-prep"], {
      input: JSON.stringify({ session_id: "sess-prep-1" }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const args = readFileSync(rememberLog, "utf8")
    expect(args).toMatch(/--format json -q remember --name claude-checkpoint-\d{14}-sess-pre --force/)
    expect(readFileSync(rememberBody, "utf8")).toContain("Reason: proposal-prep")
    expect(existsSync(bufferPath)).toBe(true)
  })

  it("capture-memory validates ref candidates against the live stash and writes only survivors to frontmatter", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const stashDir = path.join(tempDir, "stash")
    const rememberLog = path.join(tempDir, "remember.log")
    const rememberBody = path.join(tempDir, "remember.body")
    mkdirSync(binDir, { recursive: true })
    const sessionsDir = path.join(stateDir, "akm-claude/sessions")
    mkdirSync(sessionsDir, { recursive: true })
    // Stash contains the real targets…
    mkdirSync(path.join(stashDir, "memories"), { recursive: true })
    mkdirSync(path.join(stashDir, "agents"), { recursive: true })
    writeFileSync(path.join(stashDir, "memories", "rollout-notes.md"), "x")
    writeFileSync(path.join(stashDir, "agents", "bunjs-coder.md"), "x")

    // Buffer simulates 2+ post-tool entries that have already been recorded.
    const bufferPath = path.join(sessionsDir, "sess-validated.md")
    writeFileSync(
      bufferPath,
      "## 2026-04-22T03:00:00Z — Bash success\n- command: grep -E 'memory:foo|memory:bar' /tmp/x\n\n## 2026-04-22T03:01:00Z — Bash success\n- command: akm show memory:rollout-notes\n",
    )
    // Sidecar simulates the candidates that recordPostTool() accumulated.
    // Mix of real refs (resolve) and literal strings (do not resolve).
    const refSidecar = path.join(sessionsDir, "sess-validated.refs.jsonl")
    writeFileSync(
      refSidecar,
      [
        '{"ref":"memory:foo"}',
        '{"ref":"memory:bar"}',
        '{"ref":"memory:rollout-notes"}',
        '{"ref":"agent:bunjs-coder"}',
        '{"ref":"agent:bunjs-coder"}',
        '{"ref":"knowledge:projects/akm/does-not-exist"}',
      ].join("\n") + "\n",
    )

    const quotedLog = shellQuote(rememberLog)
    const quotedBody = shellQuote(rememberBody)
    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${quotedLog}
if printf '%s' "$*" | grep -q 'remember'; then
  cat > ${quotedBody}
fi
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["capture-memory", "session-end"], {
      input: JSON.stringify({ session_id: "sess-validated" }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
        AKM_STASH_DIR: stashDir,
      },
    })

    const body = readFileSync(rememberBody, "utf8")
    // The validated refs land in frontmatter, sorted and deduped.
    expect(body).toContain("refs:\n  - agent:bunjs-coder\n  - memory:rollout-notes")
    // The literal-string candidates that never resolved are absent.
    expect(body).not.toContain("- memory:foo")
    expect(body).not.toContain("- memory:bar")
    expect(body).not.toContain("- knowledge:projects/akm/does-not-exist")
    // The body still contains the raw command transcript verbatim — including
    // the literal grep pattern that contains `memory:foo`. The lint
    // carve-out treats the frontmatter array as authoritative so those
    // strings do not produce missing-ref flags.
    expect(body).toContain("grep -E 'memory:foo|memory:bar'")
    // Sidecar is cleaned up after capture.
    expect(existsSync(refSidecar)).toBe(false)
    expect(existsSync(bufferPath)).toBe(false)
  })

  it("capture-memory omits the refs key when no candidates survive validation", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const stashDir = path.join(tempDir, "stash")
    const rememberBody = path.join(tempDir, "remember.body")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stashDir, { recursive: true })
    const sessionsDir = path.join(stateDir, "akm-claude/sessions")
    mkdirSync(sessionsDir, { recursive: true })

    const bufferPath = path.join(sessionsDir, "sess-empty.md")
    writeFileSync(
      bufferPath,
      "## 2026-04-22T03:00:00Z — Bash success\n- command: echo memory:foo\n\n## 2026-04-22T03:01:00Z — Bash success\n- command: echo memory:bar\n",
    )
    // All candidates are literal strings — none resolve against the empty stash.
    writeFileSync(
      path.join(sessionsDir, "sess-empty.refs.jsonl"),
      '{"ref":"memory:foo"}\n{"ref":"memory:bar"}\n',
    )

    const quotedBody = shellQuote(rememberBody)
    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
if printf '%s' "$*" | grep -q 'remember'; then
  cat > ${quotedBody}
fi
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["capture-memory", "session-end"], {
      input: JSON.stringify({ session_id: "sess-empty" }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
        AKM_STASH_DIR: stashDir,
      },
    })

    const body = readFileSync(rememberBody, "utf8")
    expect(body).not.toContain("refs:")
    expect(body).toContain("akm_memory_kind: session_checkpoint")
  })

  it("post-tool writes ref candidates to a sidecar file (not into the buffer body)", () => {
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    runHook(["post-tool", "success"], {
      input: JSON.stringify({
        session_id: "sess-sidecar",
        tool: "Bash",
        input: { command: "cat <<'EOF'\nmemory:foo\nknowledge:projects/akm/bar\nEOF" },
        output: "ok",
      }),
      env: {
        HOME: tempDir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    const sessionsDir = path.join(stateDir, "akm-claude/sessions")
    const bufferPath = path.join(sessionsDir, "sess-sidecar.md")
    const refSidecar = path.join(sessionsDir, "sess-sidecar.refs.jsonl")

    // Buffer holds the command line but NOT a `- ref: ...` injection line.
    const buffer = readFileSync(bufferPath, "utf8")
    expect(buffer).toContain("- command: cat")
    expect(buffer).not.toMatch(/^- ref:/m)
    // Sidecar holds the permissive candidate list (validation runs at capture time).
    const sidecar = readFileSync(refSidecar, "utf8")
    expect(sidecar).toContain('"ref":"memory:foo"')
    expect(sidecar).toContain('"ref":"knowledge:projects/akm/bar"')
  })

  it("capture-memory logs remember failures instead of claiming capture success", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    mkdirSync(binDir, { recursive: true })
    const sessionsDir = path.join(stateDir, "akm-claude/sessions")
    mkdirSync(sessionsDir, { recursive: true })

    const bufferPath = path.join(sessionsDir, "sess-cap-remember-fail.md")
    writeFileSync(
      bufferPath,
      "## 2026-04-22T03:00:00Z — user memory intent\nremember the rollout\n\n## 2026-04-22T03:05:00Z — Bash success\n- ref: skill:rollout\n",
    )

    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
if [ "$3" = "remember" ] || [ "$4" = "remember" ]; then
  exit 1
fi
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["capture-memory", "session-end"], {
      input: JSON.stringify({ session_id: "sess-cap-remember-fail" }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const memoryLog = readLogLines(path.join(stateDir, "akm-claude/memory.log"))
    expect(memoryLog.some((line) => line.includes("system\tcapture_failed\tmemory:claude-session-"))).toBe(true)
    const sessionLog = readLogLines(path.join(stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("akm_failed\tcapture-memory") && line.includes("remember --name"))).toBe(true)
    expect(existsSync(bufferPath)).toBe(false)
  })

  it("unknown hook commands are logged locally without stderr noise", () => {
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    const stdout = runHook(["not-a-real-command"], {
      env: {
        HOME: tempDir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    expect(stdout.trim()).toBe("")
    const sessionLog = readLogLines(path.join(stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("runtime_error\tunknown_command\tnot-a-real-command"))).toBe(true)
  })

  it("capture-memory optionally runs akm index after a session-end flush", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const commandLog = path.join(tempDir, "commands.log")
    mkdirSync(binDir, { recursive: true })
    const sessionsDir = path.join(stateDir, "akm-claude/sessions")
    mkdirSync(sessionsDir, { recursive: true })

    writeFileSync(
      path.join(sessionsDir, "sess-cap-idx.md"),
      "## 2026-04-22T03:00:00Z — user memory intent\nremember the rollout\n\n## 2026-04-22T03:05:00Z — Bash success\n- ref: skill:rollout\n",
    )

    const quotedLog = shellQuote(commandLog)
    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${quotedLog}
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["capture-memory", "session-end"], {
      input: JSON.stringify({ session_id: "sess-cap-idx" }),
      env: {
        AKM_INDEX_ON_SESSION_END: "1",
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const commands = readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean)
    expect(commands.some((line) => claudeSessionRememberArgsRe.test(line))).toBe(true)
    expect(existsSync(path.join(sessionsDir, "sess-cap-idx.md"))).toBe(false)
  })

  it("capture-memory logs index failures without aborting cleanup", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    mkdirSync(binDir, { recursive: true })
    const sessionsDir = path.join(stateDir, "akm-claude/sessions")
    mkdirSync(sessionsDir, { recursive: true })

    const bufferPath = path.join(sessionsDir, "sess-cap-fail.md")
    writeFileSync(
      bufferPath,
      "## 2026-04-22T03:00:00Z — user memory intent\nremember the rollout\n\n## 2026-04-22T03:05:00Z — Bash success\n- ref: skill:rollout\n",
    )

    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
if printf '%s' "$*" | grep -q 'remember'; then
  printf '{"ok":true}\n'
  exit 0
fi
if [ "$1" = "index" ]; then
  exit 1
fi
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["capture-memory", "session-end"], {
      input: JSON.stringify({ session_id: "sess-cap-fail" }),
      env: {
        AKM_INDEX_ON_SESSION_END: "1",
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const sessionLog = readLogLines(path.join(stateDir, "akm-claude/session.log"))
    expect(sessionLog.some((line) => line.includes("\takm_index_failed\tsession-end\tsess-cap-fail\tmemory:claude-session-"))).toBe(true)
    expect(existsSync(bufferPath)).toBe(false)
  })

  it("capture-memory clears trivial buffers without calling akm remember", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const rememberLog = path.join(tempDir, "remember.log")
    mkdirSync(binDir, { recursive: true })
    const sessionsDir = path.join(stateDir, "akm-claude/sessions")
    mkdirSync(sessionsDir, { recursive: true })

    // Only one entry — below the 2-entry threshold.
    const bufferPath = path.join(sessionsDir, "sess-cap-2.md")
    writeFileSync(bufferPath, "## 2026-04-22T03:00:00Z — user memory intent\nremember the rollout\n")

    const quotedLog = shellQuote(rememberLog)
    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${quotedLog}
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["capture-memory", "session-end"], {
      input: JSON.stringify({ session_id: "sess-cap-2" }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    expect(existsSync(rememberLog)).toBe(false)
    expect(existsSync(bufferPath)).toBe(false)
  })

  it("derives a memory ref from akm remember --name when output omits it", () => {
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    runHook(["post-tool", "success"], {
      input: JSON.stringify({
        tool: "Bash",
        input: { command: "akm remember --name release-retro" },
        output: "{\"ok\":true}",
      }),
      env: {
        HOME: tempDir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    expect(getFirstLogEntry(stateDir, "memory.log")).toContain("system\tBash\tmemory:release-retro\takm remember --name release-retro")
  })

  it("auto-feedback passes run scope from session_id", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const feedbackLog = path.join(tempDir, "akm-feedback.log")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    const quotedLog = shellQuote(feedbackLog)

    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${quotedLog}
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["auto-feedback", "success"], {
      input: JSON.stringify({
        session_id: "sess-scope-1",
        tool: "Bash",
        input: { command: "akm show skill:deploy" },
        output: "{\"ref\":\"skill:deploy\"}",
      }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const recorded = readFileSync(feedbackLog, "utf8")
    expect(recorded).toContain("feedback skill:deploy --positive")
    expect(recorded).toContain("--run sess-scope-1")
  })

  it("auto-feedback passes user/agent/channel scope from env vars", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const feedbackLog = path.join(tempDir, "akm-feedback.log")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    const quotedLog = shellQuote(feedbackLog)

    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${quotedLog}
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["auto-feedback", "success"], {
      input: JSON.stringify({
        session_id: "sess-scope-2",
        tool: "Bash",
        input: { command: "akm show skill:deploy" },
        output: "{\"ref\":\"skill:deploy\"}",
      }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
        AKM_USER_ID: "alice",
        AKM_AGENT_ID: "reviewer",
        AKM_CHANNEL: "pr-42",
      },
    })

    const recorded = readFileSync(feedbackLog, "utf8")
    expect(recorded).toContain("--user alice")
    expect(recorded).toContain("--agent reviewer")
    expect(recorded).toContain("--run sess-scope-2")
    expect(recorded).toContain("--channel pr-42")
  })

  it("auto-feedback respects AKM_SCOPE_KEYS to limit which scope flags are passed", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const feedbackLog = path.join(tempDir, "akm-feedback.log")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    const quotedLog = shellQuote(feedbackLog)

    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${quotedLog}
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["auto-feedback", "success"], {
      input: JSON.stringify({
        session_id: "sess-scope-3",
        tool: "Bash",
        input: { command: "akm show skill:deploy" },
        output: "{\"ref\":\"skill:deploy\"}",
      }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
        AKM_USER_ID: "alice",
        AKM_SCOPE_KEYS: "run",
      },
    })

    const recorded = readFileSync(feedbackLog, "utf8")
    expect(recorded).toContain("--run sess-scope-3")
    expect(recorded).not.toContain("--user alice")
  })

  it("capture-memory passes run scope from session_id", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const rememberLog = path.join(tempDir, "remember.log")
    mkdirSync(binDir, { recursive: true })
    const sessionsDir = path.join(stateDir, "akm-claude/sessions")
    mkdirSync(sessionsDir, { recursive: true })

    const bufferPath = path.join(sessionsDir, "sess-scope-mem.md")
    writeFileSync(
      bufferPath,
      "## 2026-04-22T03:00:00Z — user memory intent\nremember the rollout\n\n## 2026-04-22T03:05:00Z — Bash success\n- ref: skill:rollout\n",
    )

    const quotedLog = shellQuote(rememberLog)
    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${quotedLog}
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["capture-memory", "session-end"], {
      input: JSON.stringify({ session_id: "sess-scope-mem" }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const args = readFileSync(rememberLog, "utf8")
    expect(args).toContain("--run sess-scope-mem")
  })

  it("capture-memory passes user/channel scope from env vars", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const rememberLog = path.join(tempDir, "remember.log")
    mkdirSync(binDir, { recursive: true })
    const sessionsDir = path.join(stateDir, "akm-claude/sessions")
    mkdirSync(sessionsDir, { recursive: true })

    const bufferPath = path.join(sessionsDir, "sess-scope-env.md")
    writeFileSync(
      bufferPath,
      "## 2026-04-22T03:00:00Z — user memory intent\nremember the rollout\n\n## 2026-04-22T03:05:00Z — Bash success\n- ref: skill:rollout\n",
    )

    const quotedLog = shellQuote(rememberLog)
    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${quotedLog}
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["capture-memory", "session-end"], {
      input: JSON.stringify({ session_id: "sess-scope-env" }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
        AKM_USER_ID: "bob",
        AKM_CHANNEL: "nightly",
      },
    })

    const args = readFileSync(rememberLog, "utf8")
    expect(args).toContain("--user bob")
    expect(args).toContain("--run sess-scope-env")
    expect(args).toContain("--channel nightly")
  })

  it("pre-tool returns an empty verdict (Bash gating removed; defer to platform permissions)", () => {
    // 0.8.0 removed the tokenized risky-command gate. The hook is still
    // wired for pre-tool calls but never blocks — destructive akm verbs are
    // now gated via Claude Code's `permissions.ask` / `permissions.deny`
    // entries (documented in claude/README.md "Locking down destructive
    // commands"). This test pins the no-block behavior so a future regression
    // re-introducing tokenized blocking would be caught.
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    for (const command of [
      "akm accept p_123",
      "akm revert p_abc",
      "akm tasks add nightly --cron \"0 2 * * *\"",
      "akm env create --from-file .env.dev",
      "akm remember OPENAI_API_KEY=sk-secret-value",
    ]) {
      const stdout = runHook(["pre-tool", "bash"], {
        input: JSON.stringify({
          session_id: "sess-pretool-passthrough",
          tool: "Bash",
          input: { command },
        }),
        env: {
          HOME: tempDir,
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          XDG_STATE_HOME: stateDir,
        },
      })
      // No stdout / no block decision for any of these — the hook is a
      // no-op for the Bash matcher post-removal.
      expect(stdout.trim()).toBe("")
    }
  })

  it("user-prompt-expansion emits guidance for mutating slash commands", () => {
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    const stdout = runHook(["user-prompt-expansion"], {
      input: JSON.stringify({ session_id: "sess-expand-1", command: "/akm-memory-promote cand-1" }),
      env: {
        HOME: tempDir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    const payload = JSON.parse(stdout.trim())
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptExpansion")
    expect(payload.hookSpecificOutput.additionalContext).toContain("mutating memory/proposal flows")
  })

  it("user-prompt-expansion treats akm-memory-reject as mutating guidance", () => {
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    const stdout = runHook(["user-prompt-expansion"], {
      input: JSON.stringify({ session_id: "sess-expand-2", command: "/akm-memory-reject cand-1" }),
      env: {
        HOME: tempDir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    const payload = JSON.parse(stdout.trim())
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptExpansion")
    expect(payload.hookSpecificOutput.additionalContext).toContain("mutating memory/proposal flows")
  })

  it("user-prompt-expansion treats akm-proposal list as non-mutating guidance", () => {
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    const stdout = runHook(["user-prompt-expansion"], {
      input: JSON.stringify({ session_id: "sess-expand-3", command: "/akm-proposal list --status pending" }),
      env: {
        HOME: tempDir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    const payload = JSON.parse(stdout.trim())
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptExpansion")
    expect(payload.hookSpecificOutput.additionalContext).toContain("slash-command expansion should keep mutating actions explicit")
    expect(payload.hookSpecificOutput.additionalContext).not.toContain("mutating memory/proposal flows")
  })

  it("user-prompt-expansion treats akm-proposal reject as mutating guidance", () => {
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    const stdout = runHook(["user-prompt-expansion"], {
      input: JSON.stringify({ session_id: "sess-expand-4", command: "/akm-proposal reject p_123 --reason \"not durable\"" }),
      env: {
        HOME: tempDir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    const payload = JSON.parse(stdout.trim())
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptExpansion")
    expect(payload.hookSpecificOutput.additionalContext).toContain("mutating memory/proposal flows")
  })

  it("user-prompt-expansion treats akm-proposal drain as mutating guidance", () => {
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    const stdout = runHook(["user-prompt-expansion"], {
      input: JSON.stringify({ session_id: "sess-expand-drain", command: "/akm-proposal drain --policy conservative --promote --yes" }),
      env: {
        HOME: tempDir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    const payload = JSON.parse(stdout.trim())
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptExpansion")
    expect(payload.hookSpecificOutput.additionalContext).toContain("mutating memory/proposal flows")
  })

  it("user-prompt-expansion captures a fresh checkpoint before improve/propose flows", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const rememberLog = path.join(tempDir, "remember.log")
    mkdirSync(binDir, { recursive: true })
    const sessionsDir = path.join(stateDir, "akm-claude/sessions")
    mkdirSync(sessionsDir, { recursive: true })
    writeFileSync(
      path.join(sessionsDir, "sess-expand-prep.md"),
      "## 2026-04-22T03:00:00Z — user memory intent\nremember release lessons\n\n## 2026-04-22T03:05:00Z — Bash success\n- ref: skill:rollout\n",
    )

    const quotedLog = shellQuote(rememberLog)
    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${quotedLog}
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["user-prompt-expansion"], {
      input: JSON.stringify({ session_id: "sess-expand-prep", command: "/akm-improve memory:release-summary --task refine lesson" }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const recorded = readFileSync(rememberLog, "utf8")
    expect(recorded).toContain("remember --name claude-checkpoint-")
    expect(existsSync(path.join(sessionsDir, "sess-expand-prep.md"))).toBe(true)
  })

  it("task-completed candidate extraction keeps source paths and targets the touched ref", () => {
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    runHook(["task-completed"], {
      input: JSON.stringify({
        session_id: "sess-task-candidate",
        task_id: "task-1",
        summary: "The release workflow failed with skill:deploy, and the fix worked after updating the checklist.",
      }),
      env: {
        HOME: tempDir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    const candidates = readFileSync(path.join(stateDir, "akm-claude/memory-candidates.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    expect(candidates.length).toBeGreaterThan(0)
    expect(candidates.some((candidate) => candidate.targetRef === "skill:deploy")).toBe(true)
    expect(candidates.some((candidate) => Array.isArray(candidate.sourcePaths) && candidate.sourcePaths.some((entry: string) => entry.includes("sessions/sess-task-candidate.md")))).toBe(true)
  })

  it("post-tool-batch records a grouped tool observation without throwing", () => {
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    const stdout = runHook(["post-tool-batch"], {
      input: JSON.stringify({
        session_id: "sess-batch-1",
        tools: [
          { tool: "Read", input: { file: "README.md" } },
          { tool: "Bash", input: { command: "akm show skill:deploy" } },
        ],
      }),
      env: {
        HOME: tempDir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    expect(stdout.trim()).toBe("")
    const bufferPath = path.join(stateDir, "akm-claude/sessions/sess-batch-1.md")
    expect(readFileSync(bufferPath, "utf8")).toContain("tool batch")
  })

  it("subagent-start injects scoped AKM context", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })

    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
if [ "$1" = "--format" ] && [ "$4" = "workflow" ]; then
  echo '[{"ref":"workflow:release","runId":"run-1","state":"active"}]'
  exit 0
fi
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    const stdout = runHook(["subagent-start"], {
      input: JSON.stringify({ session_id: "sess-subagent-1", agent: "reviewer", task: "Review auth middleware" }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const payload = JSON.parse(stdout.trim())
    expect(payload.hookSpecificOutput.hookEventName).toBe("SubagentStart")
    expect(payload.hookSpecificOutput.additionalContext).toContain("Role: reviewer")
    expect(payload.hookSpecificOutput.additionalContext).toContain("Review auth middleware")
  })

  it("task-created and task-completed log task lifecycle without breaking", () => {
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    runHook(["task-created"], {
      input: JSON.stringify({ session_id: "sess-task-1", task_id: "task-1", title: "Implement memory audit" }),
      env: {
        HOME: tempDir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    runHook(["task-completed"], {
      input: JSON.stringify({ session_id: "sess-task-1", task_id: "task-1", summary: "Decision: keep event writes redacted and checkpointed" }),
      env: {
        HOME: tempDir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    const bufferPath = path.join(stateDir, "akm-claude/sessions/sess-task-1.md")
    const body = readFileSync(bufferPath, "utf8")
    expect(body).toContain("task created")
    expect(body).toContain("task completed")
  })

  it("post-compact records compact summary context", () => {
    const tempDir = makeTempDir()
    const stateDir = path.join(tempDir, "state")
    mkdirSync(stateDir, { recursive: true })

    const stdout = runHook(["post-compact"], {
      input: JSON.stringify({ session_id: "sess-compact-1", summary: "Kept active workflow and deployment constraints" }),
      env: {
        HOME: tempDir,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        XDG_STATE_HOME: stateDir,
      },
    })

    expect(stdout.trim()).toBe("")
    const bufferPath = path.join(stateDir, "akm-claude/sessions/sess-compact-1.md")
    expect(readFileSync(bufferPath, "utf8")).toContain("post compact")
  })

  it("session-end reuses capture-memory finalization", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    const rememberLog = path.join(tempDir, "remember.log")
    mkdirSync(binDir, { recursive: true })
    const sessionsDir = path.join(stateDir, "akm-claude/sessions")
    mkdirSync(sessionsDir, { recursive: true })

    writeFileSync(
      path.join(sessionsDir, "sess-end-1.md"),
      "## 2026-04-22T03:00:00Z — user memory intent\nremember the rollout\n\n## 2026-04-22T03:05:00Z — Bash success\n- ref: skill:rollout\n",
    )

    const quotedLog = shellQuote(rememberLog)
    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
printf '%s\\n' "$*" >> ${quotedLog}
exit 0
`,
    )
    chmodSync(path.join(binDir, "akm"), 0o755)

    runHook(["session-end"], {
      input: JSON.stringify({ session_id: "sess-end-1" }),
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    const args = readFileSync(rememberLog, "utf8")
    expect(args).toContain("remember --name claude-session-")
  })
})
