import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const repoRoot = "/home/runner/work/akm-plugins/akm-plugins"
const hookScript = path.join(repoRoot, "claude/hooks/agentikit-hook.sh")
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

function runHook(args: string[], options?: { input?: string; env?: Record<string, string> }) {
  return execFileSync("sh", [hookScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    input: options?.input ?? "",
    env: {
      ...process.env,
      ...options?.env,
    },
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

    expect(plugin.skills).toEqual(["./skills/agentikit"])
    expect(plugin.hooks.SessionStart).toBeDefined()
    expect(plugin.hooks.UserPromptSubmit).toBeDefined()
    expect(plugin.hooks.PostToolUse).toBeDefined()
    expect(plugin.hooks.PostToolUseFailure).toBeDefined()
    expect(plugin.version).toBe(pkg.version)
    expect(marketplace.plugins[0].version).toBe(plugin.version)
  })
})

describe("Claude hook scripts", () => {
  it("ensures the latest akm package through npm when bun is unavailable", () => {
    const tempDir = makeTempDir()
    const binDir = path.join(tempDir, "bin")
    const globalBinDir = path.join(tempDir, "global-bin")
    const stateDir = path.join(tempDir, "state")
    const npmLogPath = path.join(tempDir, "npm.log")

    mkdirSync(binDir, { recursive: true })
    mkdirSync(globalBinDir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })

    const fakeNpmPath = path.join(binDir, "npm")
    writeFileSync(
      fakeNpmPath,
      `#!/usr/bin/env sh
set -eu
if [ "$1" = "install" ] && [ "${"$"}{2:-}" = "-g" ]; then
    printf '%s\\n' "$*" >> "${npmLogPath}"
    mkdir -p "${globalBinDir}"
    cat > "${globalBinDir}/akm" <<'EOF'
#!/usr/bin/env sh
echo "akm 9.9.9"
EOF
    chmod +x "${globalBinDir}/akm"
elif [ "$1" = "bin" ] && [ "${"$"}{2:-}" = "-g" ]; then
    printf '%s\\n' "${globalBinDir}"
elif [ "$1" = "prefix" ] && [ "${"$"}{2:-}" = "-g" ]; then
    printf '%s\\n' "${tempDir}"
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
    expect(readLogLines(path.join(stateDir, "agentikit-claude/session.log"))[0]).toContain("akm_ready")
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

    expect(readLogLines(path.join(stateDir, "agentikit-claude/feedback.log"))[0]).toContain("user\tprompt\tPlease remember that the release checklist worked great with akm.")
    expect(readLogLines(path.join(stateDir, "agentikit-claude/memory.log"))[0]).toContain("user\tintent\tPlease remember that the release checklist worked great with akm.")
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

    expect(readLogLines(path.join(stateDir, "agentikit-claude/feedback.log"))[0]).toContain("system\tsuccess\tBash\takm show memory:release-retro --format json")
    expect(readLogLines(path.join(stateDir, "agentikit-claude/memory.log"))[0]).toContain("system\tBash\tmemory:release-retro\takm show memory:release-retro --format json")
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

    expect(readLogLines(path.join(stateDir, "agentikit-claude/feedback.log"))[0]).toContain("system\tfailure\tBash\takm feedback skill:release --negative --note stale")
  })
})
