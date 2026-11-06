// What the host stores in OpenCode session metadata under `metadata.akm`, read
// at call time and never written by the plugin: `retrieval` selects what search,
// curate and recall may return (#146), `write` is where `akm_remember` writes
// (#148). Values pass through to akm, which validates them; this file only keeps
// the shapes it can turn into flags.

export type Selection = Record<string, string | string[]>
export type Retrieval = { source?: string; filters?: Selection; prefer?: Selection }
export type WriteContext = {
  bundle?: string
  user?: string
  agent?: string
  run?: string
  channel?: string
  metadata?: Selection
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined)

function selection(value: unknown): Selection | undefined {
  const source = record(value)
  if (!source) return undefined
  const out: Selection = {}
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry === "string") out[key] = entry
    else if (Array.isArray(entry)) out[key] = entry.filter((item): item is string => typeof item === "string")
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function readRetrieval(metadata: Record<string, unknown> | undefined): Retrieval | undefined {
  const raw = record(record(metadata?.akm)?.retrieval)
  if (!raw) return undefined
  const retrieval: Retrieval = {}
  const source = text(raw.source)
  if (source) retrieval.source = source
  const filters = selection(raw.filters)
  if (filters) retrieval.filters = filters
  const prefer = selection(raw.prefer)
  if (prefer) retrieval.prefer = prefer
  return Object.keys(retrieval).length > 0 ? retrieval : undefined
}

export function readWrite(metadata: Record<string, unknown> | undefined): WriteContext | undefined {
  const raw = record(record(metadata?.akm)?.write)
  if (!raw) return undefined
  const write: WriteContext = {}
  for (const key of ["bundle", "user", "agent", "run", "channel"] as const) {
    const value = text(raw[key])
    if (value) write[key] = value
  }
  const extra = selection(raw.metadata)
  if (extra) write.metadata = extra
  return Object.keys(write).length > 0 ? write : undefined
}

/** `--filter k=v` / `--prefer k=v`, one flag per value. */
function pairFlags(flag: string, entries: Selection | undefined): string[] {
  const args: string[] = []
  for (const [key, value] of Object.entries(entries ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) args.push(flag, `${key}=${item}`)
  }
  return args
}

/** The flags for search and curate. `prefer` is left out where a duplicate check must not rank (the write gate). */
export function retrievalFlags(retrieval: Retrieval | undefined, options: { prefer?: boolean; from?: boolean } = {}): string[] {
  if (!retrieval) return []
  return [
    ...(options.from !== false && retrieval.source ? ["--from", retrieval.source] : []),
    ...pairFlags("--filter", retrieval.filters),
    ...(options.prefer === false ? [] : pairFlags("--prefer", retrieval.prefer)),
  ]
}

/** `metadata` as a leading frontmatter block; JSON scalars and flow lists are valid YAML. */
export function frontmatterBlock(metadata: Selection | undefined): string {
  const lines = Object.entries(metadata ?? {}).map(([key, value]) => {
    const name = /^[A-Za-z0-9_.-]+$/.test(key) ? key : JSON.stringify(key)
    return `${name}: ${JSON.stringify(value)}`
  })
  return lines.length > 0 ? `---\n${lines.join("\n")}\n---\n` : ""
}
