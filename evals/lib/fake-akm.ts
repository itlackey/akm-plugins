// Deterministic fake `akm` CLI shim, written into a temp PATH dir at runtime.
// Tier-2 evals invoke the real plugin hooks, but stub the akm binary so
// retrieval is reproducible. Plugin changes that drop refs, truncate
// curation output, or break the hook → akm wiring will surface as metric
// regressions even though the underlying retrieval is held constant.
//
// The shim ranks fixture assets against the prompt with a tiny TF-IDF-ish
// keyword match (computed in the shim's parent process and baked into the
// shell script as a static lookup table). It also implements the subset of
// `akm` verbs the hooks actually call: `curate`, `feedback`, `remember`,
// `index`, `hints`, `info`, `search`, `config get`/`config set`,
// `workflow list`, `proposal list`, `extract`, `--version`. Envelope shapes
// for these are pinned against a real `akm` binary by
// tests/fake-akm-contract.test.ts. Any other verb still exits 0 (never breaks
// the hook) but logs to stderr instead of no-op'ing silently — see the bottom
// of RANK_HELPER_JS.
//
// `info` is the highest-stakes verb here even though nothing "interesting"
// happens in it: both plugins resolve their bundle root from
// `akm info --format json` → .bundleDir when $AKM_BUNDLE_DIR is unset, and
// validateRefCandidates() early-returns [] with no bundle root — so an
// unimplemented `info` silently disables every ref-driven code path.

import { mkdirSync, writeFileSync, chmodSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

export type FakeAkmAsset = {
  // AKM 0.9 concept ID — the asset's own path inside the bundle, e.g.
  // `skills/code-review`, `knowledge/api-error-codes`, `scripts/lint.sh`.
  // (Pre-0.9 this was the `type:slug` form, e.g. `skill:code-review`.)
  ref: string
  // Singular asset type as reported by `akm info` → .assetTypes.
  type: string
  name: string
  description: string
  keywords: string[]
}

export type FakeAkmConfig = {
  // Directory the shim will be installed into (usually a temp bin/).
  binDir: string
  // Path the shim writes call records to (one tab-separated line per call).
  callLog: string
  // The fixture stash to rank against. Either a parsed asset list or a
  // directory the loader can scan.
  assets: FakeAkmAsset[] | { stashDir: string }
  // Optional: how many results `curate` returns by default. Hook overrides via --limit.
  defaultLimit?: number
}

export type LoadedFakeAkm = {
  binDir: string
  akmPath: string
  callLog: string
  assets: FakeAkmAsset[]
}

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---/

function parseFrontmatter(body: string): Record<string, string | string[]> {
  const match = FRONTMATTER_RE.exec(body)
  if (!match) return {}
  const out: Record<string, string | string[]> = {}
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":")
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    const raw = line.slice(colon + 1).trim()
    if (!key) continue
    if (raw.startsWith("[") && raw.endsWith("]")) {
      out[key] = raw
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean)
    } else {
      out[key] = raw.replace(/^["']|["']$/g, "")
    }
  }
  return out
}

function fileToAsset(filePath: string, type: string, conceptId: string, name: string): FakeAkmAsset | null {
  let body = ""
  try {
    body = readFileSync(filePath, "utf8")
  } catch {
    return null
  }
  const fm = parseFrontmatter(body)
  const description =
    typeof fm.description === "string"
      ? fm.description
      : Array.isArray(fm.description)
        ? fm.description.join(" ")
        : ""
  const keywords = Array.isArray(fm.keywords)
    ? fm.keywords
    : typeof fm.keywords === "string" && fm.keywords
      ? fm.keywords.split(/\s+/)
      : []
  return {
    ref: conceptId,
    type,
    name,
    description,
    keywords,
  }
}

