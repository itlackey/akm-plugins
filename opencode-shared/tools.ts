// The five AKM tools (search, show, curate, feedback, remember) described once,
// independent of the OpenCode major: names, model-facing descriptions, argument
// schemas as plain data, and the pure argv builders for the two write verbs.
// V1 turns a spec into `tool.schema` arguments; V2 turns it into JSON Schema.
// The read verbs' argv lives in akm-cli.ts (buildReadArgs).
import { buildScopedArgs } from "./recall"

// The AKM 0.9 asset-type vocabulary, in the singular form `--type` accepts.
// This is exactly `akm info --format json` -> .assetTypes, sorted; keep the two
// in step when akm adds a type. There is no `wiki` type in 0.9. `any` is a
// tool-surface sentinel, not an akm type: it means "no filter" and is stripped
// before the value reaches akm, so it sorts last.
export const ASSET_TYPES = [
  "agent",
  "command",
  "env",
  "fact",
  "instruction",
  "knowledge",
  "lesson",
  "memory",
  "script",
  "secret",
  "session",
  "skill",
  "task",
  "workflow",
  "any",
] as const

export type ToolParam =
  | { kind: "string"; optional?: boolean; describe: string }
  | { kind: "number"; optional?: boolean; describe: string }
  | { kind: "boolean"; optional?: boolean; describe: string }
  | { kind: "enum"; values: readonly string[]; optional?: boolean; describe: string }
  | { kind: "stringArray"; optional?: boolean; describe: string }

export type ToolSpec = {
  name: "akm_search" | "akm_show" | "akm_curate" | "akm_feedback" | "akm_remember"
  description: string
  params: Record<string, ToolParam>
}

export const TOOL_SPECS: Record<ToolSpec["name"], ToolSpec> = {
  akm_search: {
    name: "akm_search",
    description: "Search configured AKM bundles or registries. Narrow path: reach for it when you already know an asset exists and need its exact ref — start open-ended discovery with akm_curate instead. Use source='registry' for installable community assets.",
    params: {
      query: { kind: "string", optional: true, describe: "Search query. Omit to browse all assets." },
      type: { kind: "enum", values: ASSET_TYPES, optional: true, describe: "Optional type filter. Defaults to 'any'." },
      limit: { kind: "number", optional: true, describe: "Maximum number of hits to return. Defaults to 20." },
      source: { kind: "string", optional: true, describe: "Search source: 'local', 'registry', 'all', or a configured bundle name." },
      include_proposed: { kind: "boolean", optional: true, describe: "Include proposed-quality results. Proposed assets are not curated until accepted." },
    },
  },
  akm_show: {
    name: "akm_show",
    description: "Show an AKM asset by [bundle//]conceptId[#fragment]. Read an asset this way before relying on it, then record akm_feedback when it helped, or when its content proved wrong or stale.",
    params: {
      ref: { kind: "string", describe: "Asset ref returned by akm_curate or akm_search, optionally with a #fragment — e.g. `skills/code-review` or `local//knowledge/deploy#Rollback`." },
      detail: { kind: "enum", values: ["brief", "summary", "normal", "full"], optional: true, describe: "Response detail level. Defaults to 'normal'." },
    },
  },
  akm_remember: {
    name: "akm_remember",
    description: "Record a memory in the default AKM bundle so it can be searched and shown later. Use it to preserve durable project knowledge future sessions should inherit.",
    params: {
      content: { kind: "string", describe: "Memory content to store." },
      name: { kind: "string", optional: true, describe: "Optional memory name." },
      force: { kind: "boolean", optional: true, describe: "Overwrite an existing memory with the same name." },
    },
  },
  akm_feedback: {
    name: "akm_feedback",
    description: "Record feedback for a bundle asset. Negative feedback is only for content that is wrong or stale. With a note it flags the asset and lowers its ranking; the next improve run may repair only its description, title or when_to_use from the note, so say what is wrong and what it should say. To correct a wrong fact in its text, also pass replace, with and source: akm checks the fix and queues it as a proposal for review. Attach a fix only when you have verified the correct fact (ran the command, read the official doc or the source file), otherwise record the note only. Positive feedback only raises the asset's ranking. An asset that simply didn't fit your task is not negative feedback: record nothing. Call it after akm_show when the asset's content materially helped, or proved wrong or stale. A failed akm call is not feedback on the asset.",
    params: {
      ref: { kind: "string", describe: "Asset ref to record feedback for." },
      sentiment: { kind: "enum", values: ["positive", "negative"], describe: "Whether the feedback is positive or negative." },
      note: { kind: "string", optional: true, describe: "What is wrong and what it should say. Required for negative feedback." },
      replace: { kind: "stringArray", optional: true, describe: "Exact current text to correct, copied verbatim from the asset's file (akm_show returns its path). Each must appear exactly once there. Pair each with a with entry, in order. Negative feedback only." },
      with: { kind: "stringArray", optional: true, describe: "The corrected text for each replace entry, in order. Change only the wrong words or lines: no rewording, no added headings or intros." },
      source: { kind: "string", optional: true, describe: "The URL, command or file that shows the correct fact. Required with replace." },
    },
  },
  akm_curate: {
    name: "akm_curate",
    description: "Reach for this BEFORE writing or editing a config file, manifest, schema, or command for any tool, format, or API whose exact syntax or keys you are not certain of — including a file already present in the workspace, since having read a file does not mean you know its schema. PRIMARY discovery entry point for the bundle: describe the task in natural language and this returns the top matches as a ranked list. Set pack to a token budget when you need the selected local assets' full content in one response; otherwise pass a hit's ref to akm_show before relying on it. Record akm_feedback once the result is known.",
    params: {
      query: { kind: "string", describe: "Task, topic, or natural-language description of what you want to do." },
      type: { kind: "enum", values: ASSET_TYPES, optional: true, describe: "Optional asset type filter." },
      limit: { kind: "number", optional: true, describe: "Maximum number of curated matches to return. Defaults to 4." },
      source: { kind: "string", optional: true, describe: "Search source: 'local', 'registry', 'all', or a configured bundle name." },
      pack: { kind: "number", optional: true, describe: "Optional positive token budget for packing ranked local assets' full content into this response. Registry hits are never packed." },
    },
  },
}

