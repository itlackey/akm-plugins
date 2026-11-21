/**
 * Session bootstrap (#154): the project's rules and the assets used most in it,
 * loaded at session start and after each compaction. One implementation for the
 * Claude/Codex hook and both OpenCode plugins; the host supplies `run`, which
 * invokes the public `akm` CLI and returns its stdout ("" when the call failed).
 *
 * akm is the only source: `akm rules` for the rules (akm decides which apply and
 * which bundles supply them), `akm doctor metrics assets` for the list. Nothing
 * here keeps a popularity store or opens a database.
 *
 * Zero third-party imports: the Claude hook runs as a bare Bun script.
 */

import { akmResultList } from "./result-list"

/** How many most-used assets the list names. */
export const USAGE_LIST_SIZE = 10

const DESCRIPTION_MAX_CHARS = 160
const USAGE_LEFT_OUT_NOTE = "(The list of most-used assets was left out to fit the context budget.)"
const USAGE_CUT_NOTE = "(The list was cut to fit the context budget.)"

/** Callbacks for one start or compaction event arrive together; one load serves them all. */
export const DUPLICATE_WINDOW_MS = 10_000
/** The whole load gives up after this: well inside a hook's 120 s, and akm calls have timeouts of their own. */
export const LOAD_DEADLINE_MS = 30_000

/**
 * True when this start/compaction event (`key`: session plus kind) has not been loaded in the
 * last DUPLICATE_WINDOW_MS, and marks it loaded. `seen` maps keys to load times; old entries are
 * dropped. A later compaction of the same session is a new event once the window has passed.
 */
export function claimBootstrap(seen: Record<string, number>, key: string, now: number = Date.now()): boolean {
  for (const [k, at] of Object.entries(seen)) if (now - at > 60 * 60 * 1000) delete seen[k]
  const last = seen[key]
  if (last !== undefined && now - last < DUPLICATE_WINDOW_MS) return false
  seen[key] = now
  return true
}

export type BootstrapRun = (args: string[]) => Promise<string>

type Rule = { ref: string; content: string }
type Hit = { ref: string; description: string }

function parseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export type BootstrapOptions = {
  /** The host's explicit project override (`--project`), when it set one. */
  project?: string
  /** Read-only OpenCode sessions have no CLI: the text names the `akm_show` tool instead of commands. */
  readonly?: boolean
  /** Characters this block may use; rule text comes first, then the list. */
  budgetChars: number
  /** Test seam: how long the whole load may take. */
  deadlineMs?: number
}

/**
 * The rendered bootstrap block, or "" when there is nothing to say: no rules and no
 * usage history, a failed `akm rules` call, or no budget.
 *
 * The list is read for the project `akm rules` reports; with none, from the first
 * bundle it read, with no selection filters or preferences.
 */
export async function loadSessionBootstrap(run: BootstrapRun, options: BootstrapOptions): Promise<string> {
  try {
    return await load(run, options)
  } catch {
    return ""
  }
}

async function load(run: BootstrapRun, options: BootstrapOptions): Promise<string> {
  if (options.budgetChars <= 0) return ""
  const deadline = Date.now() + (options.deadlineMs ?? LOAD_DEADLINE_MS)
  const override = options.project ? ["--project", options.project] : []
  const response = parseJson(await run(["rules", "--format", "json", "-q", ...override]))
  if (!response || !Array.isArray(response.rules)) return ""
  const rules: Rule[] = []
  for (const entry of response.rules as Array<{ ref?: unknown; content?: unknown } | null>) {
    if (typeof entry?.ref !== "string" || !entry.ref || typeof entry.content !== "string" || !entry.content.trim()) continue
    rules.push({ ref: entry.ref, content: entry.content.trim() })
  }

  let remaining = options.budgetChars
  const sections: string[] = []

  if (rules.length > 0) {
    const heading = "# AKM rules for this session\nStanding rules from the AKM bundle. Each is under its source ref."
    const leftOutNote = (left: Rule[]) =>
      left.length === 0
        ? ""
        : `Not every rule is shown: ${left.length} of ${rules.length} left out to fit the context budget. ${options.readonly ? `Read them with \`akm_show\`: ${left.map((rule) => rule.ref).join(", ")}.` : "List them all with `akm rules`."}`
    const bodies: string[] = []
    let used = heading.length
    for (const [i, rule] of rules.entries()) {
      const section = `## ${rule.ref}\n${rule.content}`
      // A rule is whole or left out (a clipped rule would read as the full rule); the note for the rest must still fit.
      if (used + section.length + 2 + leftOutNote(rules.slice(i + 1)).length + 2 > remaining) break
      bodies.push(section)
      used += section.length + 2
    }
    const note = leftOutNote(rules.slice(bodies.length))
    const text = [heading, ...bodies, ...(note ? [note] : [])].join("\n\n")
    sections.push(text)
    remaining -= text.length + 2
  }

  const usageScope = response.project ? override : ["--project", "none", ...(Array.isArray(response.bundles) && typeof response.bundles[0] === "string" ? ["--from", response.bundles[0]] : [])]
  const usage: Hit[] =
    remaining > 0 && Date.now() < deadline
      ? akmResultList(parseJson(await run(["doctor", "metrics", "assets", "--limit", String(USAGE_LIST_SIZE), "--detail", "normal", "--format", "json", "-q", ...usageScope])) ?? {}).flatMap((hit) => {
          const record = hit as { ref?: unknown; description?: unknown } | null
          return typeof record?.ref === "string" && record.ref ? [{ ref: record.ref, description: typeof record.description === "string" ? record.description : "" }] : []
        })
      : []

  if (usage.length > 0) {
    const heading = `# AKM assets used most here\nMost used first. Read one with ${options.readonly ? "`akm_show`" : "`akm show <ref>`"} before relying on it.`
    const lines: string[] = []
    let used = heading.length + 1 + USAGE_CUT_NOTE.length
    for (const hit of usage) {
      const description = hit.description.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_MAX_CHARS)
      const line = description ? `- ${hit.ref} — ${description}` : `- ${hit.ref}`
      if (used + line.length + 1 > remaining) break
      lines.push(line)
      used += line.length + 1
    }
    if (lines.length > 0) sections.push([heading, ...lines, ...(lines.length < usage.length ? [USAGE_CUT_NOTE] : [])].join("\n"))
    else if (remaining >= USAGE_LEFT_OUT_NOTE.length) sections.push(USAGE_LEFT_OUT_NOTE)
  }

  return sections.join("\n\n")
}
