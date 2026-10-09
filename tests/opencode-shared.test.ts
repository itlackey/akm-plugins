import { describe, expect, it } from "bun:test"
import { buildReadArgs } from "../opencode-shared/akm-cli"
import { ASSET_TYPES, TOOL_SPECS, buildFeedbackArgs, toJsonSchema, withProposedWarnings } from "../opencode-shared/tools"

// Pure argv/schema builders shared by akm-opencode (V1) and akm-opencode-v2.
describe("opencode-shared read argv", () => {
  it("search maps tool fields to public CLI flags and asks for full JSON", () => {
    expect(buildReadArgs("search", { query: "review", type: "skill", limit: 3, source: "all", includeProposed: true })).toEqual([
      "search", "review", "--type", "skill", "--limit", "3", "--from", "all", "--include-proposed", "--detail", "full", "--format", "json",
    ])
    expect(buildReadArgs("search", {})).toEqual(["search", "", "--detail", "full", "--format", "json"])
  })

  it("show puts the ref first and maps summary to --shape", () => {
    expect(buildReadArgs("show", { ref: "knowledge/deploy#rollback", detail: "full" })).toEqual(["show", "knowledge/deploy#rollback", "--detail", "full", "--format", "json"])
    expect(buildReadArgs("show", { ref: "skills/a", detail: "summary" })).toEqual(["show", "skills/a", "--shape", "summary", "--format", "json"])
    expect(() => buildReadArgs("show", { ref: "--format" })).toThrow("must not start with '-'")
    expect(() => buildReadArgs("show", {})).toThrow("ref is required")
  })

  it("curate validates the pack budget before anything runs", () => {
    expect(buildReadArgs("curate", { query: "deploy", pack: 4096, source: "local" })).toEqual(["curate", "deploy", "--from", "local", "--pack", "4096", "--format", "json"])
    for (const pack of [0, -1, 1.5, "9"]) expect(() => buildReadArgs("curate", { query: "x", pack })).toThrow("pack must be a positive integer token budget")
  })
})

describe("opencode-shared tools", () => {
  it("describes exactly the five public tools", () => {
    expect(Object.keys(TOOL_SPECS).sort()).toEqual(["akm_curate", "akm_feedback", "akm_remember", "akm_search", "akm_show"])
    expect(ASSET_TYPES.at(-1)).toBe("any")
  })

  it("renders JSON Schema with required fields and array items", () => {
    const schema = toJsonSchema(TOOL_SPECS.akm_feedback) as any
    expect(schema.required).toEqual(["ref", "sentiment"])
    expect(schema.properties.replace).toEqual(expect.objectContaining({ type: "array", items: { type: "string" } }))
    expect(schema.properties.sentiment.enum).toEqual(["positive", "negative"])
  })

  it("builds feedback argv, with = for corrections that start with a dash", () => {
    expect(buildFeedbackArgs({ ref: "skills/a", sentiment: "negative", note: "stale", replace: ["old"], with: ["-new"], source: "docs" })).toEqual({
      args: ["feedback", "skills/a", "--negative", "--reason", "stale", "--replace", "old", "--with=-new", "--source", "docs"],
    })
    expect(buildFeedbackArgs({ ref: "a", sentiment: "positive", replace: ["x"], with: ["y"], source: "s" })).toEqual({ refusal: "replace, with and source are only for negative feedback." })
    expect(buildFeedbackArgs({ ref: "a", sentiment: "negative", replace: ["x"], with: ["y"] })).toEqual({ refusal: "A fix needs source: the URL, command or file that shows the correct fact." })
  })

  it("adds the proposed-quality warning once", () => {
    const raw = JSON.stringify({ hits: [{ ref: "a", quality: "proposed" }] })
    const once = withProposedWarnings(raw)
    expect(JSON.parse(once).warnings).toEqual(["Do not treat proposed assets as curated until accepted."])
    expect(withProposedWarnings(once)).toBe(once)
    expect(withProposedWarnings("not json")).toBe("not json")
  })
})