/** JSON Schema (draft 2020-12 subset) for one tool's arguments. */
export function toJsonSchema(spec: ToolSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, param] of Object.entries(spec.params)) {
    const base: Record<string, unknown> = { description: param.describe }
    if (param.kind === "string") base.type = "string"
    else if (param.kind === "number") base.type = "number"
    else if (param.kind === "boolean") base.type = "boolean"
    else if (param.kind === "enum") {
      base.type = "string"
      base.enum = [...param.values]
    } else {
      base.type = "array"
      base.items = { type: "string" }
    }
    properties[key] = base
    if (!param.optional) required.push(key)
  }
  return { type: "object", properties, required, additionalProperties: false }
}

// --- write verbs --------------------------------------------------------------

export function buildRememberArgs(
  input: { content: string; name?: string; force?: boolean },
  context: Record<string, unknown> | undefined,
): string[] {
  const args = ["remember", input.content]
  if (input.name) args.push("--name", input.name)
  if (input.force) args.push("--force")
  args.push(...buildScopedArgs(context))
  return args
}

export type FeedbackInput = {
  ref: string
  sentiment: "positive" | "negative"
  note?: string
  replace?: string[]
  with?: string[]
  source?: string
}

/**
 * Argv for `akm feedback`, or a refusal. The pairs are built by index, so lists
 * of different lengths are refused here, as are the two fixes akm would refuse
 * anyway, without starting it. Every other check on a fix is akm's own.
 */
export function buildFeedbackArgs(input: FeedbackInput): { args: string[] } | { refusal: string } {
  const fixes = input.replace?.length ?? 0
  const corrected = input.with?.length ?? 0
  if (fixes !== corrected) return { refusal: `Each replace needs one with (got ${fixes} replace and ${corrected} with).` }
  if (fixes > 0 && input.sentiment !== "negative") return { refusal: "replace, with and source are only for negative feedback." }
  if (fixes > 0 && !input.source?.trim()) {
    return { refusal: "A fix needs source: the URL, command or file that shows the correct fact." }
  }
  const args = ["feedback", input.ref, input.sentiment === "positive" ? "--positive" : "--negative"]
  if (input.note) args.push("--reason", input.note)
  // `--with=` and not `--with <text>`: a corrected text that starts with `-`
  // would otherwise be read as the next flag.
  for (let i = 0; i < fixes; i++) args.push("--replace", input.replace![i], `--with=${input.with![i]}`)
  if (input.source) args.push("--source", input.source)
  return { args }
}

const PROPOSED_QUALITY_WARNING = "Do not treat proposed assets as curated until accepted."

/** Adds the proposed-quality warning to a search response that carries proposed hits. */
export function withProposedWarnings(raw: string): string {
  let parsed: { hits?: Array<{ quality?: string }>; warnings?: string[] } | undefined
  try {
    parsed = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!parsed || typeof parsed !== "object") return raw
  if (!(parsed.hits?.some((hit) => hit?.quality === "proposed") ?? false)) return raw
  const warnings = parsed.warnings ?? []
  return JSON.stringify({
    ...parsed,
    warnings: warnings.includes(PROPOSED_QUALITY_WARNING) ? warnings : [...warnings, PROPOSED_QUALITY_WARNING],
  })
}
