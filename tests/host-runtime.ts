// Shared by the hook-invocation tests: what the two hosts do to run a plugin hook,
// on every platform the plugin supports.
//
// - Claude Code runs a hook written in exec form (`command` + `args`, which is how
//   .claude-plugin/plugin.json declares all of them) by spawning `command` directly,
//   with no shell, after substituting ${CLAUDE_PLUGIN_ROOT} into `command` and each
//   argument. On Windows the substituted path uses forward slashes.
//   https://code.claude.com/docs/en/hooks#exec-form-and-shell-form
// - Codex picks `commandWindows` over `command` on Windows, substitutes
//   ${PLUGIN_ROOT} / ${PLUGIN_DATA} (and the CLAUDE_-prefixed aliases) into the
//   text, and hands the result to the session's shell: `<shell> -c`, or on Windows
//   PowerShell (`pwsh`, else `powershell.exe`, as `-NoProfile -Command`) and, when
//   no shell is known, `%COMSPEC% /C "<command>"`.
//   codex-rs/hooks/src/engine/discovery.rs, command_runner.rs and
//   core/src/session/mod.rs (build_hooks_config)

import { it } from "bun:test"
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

export const IS_WINDOWS = process.platform === "win32"
const SYSTEM_ROOT = process.env.SystemRoot ?? "C:\\Windows"

/**
 * `it` for a test that cannot run on Windows: it writes its fake akm as a POSIX sh script, asserts POSIX mode
 * bits, or runs the sh wrapper (akm-hook.sh), none of which a Windows machine has. There it is registered as a
 * skipped test whose name says why. What such a test covers is covered on Windows by hook-commands.test.ts and
 * codex-plugin.test.ts, which run the manifests' own commands against a fake akm that is akm.cmd there: the same
 * hook modes, the same akm calls, the detached children and the state files.
 */
export const itPosix: typeof it = IS_WINDOWS
  ? (Object.assign(
      (name: string, fn: () => unknown, timeout?: number) => it.skip(`${name} [skipped on Windows: POSIX sh fake akm, mode bits or sh wrapper]`, fn as never, timeout),
      { each: (table: unknown[]) => (name: string, fn: unknown) => it.skip.each(table)(`${name} [skipped on Windows: POSIX sh fake akm]`, fn as never) },
    ) as unknown as typeof it)
  : it

/**
 * An environment for a child process: the current one without anything `strip`
 * rejects, with `overrides` on top. Windows treats names case-insensitively
 * (`Path` is what the runner calls PATH), so an override replaces a differently
 * cased name there instead of sitting beside it.
 *
 * os.homedir() reads USERPROFILE on Windows and HOME elsewhere, so a HOME override
 * also sets USERPROFILE: a test that sandboxes HOME sandboxes the home directory.
 */
export function hostEnv(overrides: Record<string, string | undefined>, strip: (name: string) => boolean = () => false) {
  const fold = (name: string) => (IS_WINDOWS ? name.toLowerCase() : name)
  const withHome = IS_WINDOWS && overrides.HOME !== undefined && !("USERPROFILE" in overrides) ? { ...overrides, USERPROFILE: overrides.HOME } : overrides
  const replaced = new Set(Object.keys(withHome).map(fold))
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || strip(name) || replaced.has(fold(name))) continue
    env[name] = value
  }
  for (const [name, value] of Object.entries(withHome)) if (value !== undefined) env[name] = value
  return env
}

/**
 * A PATH holding only `binDir` plus what a hook needs to run: on POSIX /usr/bin and
 * /bin, on Windows the directory of this bun.exe and the system directories
 * (cmd.exe runs akm.cmd). Git for Windows is deliberately absent: `sh` is not
 * resolvable from it, which is what a machine without Git Bash looks like.
 */
export function sandboxPath(binDir: string) {
  return IS_WINDOWS
    ? [binDir, path.dirname(process.execPath), path.join(SYSTEM_ROOT, "System32"), SYSTEM_ROOT].join(";")
    : `${binDir}:/usr/bin:/bin`
}

/**
 * `<root>/<name>`, with `bun` reachable on sandboxPath() unless `withBun` is false (a symlink on POSIX; on Windows
 * bun.exe's own directory is on the path, so there is no way to leave bun out there).
 */
export function makeBinDir(root: string, name = "bin", withBun = true) {
  const binDir = path.join(root, name)
  mkdirSync(binDir, { recursive: true })
  if (withBun && !IS_WINDOWS && !existsSync(path.join(binDir, "bun"))) symlinkSync(process.execPath, path.join(binDir, "bun"))
  return binDir
}

