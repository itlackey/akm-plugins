import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { akmConfigPath, loadSettings, readAkmConfig, resolveSettings, SETTINGS_DEFAULTS, type ConfigRead } from "../claude/shared/settings"

const ok = (root: unknown): ConfigRead => ({ kind: "ok", root })
const plugins = (value: unknown): ConfigRead => ok({ plugins: value })

describe("akmConfigPath: the file akm reads", () => {
  test("AKM_CONFIG_FILE wins, trimmed and resolved", () => {
    expect(akmConfigPath({ AKM_CONFIG_FILE: " /etc/akm/other.json ", AKM_CONFIG_DIR: "/d", XDG_CONFIG_HOME: "/x", HOME: "/h" }, "linux")).toBe("/etc/akm/other.json")
    expect(akmConfigPath({ AKM_CONFIG_FILE: "rel/cfg.json", HOME: "/h" }, "linux")).toBe(path.resolve("rel/cfg.json"))
    expect(akmConfigPath({ AKM_CONFIG_FILE: "  ", AKM_CONFIG_DIR: "/d" }, "linux")).toBe(path.join("/d", "config.json"))
  })
  test("then AKM_CONFIG_DIR", () => {
    expect(akmConfigPath({ AKM_CONFIG_DIR: "/etc/akm", XDG_CONFIG_HOME: "/x", HOME: "/h" }, "linux")).toBe(path.join("/etc/akm", "config.json"))
  })
  test("then XDG_CONFIG_HOME/akm, then ~/.config/akm", () => {
    expect(akmConfigPath({ XDG_CONFIG_HOME: "/x", HOME: "/h" }, "linux")).toBe(path.join("/x", "akm", "config.json"))
    expect(akmConfigPath({ HOME: "/h" }, "linux")).toBe(path.join("/h", ".config", "akm", "config.json"))
  })
  test("Windows: APPDATA\\akm, else the roaming profile folder", () => {
    expect(akmConfigPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32")).toBe(path.join("C:\\Users\\me\\AppData\\Roaming", "akm", "config.json"))
    expect(akmConfigPath({ USERPROFILE: "C:\\Users\\me" }, "win32")).toBe(path.join("C:\\Users\\me", "AppData", "Roaming", "akm", "config.json"))
  })
})

describe("the seven keys", () => {
  test("no file, or no plugins section: the defaults, redaction off, learning on, no warning", () => {
    for (const read of [{ kind: "missing" } as ConfigRead, ok({}), ok({ other: 1 })]) {
      const { settings, warnings } = resolveSettings(read, {})
      expect(settings).toEqual({ ...SETTINGS_DEFAULTS, redact: { pii: false, highEntropy: false }, learning: true })
      expect(warnings).toEqual([])
    }
  })

  test("each key is read", () => {
    const { settings, warnings } = resolveSettings(
      plugins({ autoFeedback: false, indexOnSessionEnd: false, curateLimit: 9, curateTimeoutSeconds: 15.5, pendingProposalTimeoutSeconds: 4, redact: { pii: true, highEntropy: false } }),
      {},
    )
    expect(settings).toEqual({
      autoFeedback: false,
      indexOnSessionEnd: false,
      curateLimit: 9,
      curateTimeoutSeconds: 15.5,
      pendingProposalTimeoutSeconds: 4,
      redact: { pii: true, highEntropy: false },
      learning: true,
    })
    expect(warnings).toEqual([])
  })

  test.each([
    ["autoFeedback", "no", "autoFeedback"],
    ["autoFeedback", 0, "autoFeedback"],
    ["indexOnSessionEnd", "false", "indexOnSessionEnd"],
    ["curateLimit", 0, "curateLimit"],
    ["curateLimit", 26, "curateLimit"],
    ["curateLimit", 2.5, "curateLimit"],
    ["curateLimit", "5", "curateLimit"],
    ["curateTimeoutSeconds", 0, "curateTimeoutSeconds"],
    ["curateTimeoutSeconds", -3, "curateTimeoutSeconds"],
    ["curateTimeoutSeconds", "8", "curateTimeoutSeconds"],
    ["pendingProposalTimeoutSeconds", null, "pendingProposalTimeoutSeconds"],
  ])("a bad %s (%p): that key takes its default, the others are kept, one warning names it", (key, value, named) => {
    const { settings, warnings } = resolveSettings(plugins({ [key]: value, curateLimit: key === "curateLimit" ? value : 7 }), {})
    expect((settings as Record<string, unknown>)[key]).toBe((SETTINGS_DEFAULTS as Record<string, unknown>)[key])
    if (key !== "curateLimit") expect(settings.curateLimit).toBe(7)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`plugins.${named}`)
  })

  test("the learning switch is akm's improve.enabled: only an explicit false turns it off", () => {
    expect(resolveSettings(ok({ improve: { enabled: false } }), {}).settings.learning).toBe(false)
    for (const improve of [{}, { enabled: true }, { enabled: "no" }, "off", null]) {
      expect(resolveSettings(ok({ improve }), {}).settings.learning).toBe(true)
    }
  })

  test("a bad value in the plugins section never raises or lowers redaction", () => {
    const { settings } = resolveSettings(plugins({ curateLimit: "x" }), {})
    expect(settings.redact).toEqual({ pii: false, highEntropy: false })
  })
})

