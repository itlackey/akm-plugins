import { describe, expect, it } from "bun:test"
import { buildReadArgs, runAkm } from "../opencode-shared/akm-cli"
import { formatPendingProposalContext } from "../opencode-shared/learning"
import { AKM_HINTS_PREFIX, AKM_READONLY_HINTS_PREFIX } from "../opencode-shared/recall"
import { ASSET_TYPES, TOOL_SPECS, buildFeedbackArgs, readonlyOption, toJsonSchema, withProposedWarnings } from "../opencode-shared/tools"

// Pure argv/schema builders shared by akm-opencode (V1) and akm-opencode-v2.
describe("opencode-shared read argv", () => {
  it("search maps tool fields to public CLI flags and asks for full JSON", () => {
    expect(buildReadArgs("search", { query: "review", type: "skill", limit: 3, source: "all", includeProposed: true })).toEqual([
      "search", "review", "--type", "skill", "--limit", "3", "--from", "all", "--include", "quality=proposed", "--detail", "full", "--format", "json",
    ])
    expect(buildReadArgs("search", {})).toEqual(["search", "", "--detail", "full", "--format", "json"])
  })

  it("show puts the ref first and maps summary and brief to --outline", () => {
    expect(buildReadArgs("show", { ref: "knowledge/deploy#rollback", detail: "full" })).toEqual(["show", "knowledge/deploy#rollback", "--detail", "full", "--format", "json"])
    expect(buildReadArgs("show", { ref: "skills/a", detail: "summary" })).toEqual(["show", "skills/a", "--outline", "--format", "json"])
    expect(buildReadArgs("show", { ref: "skills/a", detail: "brief" })).toEqual(["show", "skills/a", "--outline", "--format", "json"])
    expect(() => buildReadArgs("show", { ref: "--format" })).toThrow("must not start with '-'")
    expect(() => buildReadArgs("show", {})).toThrow("ref is required")
  })

  it("curate validates the pack budget before anything runs", () => {
    expect(buildReadArgs("curate", { query: "deploy", pack: 4096, source: "local" })).toEqual(["curate", "deploy", "--from", "local", "--max-tokens", "4096", "--format", "json"])
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

describe("opencode-shared read-only option", () => {
  it("only a literal true turns it on; any other value warns, except an absent or false one", () => {
    expect(readonlyOption({ readonly: true })).toEqual({ readonly: true })
    for (const value of [undefined, false]) expect(readonlyOption({ readonly: value })).toEqual({ readonly: false })
    expect(readonlyOption(undefined)).toEqual({ readonly: false })
    for (const value of ["true", 1, null, {}]) {
      const result = readonlyOption({ readonly: value })
      expect(result.readonly).toBe(false)
      expect(result.warning).toContain("`readonly`")
    }
  })

  it("read-only hints name no write tool", () => {
    expect(AKM_READONLY_HINTS_PREFIX).toContain("akm_curate")
    expect(AKM_READONLY_HINTS_PREFIX).toContain("akm_feedback")
    expect(AKM_READONLY_HINTS_PREFIX).not.toContain("akm_remember")
    expect(AKM_READONLY_HINTS_PREFIX).not.toContain("akm help")
  })
})


describe("additive include selectors", () => {
  it("forwards repeatable include selectors on search and curate while preserving the session project", () => {
    for (const operation of ["search", "curate"] as const) {
      const args = buildReadArgs(operation, { query: "deploy nginx proxy", project: "acme", include: ["quality=proposed", "type=session"] })
      expect(args).toContain("--project")
      expect(args.slice(-6)).toEqual(["--include", "quality=proposed", "--include", "type=session", "--format", "json"])
      expect(args).not.toContain("--include-proposed")
    }
  })
  it("rejects malformed selectors at the tool boundary", () => {
    for (const include of ["quality=proposed", ["quality=curated"], ["project=other"], ["type="], [null]]) {
      expect(() => buildReadArgs("search", { include })).toThrow("include must be an array")
    }
  })
})

describe("opencode-shared stderr error", () => {
  const fail = (stderr: string) => runAkm({ command: "sh", argsPrefix: ["-c", `printf '%s\\n' "$0" >&2; exit 1`, stderr] } as never, [])
  it("reads the multi-line error JSON after a deprecation notice", async () => {
    const result = await fail(`[deprecated] --pack is deprecated and is removed in 0.11: use \`--max-tokens\`. See STABILITY.md.\n{\n  "ok": false,\n  "error": "Asset not found",\n  "code": "ASSET_NOT_FOUND"\n}`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("Asset not found")
  })
  it("still returns raw text when stderr is not JSON", async () => {
    const result = await fail("boom")
    if (!result.ok) expect(result.error).toBe("boom")
  })
})