/**
 * A fake akm whose behaviour is the JavaScript in `script` (its arguments are `args`), behind the launcher the platform
 * runs: an sh script on POSIX, akm.cmd on Windows. For a test that needs a response the repo's fake akm does not give.
 */
export function installScriptedAkm(binDir: string, script: string) {
  const scriptPath = path.join(binDir, "akm-scripted.mjs")
  writeFileSync(scriptPath, `const args = process.argv.slice(2)\n${script}`)
  if (IS_WINDOWS) {
    writeFileSync(path.join(binDir, "akm.cmd"), `@"${process.execPath}" "${scriptPath}" %*\r\n`)
  } else {
    writeFileSync(path.join(binDir, "akm"), `#!/usr/bin/env sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`)
    chmodSync(path.join(binDir, "akm"), 0o755)
  }
}

/** Resolve a program the way a spawn without a shell does: PATH order, PATHEXT on Windows, never a bare name there. */
export function whichOn(name: string, pathValue: string): string | undefined {
  const extensions = IS_WINDOWS ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""]
  for (const dir of pathValue.split(path.delimiter)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

export type ClaudeHandler = { type: string; command: string; args?: string[]; timeout?: number }

/** Run one exec-form handler of .claude-plugin/plugin.json as Claude Code does. */
export function runClaudeHandler(
  handler: ClaudeHandler,
  options: { pluginRoot: string; cwd: string; env: Record<string, string>; stdin: Blob | "ignore" },
) {
  if (!Array.isArray(handler.args)) throw new Error(`not exec form: ${JSON.stringify(handler)}`)
  const root = IS_WINDOWS ? options.pluginRoot.replaceAll("\\", "/") : options.pluginRoot
  const substitute = (value: string) => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", root)
  const command = substitute(handler.command)
  const program = whichOn(command, options.env.PATH ?? options.env.Path ?? "") ?? command
  const result = Bun.spawnSync([program, ...handler.args.map(substitute)], {
    cwd: options.cwd,
    env: { ...options.env, CLAUDE_PLUGIN_ROOT: root },
    stdio: [options.stdin, "pipe", "pipe"],
  })
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
}

export type CodexHandler = { type: string; command: string; commandWindows?: string; timeout?: number }
export type CodexShell = { name: string; run: (command: string, options: { cwd: string; env: Record<string, string>; stdin: Blob | "ignore" }) => { exitCode: number; stdout: string; stderr: string } }

/** The command Codex runs on this platform. */
export function codexEffectiveCommand(handler: CodexHandler, windows = IS_WINDOWS) {
  return windows ? (handler.commandWindows ?? handler.command) : handler.command
}

/** Codex's placeholder substitution: every environment variable it exports to a plugin hook, as ${NAME}. */
export function substituteCodexPlaceholders(command: string, values: { pluginRoot: string; pluginData: string }) {
  return command
    .replaceAll("${PLUGIN_ROOT}", values.pluginRoot)
    .replaceAll("${CLAUDE_PLUGIN_ROOT}", values.pluginRoot)
    .replaceAll("${PLUGIN_DATA}", values.pluginData)
    .replaceAll("${CLAUDE_PLUGIN_DATA}", values.pluginData)
}

function shellRunner(name: string, exe: string, argv: (command: string) => string[], verbatim = false): CodexShell {
  return {
    name,
    run(command, options) {
      const result = Bun.spawnSync([exe, ...argv(command)], {
        cwd: options.cwd,
        env: options.env,
        stdio: [options.stdin, "pipe", "pipe"],
        ...(verbatim ? { windowsVerbatimArguments: true } : {}),
      } as Parameters<typeof Bun.spawnSync>[1])
      return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }
    },
  }
}

/** Every shell Codex may run a hook command through on this OS, the one it prefers first. */
export function codexShells(): CodexShell[] {
  if (!IS_WINDOWS) return [shellRunner("sh -c", "sh", (command) => ["-c", command])]
  const shells: CodexShell[] = []
  const pwsh = Bun.which("pwsh")
  if (pwsh) shells.push(shellRunner("pwsh -NoProfile -Command", pwsh, (command) => ["-NoProfile", "-Command", command]))
  shells.push(
    shellRunner(
      "powershell.exe -NoProfile -Command",
      path.join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      (command) => ["-NoProfile", "-Command", command],
    ),
  )
  // codex-rs wraps the whole line in one more pair of quotes for `cmd /C`.
  shells.push(shellRunner("cmd.exe /C", process.env.COMSPEC ?? "cmd.exe", (command) => ["/C", `"${command}"`], true))
  return shells
}
