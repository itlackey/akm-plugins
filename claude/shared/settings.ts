/**
 * The plugins' settings: the `plugins` section of akm's own `config.json` (and
 * `improve.enabled` for background learning). One home, read by all four builds
 * (Claude, Codex, OpenCode 1 and 2) as a plain JSON file: no `akm` process, no
 * environment layer. A plugin finds the file the way akm does (`AKM_CONFIG_DIR`,
 * else `XDG_CONFIG_HOME/akm`, else `~/.config/akm`; Windows `APPDATA\akm`).
 *
 * A wrong value is ignored with a warning and the default is used, except for
 * redaction, which fails closed: a wrong `plugins.redact.*` value, a config file
 * that exists but cannot be read or parsed, or a retired `AKM_REDACT_*` variable
 * that has no config key behind it all leave that redaction ON. Only an
 * explicit `false` in the file turns it off. The two retired variables are the
 * only environment read left here, and they can only raise redaction.
 *
 * Zero third-party imports: the Claude hook runs as a bare Bun script.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export type RedactSettings = { pii: boolean; highEntropy: boolean }

export type PluginSettings = {
  autoFeedback: boolean
  indexOnSessionEnd: boolean
  /** Results injected per prompt, an integer from 1 to 25. */
  curateLimit: number
  curateTimeoutSeconds: number
  pendingProposalTimeoutSeconds: number
  redact: RedactSettings
  /** False when akm's `improve.enabled` is false: background learning is off on this host. */
  learning: boolean
}

export type LoadedSettings = {
  settings: PluginSettings
  /** One line each, for the session log and the SessionStart message. */
  warnings: string[]
}

export const SETTINGS_DEFAULTS: Readonly<Omit<PluginSettings, "redact" | "learning">> = {
  autoFeedback: true,
  indexOnSessionEnd: true,
  curateLimit: 5,
  curateTimeoutSeconds: 8,
  pendingProposalTimeoutSeconds: 2,
}

/** The environment variables that used to hold a setting. Retired: ignored, with a warning when set. */
const RETIRED_SETTING_ENV: ReadonlyArray<readonly [name: string, key: string]> = [
  ["AKM_AUTO_FEEDBACK", "plugins.autoFeedback"],
  ["AKM_INDEX_ON_SESSION_END", "plugins.indexOnSessionEnd"],
  ["AKM_CURATE_LIMIT", "plugins.curateLimit"],
  ["AKM_CURATE_TIMEOUT", "plugins.curateTimeoutSeconds"],
  ["AKM_PENDING_PROPOSAL_TIMEOUT", "plugins.pendingProposalTimeoutSeconds"],
]
const RETIRED_LEARNING_ENV = ["AKM_AUTO_LEARNING", "AKM_AUTO_MEMORY"] as const
/** Retired redaction variables: while the config key is absent they keep that redaction ON. */
const RETIRED_REDACT_ENV = { pii: "AKM_REDACT_PII", highEntropy: "AKM_REDACT_HIGH_ENTROPY" } as const

/** `config.json` the way akm finds it (core/paths.ts), without the `/tmp` bundle isolation rule. */
export function akmConfigPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.AKM_CONFIG_DIR?.trim()
  if (override) return path.join(override, "config.json")
  if (platform === "win32") {
    const appData = env.APPDATA?.trim()
    if (appData) return path.join(appData, "akm", "config.json")
    const profile = env.USERPROFILE?.trim() || homedir()
    return path.join(profile, "AppData", "Roaming", "akm", "config.json")
  }
  const xdg = env.XDG_CONFIG_HOME?.trim()
  if (xdg) return path.join(xdg, "akm", "config.json")
  return path.join(env.HOME?.trim() || homedir(), ".config", "akm", "config.json")
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** What reading the file found: the parsed root, no file at all, or a file that cannot be used. */
export type ConfigRead = { kind: "ok"; root: unknown } | { kind: "missing" } | { kind: "unusable"; reason: string }

export function readAkmConfig(file: string): ConfigRead {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" }
    return { kind: "unusable", reason: `cannot be read (${code ?? "error"})` }
  }
  try {
    return { kind: "ok", root: JSON.parse(text.replace(/^﻿/, "")) }
  } catch {
    return { kind: "unusable", reason: "is not valid JSON" }
  }
}

