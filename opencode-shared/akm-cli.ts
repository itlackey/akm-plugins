// The ONE place the OpenCode plugins (V1 `akm-opencode`, V2 `akm-opencode-v2`)
// turn "run an akm verb" into a subprocess and the subprocess's JSON back into a
// result. Both plugins call the public `akm` CLI; neither deep-imports akm-cli
// internals. The CLI is the declared `akm-cli` dependency of the calling
// package, resolved the way any package invokes a dependency's executable.
//
// No console/stdout/stderr output here: every failure comes back as a value and
// the caller logs it through its host's logging channel.
import { execFile, execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import path from "node:path"

export type CliError = { ok: false; error: string }

export type ResolvedAkmCommand = {
  command: string
  argsPrefix: string[]
  displayCommand: string
}

export function isCliError(value: unknown): value is CliError {
  return !!value && typeof value === "object" && (value as { ok?: unknown }).ok === false
    && typeof (value as { error?: unknown }).error === "string"
}

export function formatCliError(error: unknown, packageName = "akm-opencode"): string {
  if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
    return `The akm-cli dependency could not be executed. Reinstall the ${packageName} plugin so the package manager installs it.`
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * `akm-cli` is a declared dependency of the calling package, so the package
 * manager has already installed the exact tested version alongside it and
 * created its `bin` entry. `moduleUrl` is the caller's `import.meta.url`:
 * resolution must start from the plugin package, not from this shared file.
 *
 * `AKM_OPENCODE_CLI` is the one seam: an explicit absolute path to an akm
 * executable, exec'd as-is (the eval harness points it at its deterministic
 * shim). It is not discovery — nothing is searched for.
 */
export function resolveAkmCommand(moduleUrl: string, packageName = "akm-opencode"): ResolvedAkmCommand | CliError {
  const override = process.env.AKM_OPENCODE_CLI?.trim()
  if (override) return { command: override, argsPrefix: [], displayCommand: override }
  try {
    const manifestPath = createRequire(moduleUrl).resolve("akm-cli/package.json")
    const bin = JSON.parse(readFileSync(manifestPath, "utf8")).bin
    const relative = typeof bin === "string" ? bin : bin?.akm
    if (!relative) throw new Error("akm-cli declares no 'akm' bin")
    const command = path.resolve(path.dirname(manifestPath), relative)
    return { command, argsPrefix: [], displayCommand: command }
  } catch (error) {
    return {
      ok: false,
      error: `The 'akm-cli' dependency could not be resolved (${error instanceof Error ? error.message : String(error)}). Reinstall the ${packageName} plugin so the package manager installs it.`,
    }
  }
}

export type ExecResolvedAkmOptions = Omit<NonNullable<Parameters<typeof execFileSync>[2]>, "encoding"> & {
  encoding: "utf8"
}

export function execResolvedAkm(command: ResolvedAkmCommand, args: string[], options: ExecResolvedAkmOptions): string {
  return execFileSync(command.command, [...command.argsPrefix, ...args], options) as string
}

export type AkmRunResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string; exitCode: number | null; stdout: string; stderr: string }

export type AkmRunOptions = {
  timeoutMs?: number
  cwd?: string
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  packageName?: string
}

/** Asynchronous akm invocation. Never rejects: failure is a value. */
export function runAkm(command: ResolvedAkmCommand, args: string[], options: AkmRunOptions = {}): Promise<AkmRunResult> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        command.command,
        [...command.argsPrefix, ...args],
        {
          encoding: "utf8",
          timeout: options.timeoutMs,
          cwd: options.cwd,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          signal: options.signal,
          maxBuffer: 64 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ ok: true, stdout: String(stdout ?? "") })
            return
          }
          const status = (error as { code?: unknown }).code
          resolve({
            ok: false,
            error: stderrMessage(String(stderr ?? "")) ?? formatCliError(error, options.packageName),
            exitCode: typeof status === "number" ? status : null,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
          })
        },
      )
      // No verb here reads stdin; close it so one that tries cannot hang on an open pipe.
      child?.stdin?.end()
    } catch (error) {
      resolve({ ok: false, error: formatCliError(error, options.packageName), exitCode: null, stdout: "", stderr: "" })
    }
  })
}

