/**
 * How to start `akm` on Windows, where npm installs it as `akm.cmd`.
 *
 * A batch file cannot just be spawned there. node:child_process refuses it
 * (EINVAL), and Bun's own spawn hands CreateProcess a command line that cmd.exe
 * then re-parses: a quoted argument beside an `akm.cmd` whose path holds a space
 * breaks it, and an argument holding `"%&|<>^` or a line break is rejected
 * outright (BatBadBut, CVE-2024-24576). Both are routine here, since the curate
 * query is the user's prompt and a profile directory can be `C:\Users\Jane Doe`.
 *
 * So the batch file is run through cmd.exe explicitly, as one verbatim line that
 * `/s` unwraps. Free text cannot be quoted safely for cmd.exe, so those
 * characters become spaces first; in a search query that costs nothing. A path
 * that is not a batch file, and every other platform, is returned untouched.
 *
 * Zero third-party imports: the hook runs as a bare Bun script.
 */

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
