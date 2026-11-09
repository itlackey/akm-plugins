import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { learningOptedOut, noteRetiredLearningEnv, parseLearningOn, syncLearningSwitch } from "../claude/shared/learning-switch"

const KEYS = ["CLAUDE_PLUGIN_OPTION_AUTO_LEARNING"]
const saved: Record<string, string | undefined> = {}
let stateDir = ""

beforeEach(() => {
  for (const key of KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
  stateDir = mkdtempSync(path.join(tmpdir(), "learning-switch-"))
})
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
  rmSync(stateDir, { recursive: true, force: true })
})

const marker = () => path.join(stateDir, "learning-off-by-plugin")

/** A fake akm: `info` reports `on` (or no `learning` at all), `setup --learning` succeeds or fails. */
function fakeRun(on: boolean | undefined, options: { setupFails?: boolean } = {}) {
  const calls: string[] = []
  const logs: string[] = []
  const run = async (args: string[]) => {
    calls.push(args.slice(0, 3).join(" "))
    if (args[0] === "info") return JSON.stringify(on === undefined ? { ok: true } : { ok: true, learning: { on, harness: null, scheduled: false } })
    if (options.setupFails) return ""
    on = args[2] === "on"
    return JSON.stringify({ learning: { on, harness: null, scheduled: false } })
  }
  return { run, calls, logs, log: (message: string) => logs.push(message), state: () => on }
}
const sync = (fake: ReturnType<typeof fakeRun>) => syncLearningSwitch({ run: fake.run, stateDir, log: fake.log })

describe("learningOptedOut", () => {
  it("is on only for an off auto_learning option", () => {
    expect(learningOptedOut({})).toBe(false)
    for (const value of ["0", "false", "off", "no", "FALSE"]) expect(learningOptedOut({ CLAUDE_PLUGIN_OPTION_AUTO_LEARNING: value })).toBe(true)
    expect(learningOptedOut({ CLAUDE_PLUGIN_OPTION_AUTO_LEARNING: "true" })).toBe(false)
  })
})

describe("noteRetiredLearningEnv", () => {
  it("logs one line when a retired variable is 0, and nothing otherwise", () => {
    const logs: string[] = []
    noteRetiredLearningEnv((message) => logs.push(message), {})
    noteRetiredLearningEnv((message) => logs.push(message), { AKM_AUTO_LEARNING: "1", AKM_AUTO_MEMORY: "false" })
    expect(logs).toEqual([])
    noteRetiredLearningEnv((message) => logs.push(message), { AKM_AUTO_MEMORY: "0" })
    noteRetiredLearningEnv((message) => logs.push(message), { AKM_AUTO_LEARNING: "0" })
    expect(logs).toEqual(Array(2).fill("AKM_AUTO_MEMORY and AKM_AUTO_LEARNING no longer do anything; to stop background learning run: akm setup --learning off"))
  })
})

describe("parseLearningOn", () => {
  it("reads learning.on and is undefined when akm does not report it", () => {
    expect(parseLearningOn('{"learning":{"on":true}}')).toBe(true)
    expect(parseLearningOn('{"learning":{"on":false}}')).toBe(false)
    expect(parseLearningOn('{"ok":true}')).toBeUndefined()
    expect(parseLearningOn("not json")).toBeUndefined()
  })
})

describe("syncLearningSwitch", () => {
  it("opted out and learning on: turns it off and records the marker", async () => {
    process.env.CLAUDE_PLUGIN_OPTION_AUTO_LEARNING = "0"
    const fake = fakeRun(true)
    await sync(fake)
    expect(fake.calls).toEqual(["info --format json", "setup --learning off"])
    expect(fake.state()).toBe(false)
    expect(existsSync(marker())).toBe(true)
    expect(fake.logs).toEqual(["AKM learning turned off: the plugin's auto_learning option is off"])
  })

  it("opted out and learning already off: does nothing and leaves no marker", async () => {
    process.env.CLAUDE_PLUGIN_OPTION_AUTO_LEARNING = "false"
    const fake = fakeRun(false)
    await sync(fake)
    expect(fake.calls).toEqual(["info --format json"])
    expect(existsSync(marker())).toBe(false)
  })

  it("a failed `setup --learning off` writes no marker, logs, and the opt-out still gates", async () => {
    process.env.CLAUDE_PLUGIN_OPTION_AUTO_LEARNING = "0"
    const fake = fakeRun(true, { setupFails: true })
    await sync(fake)
    expect(existsSync(marker())).toBe(false)
    expect(fake.logs).toHaveLength(1)
    expect(fake.state()).toBe(true)
    expect(learningOptedOut()).toBe(true)
  })

  it("no opt-out and a marker, learning off: turns it back on and removes the marker", async () => {
    process.env.CLAUDE_PLUGIN_OPTION_AUTO_LEARNING = "0"
    await sync(fakeRun(true))
    delete process.env.CLAUDE_PLUGIN_OPTION_AUTO_LEARNING
    const fake = fakeRun(false)
    await sync(fake)
    expect(fake.calls).toEqual(["info --format json", "setup --learning on"])
    expect(fake.state()).toBe(true)
    expect(existsSync(marker())).toBe(false)
    expect(fake.logs).toEqual(["AKM learning turned back on: the plugin's auto_learning option is on again"])
  })

  it("no opt-out and a marker, learning already on: only removes the marker", async () => {
    process.env.CLAUDE_PLUGIN_OPTION_AUTO_LEARNING = "0"
    await sync(fakeRun(true))
    delete process.env.CLAUDE_PLUGIN_OPTION_AUTO_LEARNING
    const fake = fakeRun(true)
    await sync(fake)
    expect(fake.calls).toEqual(["info --format json"])
    expect(existsSync(marker())).toBe(false)
  })

  it("a failed `setup --learning on` keeps the marker for the next session", async () => {
    process.env.CLAUDE_PLUGIN_OPTION_AUTO_LEARNING = "0"
    await sync(fakeRun(true))
    delete process.env.CLAUDE_PLUGIN_OPTION_AUTO_LEARNING
    const fake = fakeRun(false, { setupFails: true })
    await sync(fake)
    expect(existsSync(marker())).toBe(true)
    expect(fake.logs).toHaveLength(1)
  })

  it("no opt-out and no marker: runs nothing at all, never turning learning on", async () => {
    const fake = fakeRun(false)
    await sync(fake)
    expect(fake.calls).toEqual([])
    expect(fake.state()).toBe(false)
  })

  it("learning absent from `akm info` (an older akm): does nothing, opted out or not", async () => {
    process.env.CLAUDE_PLUGIN_OPTION_AUTO_LEARNING = "0"
    const fake = fakeRun(undefined)
    await sync(fake)
    expect(fake.calls).toEqual(["info --format json"])
    expect(existsSync(marker())).toBe(false)
  })
})
