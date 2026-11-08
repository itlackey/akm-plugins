/**
 * Session bootstrap (#154): the project's rules and the assets used most in it,
 * loaded at session start and after each compaction. One implementation for the
 * Claude/Codex hook and both OpenCode plugins; the host supplies `run`, which
 * invokes the public `akm` CLI and returns its stdout ("" when the call failed).
 *
 * akm is the only source: `akm search --type rule` and `akm show` for the rules,
 * `akm search --by-usage` for the list. Nothing here keeps a popularity store or
 * opens a database. Every call carries AKM_EVENT_SOURCE=unknown so reading the
 * rules or the list never counts as demand and never raises their own ranking.
 *
 * Zero third-party imports: the Claude hook runs as a bare Bun script.
 */

/** Rules the listing may return; exactly this many means the list was cut. */
export const RULES_LIST_LIMIT = 200
/** How many most-used assets the list names. */
export const USAGE_LIST_SIZE = 10

const DESCRIPTION_MAX_CHARS = 160
const SHOW_BATCH = 8
// Room kept for the left-out note after the last rule that fits.
const NOTE_RESERVE = 220
const USAGE_CUT_NOTE = "(The list was cut to fit the context budget.)"
const READ_ENV = { AKM_EVENT_SOURCE: "unknown" }

/** Callbacks for one start or compaction event arrive together; one load serves them all. */
export const DUPLICATE_WINDOW_MS = 30_000

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

export type BootstrapRun = (args: string[], env: Record<string, string>) => Promise<string>

type Hit = { ref: string; description: string }
type Listing = { ok: boolean; hits: Hit[]; project: boolean }

function parseListing(raw: string): Listing {
  try {
    const parsed = JSON.parse(raw) as { hits?: unknown; project?: unknown }
    const hits: Hit[] = []
    for (const hit of Array.isArray(parsed.hits) ? parsed.hits : []) {
      const record = hit as { ref?: unknown; description?: unknown } | null
      if (typeof record?.ref !== "string" || !record.ref) continue
      hits.push({ ref: record.ref, description: typeof record.description === "string" ? record.description : "" })
    }
    return { ok: true, hits, project: !!parsed.project }
  } catch {
    return { ok: false, hits: [], project: false }
  }
}

function frontmatterFree(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").trim()
}

export type BootstrapOptions = {
  /** The host's explicit project override (`--project`), when it set one. */
  project?: string
  /** Characters this block may use; rule text comes first, then the list. */
  budgetChars: number
}

/**
 * The rendered bootstrap block, or "" when there is nothing to say: no rules and no
 * usage history, a failed lookup, or no budget.
 *
 * With a project (the session directory selects one, or `options.project` names
 * it) both listings run as akm resolves it. With none, both read only the user's
 * default bundle, with no selection filters or preferences.
 */
export async function loadSessionBootstrap(run: BootstrapRun, options: BootstrapOptions): Promise<string> {
  try {
    return await load(run, options)
  } catch {
    return ""
  }
}

const rulesArgs = (scope: string[]) => ["search", "", "--type", "rule", "--limit", String(RULES_LIST_LIMIT), "--detail", "normal", "--format", "json", "-q", ...scope]
const usageArgs = (scope: string[]) => ["search", "--by-usage", "--limit", String(USAGE_LIST_SIZE), "--detail", "normal", "--format", "json", "-q", ...scope]

async function load(run: BootstrapRun, options: BootstrapOptions): Promise<string> {
  if (options.budgetChars <= 0) return ""
  const list = async (build: (scope: string[]) => string[], scope: string[]) => parseListing(await run(build(scope), READ_ENV))
  const override = options.project ? ["--project", options.project] : []
  let [rules, usage] = await Promise.all([list(rulesArgs, override), list(usageArgs, override)])
  if (!rules.project && !usage.project) {
    // No project applies: the default bundle alone, never every configured bundle.
    const configured = await run(["config", "get", "defaultBundle", "-q"], READ_ENV)
    let name = ""
    try {
      const value = JSON.parse(configured) as unknown
      if (typeof value === "string") name = value.trim()
    } catch {}
    const scope = ["--project", "none", ...(name ? ["--from", name] : [])]
    ;[rules, usage] = await Promise.all([list(rulesArgs, scope), list(usageArgs, scope)])
  }

  let remaining = options.budgetChars
  const sections: string[] = []

  if (rules.hits.length > 0) {
    const heading = "# AKM rules for this session\nStanding rules from the AKM bundle. Each is under its source ref."
    const total = rules.hits.length
    const bodies: string[] = []
    let used = heading.length + NOTE_RESERVE
    let full = false
    for (let start = 0; start < total && !full; start += SHOW_BATCH) {
      const batch = rules.hits.slice(start, start + SHOW_BATCH)
      const shown = await Promise.all(batch.map((hit) => run(["show", hit.ref, "--format", "json", "-q", ...override], READ_ENV)))
      for (let i = 0; i < batch.length; i++) {
        let body = ""
        try {
          const content = (JSON.parse(shown[i]) as { content?: unknown }).content
          if (typeof content === "string") body = frontmatterFree(content)
        } catch {}
        if (!body) continue
        const section = `## ${batch[i].ref}\n${body}`
        // A rule is whole or left out; a clipped rule would read as the full rule.
        if (used + section.length + 2 > remaining) {
          full = true
          break
        }
        bodies.push(section)
        used += section.length + 2
      }
    }
    const leftOut = total - bodies.length
    const cut = total >= RULES_LIST_LIMIT
    const note =
      leftOut > 0 || cut
        ? `Not every rule is shown: ${leftOut} of ${cut ? `the first ${total}` : total} left out (context budget or unreadable)${cut ? `, and akm listed no more than ${RULES_LIST_LIMIT}` : ""}. List them with \`akm search "" --type rule\`.`
        : ""
    if (bodies.length > 0 || note) {
      const text = [heading, ...bodies, ...(note ? [note] : [])].join("\n\n")
      sections.push(text)
      remaining -= text.length + 2
    }
  }

  if (usage.hits.length > 0 && remaining > 0) {
    const heading = "# AKM assets used most here\nMost used first. Read one with `akm show <ref>` before relying on it."
    const lines: string[] = []
    let used = heading.length + 1 + USAGE_CUT_NOTE.length
    for (const hit of usage.hits) {
      const description = hit.description.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_MAX_CHARS)
      const line = description ? `- ${hit.ref} — ${description}` : `- ${hit.ref}`
      if (used + line.length + 1 > remaining) break
      lines.push(line)
      used += line.length + 1
    }
    if (lines.length > 0) sections.push([heading, ...lines, ...(lines.length < usage.hits.length ? [USAGE_CUT_NOTE] : [])].join("\n"))
  }

  return sections.join("\n\n")
}