// AKM 0.9 concept IDs are bundle-relative paths. The bundle README documents
// that a `.md` extension is dropped when forming the ref
// (`knowledge/auth/oauth-refresh-races.md` → `knowledge/auth/oauth-refresh-races`),
// while any other extension is part of the ref (`scripts/lint.sh`). This
// matters: claude/shared/ref-extraction.ts resolves a candidate by probing
// `<root>/<conceptId>` and `<root>/<conceptId>.md` only, so a `scripts/lint`
// ref for an on-disk `scripts/lint.sh` would fail validation and vanish.
function conceptIdFor(dir: string, entry: string): string {
  return `${dir}/${entry.replace(/\.md$/i, "")}`
}

// Walk a fixture stash directory and produce an asset inventory the shim
// can rank against. Mirrors the AKM 0.9 bundle layout — the directories
// `akm bundle create` scaffolds: agents commands env facts instructions
// knowledge lessons memories scripts secrets sessions skills tasks workflows.
// (`wikis/` and `vaults/` are NOT 0.9 asset types and were dropped here;
// `akm info` → .assetTypes lists neither.)
//
// `secrets/` is deliberately NOT scanned: a secret is one standalone value
// per file, and real akm never content-indexes it, so it must never show up
// in curate output. Its files still exist in the fixture stash so that
// `secrets/…` refs resolve during ref validation (which is what the
// auto-feedback skip-list fixtures exercise). `sessions/` is likewise not
// scanned — session transcripts aren't curation candidates.
export function loadFixtureStash(stashDir: string): FakeAkmAsset[] {
  const out: FakeAkmAsset[] = []
  const types: Array<{ dir: string; type: string; layout: "file" | "skill-dir" }> = [
    { dir: "skills", type: "skill", layout: "skill-dir" },
    { dir: "commands", type: "command", layout: "file" },
    { dir: "agents", type: "agent", layout: "file" },
    { dir: "knowledge", type: "knowledge", layout: "file" },
    { dir: "instructions", type: "instruction", layout: "file" },
    { dir: "facts", type: "fact", layout: "file" },
    { dir: "memories", type: "memory", layout: "file" },
    { dir: "lessons", type: "lesson", layout: "file" },
    { dir: "scripts", type: "script", layout: "file" },
    { dir: "workflows", type: "workflow", layout: "file" },
    { dir: "tasks", type: "task", layout: "file" },
    // env values are never content-indexed either, but the asset's own
    // name/description metadata is discoverable — `akm env` lists them.
    { dir: "env", type: "env", layout: "file" },
  ]
  for (const t of types) {
    const root = path.join(stashDir, t.dir)
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      // Skip dotfiles (.gitkeep and friends) — they aren't assets, and a
      // `.gitkeep` previously produced a nameless `memory:` entry in the index.
      if (entry.startsWith(".")) continue
      const entryPath = path.join(root, entry)
      let stat
      try {
        stat = statSync(entryPath)
      } catch {
        continue
      }
      if (t.layout === "skill-dir" && stat.isDirectory()) {
        const asset = fileToAsset(path.join(entryPath, "SKILL.md"), t.type, `${t.dir}/${entry}`, entry)
        if (asset) out.push(asset)
      } else if (t.layout === "file" && stat.isFile()) {
        const name = entry.replace(/\.[^.]+$/, "")
        const asset = fileToAsset(entryPath, t.type, conceptIdFor(t.dir, entry), name)
        if (asset) out.push(asset)
      }
    }
  }
  return out
}