// akm prints failures as `{ok:false, error, code}` on stderr; surface the
// `error` text instead of the whole envelope when it parses.
function stderrMessage(stderr: string): string | undefined {
  const trimmed = stderr.trim()
  if (!trimmed) return undefined
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown }
    if (typeof parsed.error === "string" && parsed.error) return parsed.error
  } catch {
    // not JSON: fall through to the raw text
  }
  return trimmed.slice(0, 2_000)
}

// --- the read verbs: search / show / curate ---------------------------------

export type ReadOperation = "search" | "show" | "curate"

/**
 * Build the argv for the three read verbs from the plugin tool arguments.
 * Every verb is asked for `--format json`. `search` asks for `--detail full`
 * so a hit carries `description`/`tags` exactly as the in-process library
 * return did; `show` maps its `detail` (brief|normal|full, or `summary`, which
 * akm 0.10 folds into `--detail brief`).
 */
export function buildReadArgs(operation: ReadOperation, input: Record<string, unknown>): string[] {
  const str = (key: string): string | undefined => {
    const value = input[key]
    return typeof value === "string" && value.length > 0 ? value : undefined
  }
  const num = (key: string): number | undefined => {
    const value = input[key]
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
  }
  const args: string[] = []
  if (operation === "search") {
    args.push("search", str("query") ?? "")
    const type = str("type")
    if (type) args.push("--type", type)
    const limit = num("limit")
    if (limit !== undefined) args.push("--limit", String(limit))
    const source = str("source")
    if (source) args.push("--from", source)
    if (input.includeProposed === true) args.push("--include-proposed")
    args.push("--detail", "full")
  } else if (operation === "show") {
    const ref = str("ref")
    if (!ref) throw new Error("ref is required")
    // A ref is never a flag; refuse one that would be read as one.
    if (ref.startsWith("-")) throw new Error("ref must not start with '-'")
    args.push("show", ref)
    const detail = str("detail")
    if (detail === "summary") args.push("--detail", "brief")
    else if (detail) args.push("--detail", detail)
  } else {
    const query = str("query")
    if (!query) throw new Error("query is required")
    const pack = input.pack
    if (pack !== undefined && (typeof pack !== "number" || !Number.isInteger(pack) || pack <= 0)) {
      throw new Error("pack must be a positive integer token budget")
    }
    args.push("curate", query)
    const type = str("type")
    if (type) args.push("--type", type)
    const limit = num("limit")
    if (limit !== undefined) args.push("--limit", String(limit))
    const source = str("source")
    if (source) args.push("--from", source)
    if (typeof pack === "number") args.push("--pack", String(pack))
  }
  args.push("--format", "json")
  return args
}

export type ReadResult = { ok: true; output: string; value: unknown } | { ok: false; error: string; exitCode: number | null }

/**
 * Run search|show|curate through the public CLI and return the JSON text the
 * tool hands to the model. A missing CLI, a non-zero exit, or output that is
 * not JSON all come back as `{ok:false}`, never as a throw.
 */
export async function runReadVerb(
  command: ResolvedAkmCommand,
  operation: ReadOperation,
  input: Record<string, unknown>,
  options: AkmRunOptions = {},
): Promise<ReadResult> {
  let args: string[]
  try {
    args = buildReadArgs(operation, input)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), exitCode: null }
  }
  const result = await runAkm(command, args, options)
  if (!result.ok) return { ok: false, error: result.error, exitCode: result.exitCode }
  try {
    const value = JSON.parse(result.stdout)
    return { ok: true, output: JSON.stringify(value), value }
  } catch {
    return { ok: false, error: "akm returned output that is not JSON", exitCode: 0 }
  }
}

/** Tool-facing form of {@link runReadVerb}: always a JSON string. */
export async function readVerbToolOutput(
  command: ResolvedAkmCommand | CliError,
  operation: ReadOperation,
  input: Record<string, unknown>,
  options: AkmRunOptions = {},
): Promise<{ output: string; ok: boolean; error?: string }> {
  if (isCliError(command)) return { output: JSON.stringify(command), ok: false, error: command.error }
  const result = await runReadVerb(command, operation, input, options)
  if (result.ok) return { output: result.output, ok: true }
  return { output: JSON.stringify({ ok: false, error: result.error }), ok: false, error: result.error }
}