const SET_REDACT = (name: string, key: string) => `${name} is retired: set ${key} in akm's config.json.`

/**
 * Settings from an already-read config. Pure apart from the `env` it is given,
 * so the whole decision table is testable without a file.
 */
export function resolveSettings(read: ConfigRead, env: NodeJS.ProcessEnv = process.env, file = "config.json"): LoadedSettings {
  const warnings: string[] = []
  const settings: PluginSettings = { ...SETTINGS_DEFAULTS, redact: { pii: false, highEntropy: false }, learning: true }
  // A file that exists and cannot be used: defaults everywhere, redaction on.
  let failClosed = false
  let plugins: Record<string, unknown> = {}

  if (read.kind === "unusable") {
    failClosed = true
    warnings.push(`akm config ${file} ${read.reason}: plugin settings use their defaults and redaction stays on.`)
  } else if (read.kind === "ok") {
    if (!isRecord(read.root)) {
      failClosed = true
      warnings.push(`akm config ${file} is not a JSON object: plugin settings use their defaults and redaction stays on.`)
    } else {
      const improve = read.root.improve
      if (isRecord(improve) && improve.enabled === false) settings.learning = false
      const section = read.root.plugins
      if (section !== undefined) {
        if (isRecord(section)) plugins = section
        else {
          failClosed = true
          warnings.push(`"plugins" in ${file} is not an object: plugin settings use their defaults and redaction stays on.`)
        }
      }
    }
  }

  const bool = (key: "autoFeedback" | "indexOnSessionEnd") => {
    const value = plugins[key]
    if (value === undefined) return
    if (typeof value === "boolean") settings[key] = value
    else warnings.push(`plugins.${key} must be true or false: using ${SETTINGS_DEFAULTS[key]}.`)
  }
  bool("autoFeedback")
  bool("indexOnSessionEnd")

  const limit = plugins.curateLimit
  if (limit !== undefined) {
    if (typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= 25) settings.curateLimit = limit
    else warnings.push(`plugins.curateLimit must be a whole number from 1 to 25: using ${SETTINGS_DEFAULTS.curateLimit}.`)
  }
  for (const key of ["curateTimeoutSeconds", "pendingProposalTimeoutSeconds"] as const) {
    const value = plugins[key]
    if (value === undefined) continue
    if (typeof value === "number" && Number.isFinite(value) && value > 0) settings[key] = value
    else warnings.push(`plugins.${key} must be a number above 0: using ${SETTINGS_DEFAULTS[key]}.`)
  }

  // Redaction. An explicit boolean wins; anything else that is not "key absent and no retired variable" is ON.
  const redactRaw = plugins.redact
  const redactBad = redactRaw !== undefined && !isRecord(redactRaw)
  if (redactBad) warnings.push(`plugins.redact must be an object with pii and highEntropy: redaction stays on.`)
  const redact = isRecord(redactRaw) ? redactRaw : {}
  for (const key of ["pii", "highEntropy"] as const) {
    const value = redact[key]
    const retired = RETIRED_REDACT_ENV[key]
    const retiredSet = env[retired] !== undefined
    const configKey = `plugins.redact.${key}`
    if (typeof value === "boolean") {
      settings.redact[key] = value
      if (retiredSet) warnings.push(`${retired} is retired and ignored: ${configKey} in config.json (${value}) decides.`)
    } else if (value !== undefined) {
      settings.redact[key] = true
      warnings.push(`${configKey} must be true or false: redaction stays on.`)
    } else if (retiredSet) {
      settings.redact[key] = true
      warnings.push(`${SET_REDACT(retired, configKey)} Redaction is on for now.`)
    } else {
      settings.redact[key] = failClosed || redactBad
    }
  }

  for (const [name, key] of RETIRED_SETTING_ENV) {
    if (env[name] !== undefined) warnings.push(`${name} is retired and ignored: set ${key} in akm's config.json.`)
  }
  for (const name of RETIRED_LEARNING_ENV) {
    if (env[name] !== undefined) warnings.push(`${name} is retired and ignored: to stop background learning run: akm setup --learning off`)
  }
  return { settings, warnings }
}

/** Reads the config akm would read and resolves the settings from it. */
export function loadSettings(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): LoadedSettings {
  const file = akmConfigPath(env, platform)
  return resolveSettings(readAkmConfig(file), env, file)
}