// Public API: install a fake `akm` binary into binDir. Returns metadata
// the harness uses to assemble PATH and inspect call logs.
export function installFakeAkm(config: FakeAkmConfig): LoadedFakeAkm {
  mkdirSync(config.binDir, { recursive: true })
  const assets = Array.isArray(config.assets)
    ? config.assets
    : loadFixtureStash(config.assets.stashDir)
  const defaultLimit = config.defaultLimit ?? 5
  // `akm info` reports the bundle root, and both plugins fall back to it when
  // $AKM_BUNDLE_DIR is unset. Bake in the same directory the asset inventory
  // was scanned from so the shim's `info` answer stays consistent with what
  // it will actually rank and with what refs resolve against on disk.
  const bundleDir = Array.isArray(config.assets) ? "" : config.assets.stashDir
  const indexPath = path.join(config.binDir, "akm-index.json")
  writeFileSync(
    indexPath,
    JSON.stringify(
      {
        defaultLimit,
        callLog: config.callLog,
        bundleDir,
        assets,
      },
      null,
      2,
    ),
  )

  // The shim is a tiny POSIX shell script that delegates ranking to a
  // node helper. Keeping it shell-shaped means the existing hook can
  // invoke `akm` exactly as in production — including the
  // `--format json -q ...` global flags Claude's hook uses.
  const akmPath = path.join(config.binDir, "akm")
  const helperPath = path.join(config.binDir, "akm-rank.mjs")
  writeFileSync(helperPath, RANK_HELPER_JS)
  writeFileSync(
    akmPath,
    `#!/usr/bin/env sh
INDEX="${indexPath}"
HELPER="${helperPath}"
RUNTIME=${JSON.stringify(process.execPath)}
exec "$RUNTIME" "$HELPER" "$INDEX" "$@"
`,
  )
  chmodSync(akmPath, 0o755)
  return {
    binDir: config.binDir,
    akmPath,
    callLog: config.callLog,
    assets,
  }
}

// Read the call-log file produced by the shim into a structured list.
// The on-disk format is:  <ts>\t<callId>\t<argv0>\t<argv1>\t…
// callId is a random per-invocation token used by readStdinForCall to
// fetch the captured stdin (when the verb piped one).
export function readCallLog(callLog: string): Array<{ ts: string; callId: string; argv: string[] }> {
  let body: string
  try {
    body = readFileSync(callLog, "utf8")
  } catch {
    return []
  }
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ts, callId, ...argv] = line.split("\t")
      return { ts, callId, argv }
    })
}

// For a given call (by callId), return the stdin the hook piped to akm.
// Returns null if no stdin was captured (verbs other than `remember`,
// or if the stdin write failed).
export function readStdinForCall(callLog: string, callId: string): string | null {
  const stdinPath = path.join(path.dirname(callLog), "stdin", callId + ".txt")
  try {
    return readFileSync(stdinPath, "utf8")
  } catch {
    return null
  }
}