describe("redaction cannot silently turn off", () => {
  const ENV_VALUES: Array<[label: string, env: Record<string, string>]> = [
    ["env unset", {}],
    ["env set 1", { V: "1" }],
    ["env set 0", { V: "0" }],
    ["env set empty", { V: "" }],
  ]
  const CONFIG_VALUES: Array<[label: string, config: Record<string, unknown>, expected: (envSet: boolean) => boolean, warns: (envSet: boolean) => boolean]> = [
    ["config key absent", {}, (envSet) => envSet, (envSet) => envSet],
    ["config true", { K: true }, () => true, (envSet) => envSet],
    ["config false", { K: false }, () => false, (envSet) => envSet],
    ["config string", { K: "true" }, () => true, () => true],
    ["config number 1", { K: 1 }, () => true, () => true],
    ["config null", { K: null }, () => true, () => true],
  ]
  for (const [key, name] of [
    ["pii", "AKM_REDACT_PII"],
    ["highEntropy", "AKM_REDACT_HIGH_ENTROPY"],
  ] as const) {
    for (const [configLabel, config, expected, warns] of CONFIG_VALUES) {
      for (const [envLabel, envTemplate] of ENV_VALUES) {
        test(`${key}: ${configLabel}, ${envLabel}`, () => {
          const envSet = "V" in envTemplate
          const env = envSet ? { [name]: envTemplate.V as string } : {}
          const redact = Object.fromEntries(Object.entries(config).map(([, value]) => [key, value]))
          const { settings, warnings } = resolveSettings(plugins({ redact }), env)
          expect(settings.redact[key]).toBe(expected(envSet))
          // The other redaction is untouched by this one.
          expect(settings.redact[key === "pii" ? "highEntropy" : "pii"]).toBe(false)
          const named = warnings.filter((line) => line.includes(name) || line.includes(`plugins.redact.${key}`))
          expect(named.length > 0).toBe(warns(envSet))
        })
      }
    }
  }

  test("a retired variable with no config key warns once per variable, names the key, and keeps redaction on", () => {
    const { settings, warnings } = resolveSettings(ok({}), { AKM_REDACT_PII: "0", AKM_REDACT_HIGH_ENTROPY: "1" })
    expect(settings.redact).toEqual({ pii: true, highEntropy: true })
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain("plugins.redact.pii")
    expect(warnings[1]).toContain("plugins.redact.highEntropy")
  })

  test("an explicit false in config wins over the retired variable, and the warning says so", () => {
    const { settings, warnings } = resolveSettings(plugins({ redact: { pii: false } }), { AKM_REDACT_PII: "1" })
    expect(settings.redact.pii).toBe(false)
    expect(warnings.join("\n")).toMatch(/AKM_REDACT_PII is retired and ignored.*false/)
  })

  test("a config that is not usable keeps both redactions on and defaults the rest", () => {
    for (const read of [
      { kind: "unusable", reason: "is not valid JSON" } as ConfigRead,
      ok([1, 2]),
      ok("text"),
      ok(null),
      plugins("on"),
      plugins([]),
      plugins({ redact: true }),
      plugins({ redact: "on" }),
    ]) {
      const { settings, warnings } = resolveSettings(read, {})
      expect(settings.redact).toEqual({ pii: true, highEntropy: true })
      expect(settings.curateLimit).toBe(SETTINGS_DEFAULTS.curateLimit)
      expect(warnings.length).toBeGreaterThan(0)
    }
  })

  test("an explicit false still wins inside a redact object next to a bad sibling", () => {
    const { settings } = resolveSettings(plugins({ redact: { pii: false, highEntropy: "yes" } }), {})
    expect(settings.redact).toEqual({ pii: false, highEntropy: true })
  })
})

