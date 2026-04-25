import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "..")
const hookScript = path.join(repoRoot, "claude/hooks/akm-hook.sh")
const pluginJsonPath = path.join(repoRoot, "claude/.claude-plugin/plugin.json")
const claudePackageJsonPath = path.join(repoRoot, "claude/package.json")
const marketplaceJsonPath = path.join(repoRoot, ".claude-plugin/marketplace.json")

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

  const result = Bun.spawnSync(["sh", hookScript, ...args], {
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

    expect(plugin.skills).toEqual(["./skills/akm"])
    expect(plugin.hooks.SessionStart).toBeDefined()
    expect(plugin.hooks.UserPromptSubmit).toBeDefined()
    expect(plugin.hooks.PostToolUse).toBeDefined()
    expect(plugin.hooks.PostToolUseFailure).toBeDefined()
    expect(plugin.hooks.Stop).toBeDefined()
    expect(plugin.hooks.SubagentStop).toBeDefined()
    expect(plugin.hooks.PreCompact).toBeDefined()
    expect(plugin.version).toBe(pkg.version)
    expect(marketplace.plugins[0].version).toBe(plugin.version)

    // SessionStart wires the new session-start subcommand
    const sessionStart = plugin.hooks.SessionStart[0].hooks[0].command as string
    expect(sessionStart).toContain("session-start")

    // UserPromptSubmit wires curate-prompt
    const userPromptSubmit = plugin.hooks.UserPromptSubmit[0].hooks[0].command as string
    expect(userPromptSubmit).toContain("curate-prompt")

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
    expect(plugin.hooks.PreCompact[0].hooks[0].command as string).toContain(
      "capture-memory pre-compact",
    )
  })

  it("ships the slash commands and curator agent referenced by the docs", () => {
    const commandsDir = path.join(repoRoot, "claude/commands")
    const agentsDir = path.join(repoRoot, "claude/agents")
    for (const name of [
      "akm-search",
      "akm-show",
      "akm-agent",
      "akm-cmd",
      "akm-curate",
      "akm-remember",
      "akm-feedback",
      "akm-evolve",
      "akm-wiki",
      "akm-workflow",
      "akm-add",
      "akm-vault",
      "akm-help",
    ]) {
      const file = path.join(commandsDir, `${name}.md`)
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file, "utf8")).toMatch(/^---/)
    }
    // akm-save was removed in 0.6.0 — saving is reached via /akm-help.
    expect(existsSync(path.join(commandsDir, "akm-save.md"))).toBe(false)
    expect(existsSync(path.join(agentsDir, "akm-curator.md"))).toBe(true)
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
})

describe("Claude hook scripts", () => {
  it("ensures the latest akm package through npm when bun is unavailable", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const globalBinDir = path.join(tempDir, "global-bin")
    const stateDir = path.join(tempDir, "state")
    const npmLogPath = path.join(tempDir, "npm.log")
    const quotedNpmLogPath = shellQuote(npmLogPath)
    const quotedGlobalBinDir = shellQuote(globalBinDir)
    const quotedTempDir = shellQuote(tempDir)

    mkdirSync(binDir, { recursive: true })
    mkdirSync(globalBinDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })

    const fakeNpmPath = path.join(binDir, "npm")
    writeFileSync(
      fakeNpmPath,
      `#!/usr/bin/env sh
set -eu
if [ "$1" = "install" ] && [ "\${2:-}" = "-g" ]; then
    printf '%s %s %s\\n' "$1" "\${2:-}" "\${3:-}" >> ${quotedNpmLogPath}
    mkdir -p ${quotedGlobalBinDir}
    cat > ${quotedGlobalBinDir}/akm <<'EOF'
#!/usr/bin/env sh
echo "akm 9.9.9"
EOF
    chmod +x ${quotedGlobalBinDir}/akm
elif [ "$1" = "bin" ] && [ "\${2:-}" = "-g" ]; then
    printf '%s\\n' ${quotedGlobalBinDir}
elif [ "$1" = "prefix" ] && [ "\${2:-}" = "-g" ]; then
    printf '%s\\n' ${quotedTempDir}
elif [ "$1" = "--version" ]; then
    printf '10.9.0\\n'
else
    exit 0
fi
`,
    )
    chmodSync(fakeNpmPath, 0o755)

    runHook(["ensure-akm"], {
      env: {
        HOME: tempDir,
        PATH: `${binDir}:/usr/bin:/bin`,
        XDG_STATE_HOME: stateDir,
      },
    })

    expect(readFileSync(npmLogPath, "utf8")).toContain("install -g akm-cli@latest")
    expect(existsSync(path.join(binDir, "akm"))).toBe(true)
    expect(getFirstLogEntry(stateDir, "session.log")).toContain("akm_ready")
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
    expect(payload.hookSpecificOutput.additionalContext).toContain("AKM stash")
    expect(payload.hookSpecificOutput.additionalContext).toContain("knowledge:release-plan")
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

  it("session-start wraps akm hints output as SessionStart additionalContext", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const stateDir = path.join(tempDir, "state")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })

    // Fake akm: version/install, index no-op, hints output.
    writeFileSync(
      path.join(binDir, "akm"),
      `#!/usr/bin/env sh
case "$1" in
  --version) echo "akm 9.9.9"; exit 0 ;;
esac
for arg in "$@"; do
  case "$arg" in
    hints) echo "# Stash hints"; echo "akm search <query>"; exit 0 ;;
    index) exit 0 ;;
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
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart")
    expect(payload.hookSpecificOutput.additionalContext).toContain("AKM is available")
    expect(payload.hookSpecificOutput.additionalContext).toContain("Stash hints")
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
    expect(body).toContain("- ref: skill:rollout")
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
})
