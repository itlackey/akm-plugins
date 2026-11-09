/**
 * The plugins' learning settings, mapped onto akm's own learning switch
 * (`akm setup --learning on|off`). One implementation for the Claude/Codex hook
 * and both OpenCode plugins; the host supplies `run`, which invokes the public
 * `akm` CLI and returns its stdout ("" when the call failed).
 *
 * Zero third-party imports: the Claude hook runs as a bare Bun script.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const OFF_VALUES = new Set(["0", "false", "off", "no"])

/** True when the Claude `auto_learning` option (`CLAUDE_PLUGIN_OPTION_AUTO_LEARNING`) is off. */
export function learningOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
  const option = env.CLAUDE_PLUGIN_OPTION_AUTO_LEARNING?.trim().toLowerCase()
  return option !== undefined && OFF_VALUES.has(option)
}

/** Warn-and-ignore notice for the two retired environment opt-outs. */
export function noteRetiredLearningEnv(log: (message: string) => void, env: NodeJS.ProcessEnv = process.env): void {
  if (env.AKM_AUTO_MEMORY === "0" || env.AKM_AUTO_LEARNING === "0") {
    log("AKM_AUTO_MEMORY and AKM_AUTO_LEARNING no longer do anything; to stop background learning run: akm setup --learning off")
  }
}

/** `learning.on` from `akm info` JSON, or undefined when akm does not report it (an older akm). */
export function parseLearningOn(raw: string): boolean | undefined {
  try {
    const on = (JSON.parse(raw) as { learning?: { on?: unknown } } | null)?.learning?.on
    return typeof on === "boolean" ? on : undefined
  } catch {
    return undefined
  }
}

const MARKER = "learning-off-by-plugin"

export type LearningSwitchHost = {
  /** Runs `akm <args>` and returns its stdout, "" on failure. */
  run: (args: string[]) => Promise<string>
  /** The plugin's state directory: where the marker lives. */
  stateDir: string
  log: (message: string) => void
}

/**
 * Called once at session start. The marker records that the plugin, not the person, turned
 * learning off, so only the plugin's own change is ever undone. Nothing happens when akm does not
 * report `learning`, and `--learning on` is never run without the marker.
 */
export async function syncLearningSwitch(host: LearningSwitchHost): Promise<void> {
  const marker = path.join(host.stateDir, MARKER)
  const optedOut = learningOptedOut()
  const marked = existsSync(marker)
  if (!optedOut && !marked) return
  const on = parseLearningOn(await host.run(["info", "--format", "json", "-q"]))
  if (on === undefined) return
  try {
    if (optedOut) {
      if (!on) return
      if (!(await host.run(["setup", "--learning", "off", "--format", "json", "-q"]))) {
        host.log("AKM learning opt-out could not be applied: `akm setup --learning off` failed; it will be retried next session")
        return
      }
      mkdirSync(host.stateDir, { recursive: true })
      writeFileSync(marker, "")
      host.log("AKM learning turned off: the plugin's auto_learning option is off")
      return
    }
    if (!on) {
      if (!(await host.run(["setup", "--learning", "on", "--format", "json", "-q"]))) {
        host.log("AKM learning could not be turned back on: `akm setup --learning on` failed; it will be retried next session")
        return
      }
      host.log("AKM learning turned back on: the plugin's auto_learning option is on again")
    }
    rmSync(marker, { force: true })
  } catch (error: unknown) {
    host.log(`AKM learning switch sync failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