describe("retired names", () => {
  test("each retired setting name warns and is ignored; learning names point to akm setup --learning", () => {
    const env = {
      AKM_AUTO_FEEDBACK: "0",
      AKM_INDEX_ON_SESSION_END: "0",
      AKM_CURATE_LIMIT: "9",
      AKM_CURATE_TIMEOUT: "30",
      AKM_PENDING_PROPOSAL_TIMEOUT: "9",
      AKM_AUTO_LEARNING: "0",
      AKM_AUTO_MEMORY: "0",
    }
    const { settings, warnings } = resolveSettings(ok({}), env)
    expect(settings).toEqual({ ...SETTINGS_DEFAULTS, redact: { pii: false, highEntropy: false }, learning: true })
    expect(warnings).toHaveLength(7)
    for (const name of Object.keys(env)) expect(warnings.filter((line) => line.startsWith(name))).toHaveLength(1)
    expect(warnings.filter((line) => line.includes("akm setup --learning off"))).toHaveLength(2)
  })

  test("a name that was never a setting is not mentioned", () => {
    expect(resolveSettings(ok({}), { AKM_CURATE_MIN_SCORE: "0", AKM_WRITE_GATE: "off", AKM_AUTO_CURATE: "0" }).warnings).toEqual([])
  })
})

describe("loadSettings reads the real file", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "akm-settings-"))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const env = () => ({ AKM_CONFIG_DIR: dir })

  test("a missing file is the defaults with no warning", () => {
    expect(readAkmConfig(path.join(dir, "config.json"))).toEqual({ kind: "missing" })
    const loaded = loadSettings(env())
    expect(loaded.warnings).toEqual([])
    expect(loaded.settings.redact).toEqual({ pii: false, highEntropy: false })
  })

  test("a file is parsed (a byte-order mark is tolerated)", () => {
    writeFileSync(path.join(dir, "config.json"), `\uFEFF${JSON.stringify({ plugins: { curateLimit: 3, redact: { pii: true } }, improve: { enabled: false } })}`)
    const { settings, warnings } = loadSettings(env())
    expect(settings.curateLimit).toBe(3)
    expect(settings.redact.pii).toBe(true)
    expect(settings.learning).toBe(false)
    expect(warnings).toEqual([])
  })

  test("malformed JSON: defaults, redaction on, one warning", () => {
    writeFileSync(path.join(dir, "config.json"), "{ not json")
    const { settings, warnings } = loadSettings(env())
    expect(settings.redact).toEqual({ pii: true, highEntropy: true })
    expect(settings.curateLimit).toBe(5)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("not valid JSON")
  })

  test("a config.json that is a directory is unreadable, not missing: redaction on", () => {
    mkdirSync(path.join(dir, "config.json"))
    expect(loadSettings(env()).settings.redact).toEqual({ pii: true, highEntropy: true })
  })
})
