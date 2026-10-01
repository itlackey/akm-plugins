/**
 * How to start `akm` on Windows, where npm installs it as `akm.cmd`, and how to
 * stop it there.
 *
 * Starting it. A batch file cannot just be spawned. node:child_process refuses it
 * (EINVAL), and Bun's own spawn hands CreateProcess a command line that cmd.exe
 * then re-parses: a quoted argument beside an `akm.cmd` whose path holds a space
 * breaks it, and an argument holding `"%&|<>^` or a line break is rejected
 * outright (BatBadBut, CVE-2024-24576). Both are routine here, since the curate
 * query is the user's prompt and a profile directory can be `C:\Users\Jane Doe`.
 * spawnPlan() therefore runs a batch file through cmd.exe explicitly, as one
 * verbatim line that `/s` unwraps. Free text cannot be quoted safely for cmd.exe,
 * so those characters become spaces first; in a search query that costs nothing.
 * A path that is not a batch file, and every other platform, is returned untouched.
 *
 * Stopping it. akm.cmd is cmd.exe starting node starting bun, and a spawn's own
 * `timeout` kills only the process it started: cmd.exe, leaving the rest running.
 * (POSIX is fine: akm's launcher forwards the signal to its child.) runPlan()
 * therefore puts hooks/akm-run.ts between the hook and akm on Windows, which owns
 * the timeout and takes the whole process tree down with `taskkill /T /F`. The
 * same runner also keeps the output of a detached akm: a detached cmd.exe has no
 * console, so the programs it starts lose a redirect to a log file, and a child
 * that is not detached is killed when the process that started it exits.
 *
 * Zero third-party imports: the hook runs as a bare Bun script.
 */

import path from "node:path"
import { fileURLToPath } from "node:url"

export type SpawnPlan = {
  command: string
  args: string[]
  /** Set only for the cmd.exe line, which must reach cmd.exe exactly as built. */
  windowsVerbatimArguments?: true
}

const BATCH_FILE = /\.(?:cmd|bat)$/i
const CMD_UNSAFE = /["%&|<>^\r\n]/g

export function spawnPlan(command: string, args: readonly string[], platform: string = process.platform): SpawnPlan {
  if (platform !== "win32" || !BATCH_FILE.test(command)) return { command, args: [...args] }
  // A backslash before the closing quote would escape it for the program that
  // parses the line afterwards, so a trailing run of them is doubled.
  const quote = (value: string) => `"${value.replace(CMD_UNSAFE, " ").replace(/\\+$/, "$&$&")}"`
  return {
    command: process.env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", `"${[`"${command}"`, ...args.map(quote)].join(" ")}"`],
    windowsVerbatimArguments: true,
  }
}

/** The exit status akm-run.ts answers with when it had to take its akm down for running past its timeout (GNU timeout's). */
export const RUN_TIMED_OUT = 124

/** How long past its own timeout a spawn waits for the runner before it gives up on the runner too. */
const RUNNER_GRACE_MS = 5_000

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "akm-run.ts")

export type RunPlan = {
  command: string
  args: string[]
  /** What to hand the spawn's own `timeout` (0: none). On Windows the runner enforces the real limit, so this is only its backstop. */
  timeoutMs: number
  /** True when the plan goes through akm-run.ts, whose status RUN_TIMED_OUT means the timeout expired. */
  supervised: boolean
}

/**
 * The spawn that runs `command args` and gives up on it after `timeoutMs` (0 for no limit). On POSIX that is the
 * command itself with the spawn's own timeout, exactly as before; on Windows it is bun running akm-run.ts.
 */
export function runPlan(command: string, args: readonly string[], timeoutMs: number, platform: string = process.platform): RunPlan {
  if (platform !== "win32") return { command, args: [...args], timeoutMs, supervised: false }
  return {
    command: process.execPath,
    args: [RUNNER, String(timeoutMs), command, ...args],
    timeoutMs: timeoutMs > 0 ? timeoutMs + RUNNER_GRACE_MS : 0,
    supervised: true,
  }
}
