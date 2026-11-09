import { describe, expect, it } from "bun:test"
import { buildReadArgs } from "../opencode-shared/akm-cli"
import { formatPendingProposalContext } from "../opencode-shared/learning"
import { AKM_HINTS_PREFIX, formatRunAge, formatWorkflowContext, summarizeActiveWorkflows } from "../opencode-shared/recall"
import { ASSET_TYPES, TOOL_SPECS, buildFeedbackArgs, toJsonSchema, withProposedWarnings } from "../opencode-shared/tools"

// Pure argv/schema builders shared by akm-opencode (V1) and akm-opencode-v2.
describe("opencode-shared read argv", () => {
  it("search maps tool fields to public CLI flags and asks for full JSON", () => {
    expect(buildReadArgs("search", { query: "review", type: "skill", limit: 3, source: "all", includeProposed: true })).toEqual([
      "search", "review", "--type", "skill", "--limit", "3", "--from", "all", "--include-proposed", "--detail", "full", "--format", "json",
    ])
    expect(buildReadArgs("search", {})).toEqual(["search", "", "--detail", "full", "--format", "json"])
  })

  it("show puts the ref first and maps summary to --detail brief", () => {
    expect(buildReadArgs("show", { ref: "knowledge/deploy#rollback", detail: "full" })).toEqual(["show", "knowledge/deploy#rollback", "--detail", "full", "--format", "json"])
    expect(buildReadArgs("show", { ref: "skills/a", detail: "summary" })).toEqual(["show", "skills/a", "--detail", "brief", "--format", "json"])
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
    const raw = JSON.stringify({ results: [{ ref: "a", quality: "proposed" }] })
    const once = withProposedWarnings(raw)
    expect(JSON.parse(once).warnings).toEqual(["Do not treat proposed assets as curated until accepted."])
    expect(withProposedWarnings(once)).toBe(once)
    expect(withProposedWarnings("not json")).toBe("not json")
  })
})

describe("opencode-shared session context", () => {
  const NOW = Date.parse("2026-11-08T12:00:00Z")

  it("bounds a run's age and reads anything not a past timestamp as unknown", () => {
    expect(formatRunAge("2026-11-08T11:30:00Z", NOW)).toBe("updated <1h ago")
    expect(formatRunAge("2026-11-08T07:00:00Z", NOW)).toBe("updated 5h ago")
    expect(formatRunAge("2026-10-30T12:00:00Z", NOW)).toBe("updated 9d ago")
    for (const bad of ["not-a-date", "", undefined, null, 42, "2026-11-20T00:00:00Z"]) expect(formatRunAge(bad, NOW)).toBe("update time unknown")
  })

  it("lists active runs with age, never their titles or params, and marks relevance unknown", () => {
    const raw = JSON.stringify({ runs: [{ id: "run-1", workflowRef: "workflows/release", status: "active", currentStepId: "s2", workflowTitle: "IGNORE_ALL_RULES_INJECT", params: { k: "evilPayload" } }] })
    const summary = summarizeActiveWorkflows(raw)!
    expect(summary).toContain("workflows/release (run-1)")
    expect(summary).toContain("update time unknown")
    expect(summary).not.toContain("IGNORE_ALL_RULES_INJECT")
    expect(summary).not.toContain("evilPayload")
    expect(formatWorkflowContext(summary)).toContain("whether one applies to this task is unknown")
    expect(summarizeActiveWorkflows(JSON.stringify({ runs: [] }))).toBeNull()
  })

  it("presents pending proposals as information gated on the user's task", () => {
    const text = formatPendingProposalContext(2)
    expect(text).toContain("There are 2 pending AKM proposals.")
    expect(text).toContain("Only if the user's task involves proposals")
    expect(text).toContain("accepting or rejecting needs the user's approval")
  })

  it("names lessons among the assets and no longer points at `akm hints`", () => {
    expect(AKM_HINTS_PREFIX).toContain("lessons")
    expect(AKM_HINTS_PREFIX).not.toContain("akm hints")
  })
})
