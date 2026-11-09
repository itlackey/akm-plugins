import { describe, expect, it } from "bun:test"
import { akmResultList } from "../claude/shared/result-list"
import { classifyToolFeedback } from "../opencode-shared/feedback"
import { withProposedWarnings } from "../opencode-shared/tools"
import { refsOfAkmResult } from "../claude/shared/ref-extraction"
import { loadSessionBootstrap } from "../claude/shared/session-bootstrap"

// akm names the list of a search or curate response `results`. Older akm used `hits` (search) and
// `items` (curate); akm 0.10.261111 emits `results` beside them. Every plugin read of that list takes
// `results`, then `hits`, then `items`, so one plugin release works with older and newer akm.

const KEYS = ["results", "hits", "items"] as const
const entry = { ref: "skills/deploy", type: "skill", name: "deploy", description: "Deploy things", score: 0.9, quality: "proposed" }

describe("akmResultList", () => {
  for (const key of KEYS) {
    it(`reads the list under ${key}`, () => {
      expect(akmResultList({ [key]: [entry] })).toEqual([entry])
    })
    it(`reads an empty ${key} as empty`, () => {
      expect(akmResultList({ [key]: [] })).toEqual([])
    })
  }

  it("prefers results, then hits, then items", () => {
    const a = { ref: "skills/a" }
    const b = { ref: "skills/b" }
    const c = { ref: "skills/c" }
    expect(akmResultList({ items: [c], hits: [b], results: [a] })).toEqual([a])
    expect(akmResultList({ items: [c], hits: [b] })).toEqual([b])
    expect(akmResultList({ items: [c] })).toEqual([c])
  })

  it("is empty for anything that carries no list", () => {
    for (const value of [undefined, null, "text", 3, [], {}, { results: "x" }, { hits: {} }]) expect(akmResultList(value)).toEqual([])
  })
})

describe("every reader accepts all three key names and an empty list", () => {
  for (const key of KEYS) {
    it(`refsOfAkmResult reads ${key}`, () => {
      expect(refsOfAkmResult({ [key]: [{ ref: "skills/deploy" }, { ref: "knowledge/guide" }] })).toEqual(["skills/deploy", "knowledge/guide"])
      expect(refsOfAkmResult({ [key]: [] })).toEqual([])
    })

    it(`classifyToolFeedback treats a ${key} response as a success`, () => {
      expect(classifyToolFeedback({ [key]: [] })).toBe("positive")
    })

    it(`withProposedWarnings reads ${key}`, () => {
      const once = withProposedWarnings(JSON.stringify({ [key]: [entry] }))
      expect(JSON.parse(once).warnings).toEqual(["Do not treat proposed assets as curated until accepted."])
      const none = JSON.stringify({ [key]: [] })
      expect(withProposedWarnings(none)).toBe(none)
    })

    it(`the session bootstrap lists rules from ${key}`, async () => {
      const calls: string[][] = []
      const run = async (args: string[]) => {
        calls.push(args)
        if (args[0] === "search" && args.includes("rule")) return JSON.stringify({ [key]: [{ ref: "rules/r1", description: "R1" }], project: "acme" })
        if (args[0] === "search") return JSON.stringify({ [key]: [], project: "acme" })
        if (args[0] === "show") return JSON.stringify({ content: "- be careful" })
        return ""
      }
      const block = await loadSessionBootstrap(run, { budgetChars: 4000 })
      expect(block).toContain("be careful")
      expect(calls.some((args) => args[0] === "show" && args[1] === "rules/r1")).toBe(true)
    })
  }
})