// The ranking helper is shipped as a string so the shim is self-contained.
// It reads the prompt from argv (after stripping global flags & verb-args
// the hooks pass), scores each asset by keyword/description overlap with
// simple lowercase token-set matching, and prints the top-K refs.
//
// This helper is a deliberate CLI shim used by evals. Its stdout writes are
// the emulated terminal contract under test, not plugin runtime logging.
//
// The shim ALSO captures stdin to a sibling file (akm-stdin-<ts>.txt)
// when invoked with verbs that pipe content (notably `remember`). This
// lets tier-2's memory metric verify the actual payload the hook
// committed, which catches plugin-side regressions like buffer
// truncation or stripping that earlier versions of this framework would
// silently miss.
const RANK_HELPER_JS = `#!/usr/bin/env node
import { readFileSync, appendFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs"
import path from "node:path"

const indexPath = process.argv[2]
const argv = process.argv.slice(3)
const idx = JSON.parse(readFileSync(indexPath, "utf8"))

// Append a tab-separated call record so tests can assert what the hook called.
const callId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 6)
try {
  const dir = path.dirname(idx.callLog)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  appendFileSync(idx.callLog, [new Date().toISOString(), callId, ...argv].join("\\t") + "\\n")
} catch {}

// Strip global flags so we can find the verb. Mirrors the akm CLI surface
// the hooks invoke: \`akm [--format X] [--shape S] [-q] [--detail Y] <verb> [args...]\`.
// \`--shape\` is a v0.8.0 global flag (human|agent|summary); omitting it here made
// the shim mis-detect the verb as "--shape" and emit nothing, collapsing curation.
const args = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === "--format" || a === "--detail" || a === "--shape") {
    i++
    continue
  }
  if (a === "-q" || a === "--quiet") continue
  args.push(a)
}

const verb = args[0] || ""
const tail = args.slice(1)

function tokens(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\\s+/)
    .filter((t) => t && t.length > 2)
}

function rank(query, limit) {
  const q = new Set(tokens(query))
  if (q.size === 0) return []
  const scored = idx.assets.map((a) => {
    const haystack = new Set([...tokens(a.description), ...a.keywords.flatMap(tokens), ...tokens(a.name)])
    let score = 0
    for (const t of q) if (haystack.has(t)) score += 1
    // Tie-break on keyword density so docs with denser hits beat ones that
    // mention the term once in passing.
    score += haystack.size > 0 ? Math.min(0.5, q.size / haystack.size) * 0.01 : 0
    return { ref: a.ref, type: a.type, name: a.name, description: a.description, score }
  })
  scored.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref))
  return scored.filter((s) => s.score > 0).slice(0, limit)
}

function emitText(hits) {
  if (hits.length === 0) return
  for (const h of hits) {
    process.stdout.write(\`[\${h.type}] \${h.name} — \${h.description}\\n\`)
    process.stdout.write(\`  ref: \${h.ref}\\n\`)
  }
}

function emitJson(hits) {
  process.stdout.write(JSON.stringify({ ok: true, hits }))
}

function getLimit(defaultLimit) {
  const i = tail.indexOf("--limit")
  if (i >= 0 && tail[i + 1]) {
    const n = parseInt(tail[i + 1], 10)
    if (!Number.isNaN(n) && n > 0) return n
  }
  return defaultLimit ?? idx.defaultLimit ?? 5
}

function nonFlagArgs() {
  const out = []
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i]
    if (a === "--limit" || a === "--type" || a === "--from" || a === "--name" || a === "--reason" || a === "--run" || a === "--scope") {
      i++
      continue
    }
    if (a === "--positive" || a === "--negative" || a === "--force" || a === "--push" || a === "--all" || a === "--check") continue
    if (a.startsWith("--")) continue
    out.push(a)
  }
  return out
}

if (verb === "curate" || verb === "search") {
  const query = nonFlagArgs().join(" ")
  const hits = rank(query, getLimit())
  if (argv.includes("--format") && argv[argv.indexOf("--format") + 1] === "json") {
    emitJson(hits)
  } else {
    emitText(hits)
  }
  process.exit(0)
}

if (verb === "hints") {
  // SessionStart calls this. Emit a small static blurb so the hook has
  // something to inject; keeps the pipeline exercised.
  process.stdout.write("Bundle health: 15 assets. Run \`akm search <query>\`.\\n")
  process.exit(0)
}

// --- info -------------------------------------------------------------------
// The verb that gates ALL ref validation. Both plugins resolve their bundle
// root as: $AKM_BUNDLE_DIR, else \`akm info --format json -q\` → .bundleDir
// (claude/hooks/akm-hook.ts resolveStashRoots(), opencode/index.ts
// getAkmBundleDir()). With no bundle root, validateRefCandidates() returns []
// and auto-feedback never fires — so an unmodelled \`info\` is indistinguishable
// from a plugin that lost ref extraction entirely.
//
// assetTypes is the 0.9 asset-type vocabulary, in the order real akm emits it.
// tests/fake-akm-contract.test.ts pins both the envelope shape and this list
// against the real binary.
if (verb === "info") {
  const bundleDir = (process.env.AKM_BUNDLE_DIR || idx.bundleDir || "").trim()
  const byType = {}
  for (const a of idx.assets) byType[a.type] = (byType[a.type] || 0) + 1
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      version: "0.9.2",
      bundleDir,
      defaultBundle: "bundle",
      assetTypes: [
        "skill",
        "command",
        "agent",
        "knowledge",
        "instruction",
        "workflow",
        "script",
        "memory",
        "env",
        "secret",
        "lesson",
        "task",
        "session",
        "fact",
      ],
      searchModes: ["fts"],
      semanticSearch: { mode: "off", status: "disabled" },
      registries: [],
      sourceProviders: bundleDir ? [{ type: "filesystem", name: "bundle", path: bundleDir }] : [],
      indexStats: {
        entryCount: idx.assets.length,
        byType,
        lastBuiltAt: null,
        hasEmbeddings: false,
        vecAvailable: false,
      },
      shape: "info",
    }),
  )
  process.exit(0)
}

// --- config get/set -------------------------------------------------------
// The plugins resolve AKM_BUNDLE_DIR directly and use akm info as their
// fallback. Keep generic config get/set behavior here because it is still a
// public AKM surface exercised by eval scenarios.
// persist defaults.agent / profiles.agent.<platform>). Real akm returns a
// bare JSON scalar for a leaf \`config get\`, or an object wrapped with
// {shape:"config", schemaVersion:1} for a subtree; \`config set\` is
// acknowledged via exit code only when --silent is passed. Persist writes to
// a JSON store on disk so a later \`config get\` in the same test sees them.
const configStorePath = path.join(path.dirname(idx.callLog), "akm-config-store.json")

function readConfigStore() {
  try {
    return JSON.parse(readFileSync(configStorePath, "utf8"))
  } catch {
    return {}
  }
}

function writeConfigStore(store) {
  try {
    const dir = path.dirname(configStorePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(configStorePath, JSON.stringify(store))
  } catch {}
}

function getAtPath(obj, dottedKey) {
  return dottedKey.split(".").reduce((acc, part) => (acc && typeof acc === "object" ? acc[part] : undefined), obj)
}

function setAtPath(obj, dottedKey, value) {
  const parts = dottedKey.split(".")
  let node = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!node[part] || typeof node[part] !== "object") node[part] = {}
    node = node[part]
  }
  node[parts[parts.length - 1]] = value
}

// \`config\` subcommand flags (--layer <value>, --silent, --all) are distinct
// from the global flags already stripped above, so filter them here to
// isolate the positional [sub, key, value] triple.
function configPositionals() {
  const out = []
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i]
    if (a === "--layer") {
      i++
      continue
    }
    if (a === "--silent" || a === "--all") continue
    out.push(a)
  }
  return out
}

if (verb === "config") {
  const [sub, key, rawValue] = configPositionals()
  const store = readConfigStore()
  if (sub === "get") {
    const value = key ? getAtPath(store, key) : store
    const result = value === undefined ? null : value
    process.stdout.write(
      result && typeof result === "object" ? JSON.stringify({ ...result, shape: "config", schemaVersion: 1 }) : JSON.stringify(result),
    )
    process.exit(0)
  }
  if (sub === "set" && key) {
    let value = rawValue
    if (typeof value === "string") {
      try {
        value = JSON.parse(value)
      } catch {
        // Plain scalar (e.g. platform name) — keep as string.
      }
    }
    setAtPath(store, key, value)
    writeConfigStore(store)
    process.exit(0)
  }
  // Any other config subcommand (list/unset/path/...): ack and move on.
  process.exit(0)
}

// --- workflow list --active ------------------------------------------------
// SessionStart / subagentStart summarize active workflow runs from this. The
// fake stash never has live workflow runs, so an empty-but-real-shaped
// envelope exercises the parse path without inventing fixture state.
if (verb === "workflow" && tail[0] === "list") {
  process.stdout.write(JSON.stringify({ runs: [], shape: "workflow-list", schemaVersion: 1 }))
  process.exit(0)
}

// --- proposal list ----------------------------------------------------------
// getPendingProposalCount() (both plugins) parses \`.proposals\` off this to
// surface a pending-proposal count in the session-start header.
if (verb === "proposal" && tail[0] === "list") {
  process.stdout.write(JSON.stringify({ totalCount: 0, proposals: [] }))
  process.exit(0)
}

// --- proposal extract ---------------------------------------------------
// SessionEnd fires this fire-and-forget on both plugins. Real akm's extract
// ALWAYS requires an LLM engine before it does anything — unlike most other
// verbs, its "feature disabled" fast path only applies when running as an
// improve-profile stage, not for a direct \`akm proposal extract\` invocation
// like the hooks make — so a real akm with no engine configured (the state a
// freshly-installed akm is normally in, and the state tier-2 fixtures are in)
// deterministically fails.
//
// Three properties of that failure are load-bearing and are all reproduced
// here, verified against akm-cli 0.9.2:
//   1. the envelope goes to STDERR, not stdout (stdout stays empty);
//   2. the exit code is 78 — akm's documented "config error" code, not 0;
//   3. the code is LLM_NOT_CONFIGURED.
// Both plugins now capture and report this failure instead of discarding it
// (the harvest path was previously a silent no-op on any un-configured
// install), so a fake that exits 0 on stdout would let a regression in that
// reporting path pass every eval and unit test. tests/fake-akm-contract.test.ts
// pins the envelope shape, the stream, and the exit code against the real
// binary. Writing to stderr here is the documented fake-CLI exception to the
// no-stderr-logging rule in AGENTS.md.
if (verb === "proposal" && tail[0] === "extract") {
  process.stderr.write(
    JSON.stringify({
      ok: false,
      error:
        "No LLM engine configured for extract. Set defaults.llmEngine, pass --engine, or select an improve strategy with processes.extract.engine.",
      code: "LLM_NOT_CONFIGURED",
      hint: "Run \\\`akm setup\\\` or configure an \\\`engines\\\` entry with \\\`kind: \\"llm\\"\\\`, then select it with \\\`defaults.llmEngine\\\`.",
    }),
  )
  process.exit(78)
}

if (verb === "remember") {
  // Capture the piped buffer body so tier-2's memory metric can score
  // what the hook actually flushed (rather than just whether it called
  // remember). The plugin pipes the session buffer to akm via stdin.
  let stdin = ""
  try {
    stdin = readFileSync(0, "utf8")
  } catch {}
  const stdinDir = path.join(path.dirname(idx.callLog), "stdin")
  try {
    if (!existsSync(stdinDir)) mkdirSync(stdinDir, { recursive: true })
    writeFileSync(path.join(stdinDir, callId + ".txt"), stdin)
  } catch {}
  if (argv.includes("--format") && argv[argv.indexOf("--format") + 1] === "json") {
    process.stdout.write(JSON.stringify({ ok: true, verb, args: tail }))
  }
  process.exit(0)
}

if (verb === "feedback" || verb === "index" || verb === "show") {
  // The hooks call these for side effects; we just ack.
  if (argv.includes("--format") && argv[argv.indexOf("--format") + 1] === "json") {
    process.stdout.write(JSON.stringify({ ok: true, verb, args: tail }))
  }
  process.exit(0)
}

if (verb === "--version" || verb === "-V") {
  // Plugin gates feature paths on satisfiesAkmVersionRange() which only
  // accepts current 0.9 builds. Reporting an older fake version made the OpenCode plugin
  // treat the shim as an incompatible CLI and silently short-circuit
  // auto-feedback (queueFeedback bails before spawning). Keep this in lockstep
  // with the plugin's required range so eval harnesses exercise the real path.
  // Node 24 can drop an async stdout write when this short-lived fake calls
  // process.exit() immediately afterwards and stdout is a pipe (as it is for
  // OpenCode's execFileSync version probe). Write synchronously so callers
  // always receive the semver that governs the compatibility gate.
  writeFileSync(1, "fake-akm 0.9.2\\n")
  process.exit(0)
}

// Truly unknown verb: still exit 0 so the hook never sees a hard failure it
// wasn't expecting, but log it to stderr (not swallowed — this shim is a
// documented fake-CLI exception to the no-stderr-logging rule, see
// AGENTS.md) so a verb the plugins start calling and this shim doesn't yet
// model shows up in CI output instead of vanishing silently. The call log
// (written unconditionally above, before verb dispatch) also has a durable
// record of the invocation for tier-2 metrics to inspect.
process.stderr.write("fake-akm: unhandled verb " + JSON.stringify(verb) + " (args: " + JSON.stringify(tail) + ")\\n")
process.exit(0)
`
