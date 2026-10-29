// The format-declaration write gate (#99) for the OpenCode plugins (V1
// `akm-opencode`, V2 `akm-opencode-v2`): when a file the session READ declares a
// format the bundle documents, and that asset has not been opened this session,
// the first edit/write to the file is blocked once with a message naming the asset.
//
// Everything version-neutral lives here: the identity extraction, the stash
// resolution, the per-session bookkeeping, the decision and the ledger. What
// differs per OpenCode major is the host adapter (GateHost): how to log, how to
// run the identity search, and the tool vocabulary (V1 `filePath` / `apply_patch`,
// V2 `path` / `patch`). Wiring the decision into the host's pre-tool hook, and
// turning a read result into `observeFileIdentity()`'s input, stays in each
// entrypoint. Nothing here writes to the console.
import path from "node:path"
import { type EventWriter, buildEventScope, opencodeEventLog } from "./events"
import type { LearningLog } from "./learning"

export type GateSearchHit = { name?: string; ref?: string; description?: string }
export type GateSearchResponse = { hits?: GateSearchHit[] }

export type GateHost = {
  log: LearningLog
  writeEvent: EventWriter
  formatError: (error: unknown) => string
  /** One local `akm search <token>` through the public CLI; rejects on failure. */
  search: (token: string) => Promise<GateSearchResponse | undefined>
  /** The argument key that names the target file (`filePath` on V1, `path` on V2). */
  pathKey: string
  /** The patch-envelope tool (`apply_patch` on V1, `patch` on V2): no file path to resolve. */
  patchTool: string
}

// --- write gate (#99) -------------------------------------------------------
// #94 and #95 both moved engagement by rewording the prompt, and both left the
// one cell that matters untouched: editing a file whose format the model does
// NOT know sat at 20% (4/20) while the create-shaped equivalent hit 96%.
// Splitting the Harbor A/B tasks by whether the akm arm ever called a tool put
// a number on why a third rewording is not the answer — mean paired reward
// delta was -0.011 on the 29 tasks where no akm_* tool was called and +0.561 on
// the 19 where one was. Injected context is worth approximately zero; a tool
// call is worth everything. So this is the first akm behaviour that removes the
// wrong action instead of adding an argument for the right one: when a file the
// session READ declares a format the stash documents and that asset has not
// been opened this session, the first edit/write to it throws, and the model
// receives the gate message as the edit tool's error result. Under the shipped
// default (`observe`) that last step is recorded and not taken — see
// resolveWriteGateMode().
// "invalid" is a resolved state of the setting, not a mode anyone can ask for:
// it is what an unrecognized AKM_WRITE_GATE value becomes so the misconfiguration
// travels all the way into the ledger instead of dissolving into a default.
type GateMode = "off" | "observe" | "enforce" | "invalid"
// The raw value that failed to resolve, kept only so the once-per-process warn
// below can quote what the operator actually typed.
let writeGateInvalidValue: string | undefined
export function resolveWriteGateMode(raw: string | undefined): GateMode {
  writeGateInvalidValue = undefined
  const v = (raw ?? "").trim().toLowerCase()
  // Unset ships as `observe`: ledger-only, no behaviour change. #99 measured
  // the problem; it did not measure this gate's effect on reward, and the
  // promotion to `enforce` is a decision a train-slice histogram of `write_gate`
  // reasons has to justify. Defaulting to `enforce` would have inverted the
  // agreed rollout by making stage 2 the thing that ships.
  if (!v) return "observe"
  if (v === "off" || v === "0") return "off"
  if (v === "observe") return "observe"
  if (v === "enforce" || v === "1") return "enforce"
  // Never silently fall back to a default. A typo here (`enfroce`, `on`, `true`)
  // would otherwise produce a histogram in a mode nobody chose, which is the
  // failure this whole feature's ledger exists to make impossible. Same
  // treatment as apply_patch below — one loud warning per process plus a typed
  // skip on every watched call — and it refuses to run rather than guessing.
  writeGateInvalidValue = raw
  return "invalid"
}
// `let`, not `const`, only so __resetWriteGateForTests() can re-read the env:
// one process runs every test, and a mode captured at import would pin the
// first test's env for all of them. Nothing in the plugin reassigns it.
let AKM_WRITE_GATE: GateMode = resolveWriteGateMode(process.env.AKM_WRITE_GATE)
const WRITE_GATE_HEAD_BYTES = 4096
// Raised from 750 when the identity search moved from an in-process library call
// (~2 ms warm) to the public `akm search` CLI (~450-550 ms, mostly process
// start-up, measured on akm-cli 0.9.30): 750 left too little margin and would
// have turned a loaded machine into a silently fail-open gate.
const WRITE_GATE_RESOLVE_TIMEOUT_MS = 2000
const WRITE_GATE_INFLIGHT_WAIT_MS = 400
const WRITE_GATE_DESC_CHARS = 240
const WRITE_GATE_MESSAGE_CHARS = 600
const WRITE_GATE_SESSION_PATH_CAP = 64
const WRITE_GATE_IDENTITY_CACHE_CAP = 256
// A negative resolution is a statement about the stash at one instant, and the
// stash changes under a live session — `akm import`, `akm clone`, a sync that
// lands the very asset the gate would have pointed at. The first version cached
// "no" for the life of the process, which outlives many sessions, so a token
// that started resolving five minutes later could never resolve again. Positive
// resolutions stay permanent: an asset that exists keeps existing, and a
// drifted one-line description is not worth re-running a search for.
const WRITE_GATE_NEGATIVE_TTL_MS = 5 * 60 * 1000

// --- write gate: state (#99) ------------------------------------------------
// The four maps below are per-session, keyed by OpenCode sessionID exactly like
// sessionHints et al, and torn down in clearSessionState() — the file's single
// teardown point.

// What a `read` told us about one file. Recorded even when it declared NOTHING,
// because "read it, no declaration" and "never read it" are different answers
// and the gate has to be able to say which one it is.
type FileObservation = {
  tokens: string[]
  // False when the read output did not carry the envelope this module parses —
  // see readOutputRecognized(). Only consulted when `tokens` is empty.
  recognized: boolean
}
const sessionFileIdentity = new Map<string, Map<string, FileObservation>>()
const sessionGateLatched = new Map<string, Set<string>>()
const sessionShownRefs = new Map<string, Set<string>>()

// Paths this session CREATED. Permanent for the life of the session, and the
// reason it has to be permanent is the whole of the #99 round-3 defect: the
// previous insulation was "the gate only acts where a `read` observed the
// file", which held right up until the model VERIFIED ITS OWN OUTPUT. Write
// /app/service.yaml, read it back, fix it up — the read-back writes an
// observation for a path this session invented, the gate re-arms, and the
// blocked edit lands in the middle of the fictional-create (96%) and real-create
// (29%) cells whose attribution the create/edit split exists to protect.
// Reproduced end to end against enforce mode before this map existed.
const sessionCreatedPaths = new Map<string, Set<string>>()

type Resolution =
  // `cause` splits the two answers the first version collapsed into one word:
  // the search returned NOTHING for this token (the stash has no such asset, or
  // the index is stale/empty) versus it returned hits and none of them DECLARED
  // the format (the ranker generated candidates, the classifier rejected them
  // all). Those are a coverage problem and a precision problem respectively, and
  // a histogram that cannot separate them cannot be acted on.
  //
  // #99 review, blocker A: while hyphenated and dotted tokens were structurally
  // unmatchable, every one of them landed in the precision bucket — so the
  // highest-volume bucket of the stage-1 histogram was mis-labelled, and that
  // histogram is the instrument the promote-to-enforce decision reads. The
  // matcher is fixed; the bucket is renamed to say what it now means.
  | { status: "resolved"; ref: string; description: string }
  | { status: "none"; cause: "no-search-hits" | "no-declaration" }
  | { status: "error"; reason: "search-timeout" | "search-error" }

// Process-wide, not per-session: a format token resolves to the same asset for
// every session in the process, and caching the NEGATIVE and ERROR answers too
// is what keeps a miss at one query per process instead of one per edit. The
// negative and error entries expire (WRITE_GATE_NEGATIVE_TTL_MS); a resolved
// one never does.
type CacheEntry = { resolution: Resolution; expiresAt: number }
const identityCache = new Map<string, CacheEntry>()
const identityInflight = new Map<string, Promise<Resolution>>()

// The ONLY read path into identityCache. Expiry is evaluated on read rather
// than on a timer so nothing has to hold the process open, and the entry is
// deleted on the way out so the next `read` of a file declaring that token
// re-warms it.
function cachedResolution(token: string): Resolution | undefined {
  const entry = identityCache.get(token)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    identityCache.delete(token)
    return undefined
  }
  return entry.resolution
}

// Inert-latch bookkeeping. Without it this feature can ship completely dead —
// every ledger event still looks healthy, because "no event" is exactly what a
// broken read-output parse produces. See the session.deleted warn below.
let gateEverActed = false
let gateWatchedInvocations = 0
let gateInertWarned = false
let applyPatchWarned = false
let writeGateModeWarned = false
const gateSkipReasons = new Map<string, number>()

type GateReason =
  | "disabled"
  | "invalid-mode"
  | "apply-patch-unsupported"
  | "no-file-path"
  | "create-not-edit"
  // This session CREATED this path earlier in the session, so every later write
  // to it — including one that follows a read-back of the model's own output —
  // is create work, not an edit to pre-existing content. Deliberately its own
  // word rather than folded into `file-not-read`: an analyst filtering the
  // stage-1 histogram has to be able to prove the create cells are insulated,
  // and "no read record" and "we watched this session invent the file" are
  // different claims (#99 review round 3).
  | "session-created"
  | "latched"
  // The three causes the single `no-identity` used to conflate, in the order
  // the gate can tell them apart: the session never read this file / it read it
  // and our parser did not recognize the output / it read it and the file
  // declares no format authority. Only the last one is the correct-at-zero
  // real-tool cell; the middle one is the parse bug stage 1 exists to catch.
  | "file-not-read"
  | "read-output-unrecognized"
  | "no-identity"
  | "resolution-pending"
  | "no-search-hits"
  // "hits came back and not one of them DECLARED the format". Named for what it
  // now means: while hyphenated/dotted tokens were unmatchable this bucket also
  // collected every structurally-dead token, so the busiest bar of the stage-1
  // histogram measured a matcher bug rather than a precision result (#99 review,
  // blocker A).
  | "no-declaring-asset"
  | "search-timeout"
  | "search-error"
  | "already-shown"
  | "observe"
  | "fired"

export type GateDecision = { filePath: string; token: string; ref: string; description: string }

// Test-only: drop the process-wide inert-latch counters and re-read
// AKM_WRITE_GATE from the env. One process runs the whole suite, so a cache or
// a mode captured by the first test would otherwise decide the rest.
// Deliberately does NOT touch the session-keyed maps: those are torn down by
// clearSessionState() on session.deleted, and one test drives the gate against
// an identity recorded before the caches were dropped.
export function resetWriteGateForTests(): void {
  AKM_WRITE_GATE = resolveWriteGateMode(process.env.AKM_WRITE_GATE)
  identityCache.clear()
  identityInflight.clear()
  gateSkipReasons.clear()
  gateEverActed = false
  gateWatchedInvocations = 0
  gateInertWarned = false
  applyPatchWarned = false
  writeGateModeWarned = false
  gateLedgerWriteWarned = false
}

// --- write gate: pure functions (#99) ---------------------------------------

// Kubernetes' own built-in API groups, the two generic schema hosts, and the
// code-hosting/CDN labels that serve OTHER people's schemas. Every one of these
// identifies a format the model already knows or a host that is not an
// authority at all, so letting them through would spend a blocked edit on
// nothing. This is a public, principled exclusion list, not a fit to any
// benchmark corpus. `json-schema` / `schemastore` appear alongside their `.org`
// forms because the URL reduction below strips the TLD before the stoplist is
// consulted; the hosting labels are the residual guard for the case where BOTH
// halves of a schema URL are generic (`.../schema.json` on raw.githubusercontent
// .com), which names nothing and must therefore yield nothing.
const WRITE_GATE_IDENTITY_STOPLIST = new Set([
  "core", "apps", "batch", "policy", "rbac", "networking", "storage", "node", "events", "discovery",
  "json-schema.org", "json-schema", "schemastore.org", "schemastore",
  "githubusercontent", "github", "gitlab", "bitbucket", "sourceforge",
  "jsdelivr", "unpkg", "amazonaws", "cloudfront", "googleapis",
])

// Schema-document filenames that name the file's ROLE for its publisher rather
// than the format it describes. When the path stem is one of these the domain
// is the more specific half of the URL, which is the only case the host label
// is read at all.
const WRITE_GATE_GENERIC_SCHEMA_STEMS = new Set([
  "schema", "schemas", "config", "configuration", "settings", "index", "main", "default",
])

// A file that DOCUMENTS a format is not a file IN that format.
//
// #99 review: extractFormatIdentity() scanned the first 4KB of ANY file with no
// type restriction, so a README quoting `apiVersion: inkwell/v2` in an example
// declared inkwell — and the gate then told the user, about their README, that
// "this file declares inkwell". Wrong file, false assertion, blocked edit.
// Excluded by extension because that is exactly where the quoting happens: an
// example lives in a doc, and a doc is named like one. Deliberately NOT
// code-fence tracking — fences are a markdown construct, so excluding the
// markdown subsumes it, and a second mechanism for the same case is a second
// thing to keep correct.
const WRITE_GATE_PROSE_EXTENSIONS = new Set([
  ".md", ".markdown", ".mdx", ".rst", ".txt", ".adoc", ".asciidoc",
])

// `/` is permitted because the apiVersion extractor emits the WHOLE declared
// string (`inkwell/v2`) as its most specific key. The classifier compares whole
// normalized fields, so a slashed or dotted key is matchable; it is only the
// old segment-splitting matcher that made them structurally dead (#99 review,
// blocker A).
const WRITE_GATE_TOKEN_RE = /^[a-z0-9][a-z0-9._/-]{2,63}$/

// A number is not a format identity. `v1` was the only shape this caught, which
// is why the XML root-namespace extractor emitted `4.0.0` for a maven pom and
// `2003` for an msbuild project — a version and a year, offered to the user as
// the name of their file's format (#99 review, blocker B).
const WRITE_GATE_VERSION_RE = /^v?\d+(\.\d+)*$/

/**
 * Reduce a $schema value to the ONE token that identifies the schema itself.
 *
 * #99 review: the first version read the registrable host label FIRST, so a
 * compose file carrying
 * `# yaml-language-server: $schema=https://raw.githubusercontent.com/compose-spec/compose-spec/master/schema/compose-spec.json`
 * reduced to `githubusercontent` — a CDN, not a schema authority, and nonsense
 * as a stash query. The rule this module states is "a file that names its own
 * schema AUTHORITY is telling you where to look", so read the most specific
 * self-naming part first: the schema DOCUMENT's own name
 * (compose-spec.json -> `compose-spec`, ./schemas/inkwell.schema.json ->
 * `inkwell`), and fall back to the publishing DOMAIN only when the document
 * name is generic and therefore names nothing
 * (https://opencode.ai/config.json -> `opencode`). Generic on both halves
 * reduces to nothing at all, which is the honest answer.
 */
function reduceSchemaReference(raw: string): string | undefined {
  const value = raw.replace(/^["']|["'],?$/g, "").trim()
  if (!value) return undefined
  const urlMatch = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)([^?#]*)/i.exec(value)
  const pathPart = urlMatch ? urlMatch[2]! : value.split(/[?#]/)[0]!
  const base = pathPart.split("/").filter(Boolean).pop() ?? ""
  const stem = (base.split(".")[0] ?? "").toLowerCase()
  if (stem && !WRITE_GATE_GENERIC_SCHEMA_STEMS.has(stem)) return stem
  if (!urlMatch) return undefined
  const host = urlMatch[1]!.split("@").pop()!.split(":")[0]!
  const labels = host.split(".").filter(Boolean)
  if (labels.length === 0) return undefined
  return labels.length >= 2 ? labels[labels.length - 2] : labels[0]
}

/**
 * Extract the format-identity tokens a file DECLARES ABOUT ITSELF from the head
 * of its content.
 *
 * Exactly four extractors, one per way a file can name the authority for its
 * OWN format: an `apiVersion:` namespace, a `# yaml-language-server: $schema=`
 * pragma, a `$schema` key, and an XML root namespace.
 *
 * The exclusion below is the load-bearing half of this function. Filename and
 * extension conventions (docker-compose.yml, Dockerfile, *.tf) and
 * namespaced-looking values in non-identity keys (`image: worker:v3.0.1`,
 * `model: opencode/bigpickle`) are DELIBERATELY NOT extractors. That exclusion
 * is the entire reason the gate cannot raise the real/known-tool edit cell,
 * which measured 0/35 in the #99 A/B and is CORRECT at zero — the model knows
 * docker compose, and blocking an edit to consult a stash there is wasted work.
 * The product rule underneath: a file that names its own schema authority is
 * telling you where to look; a file identified only by a well-known filename is
 * one the model already knows.
 */
export function extractFormatIdentity(head: string, filePath?: string): string[] {
  if (typeof head !== "string" || !head) return []
  // See WRITE_GATE_PROSE_EXTENSIONS: prose describes formats, it does not
  // declare one.
  if (typeof filePath === "string" && WRITE_GATE_PROSE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return []
  // opencode's `read` wraps file bodies as
  // `<path>…</path>\n<type>file</type>\n<content>\n1: …` (verified against the
  // installed 1.18 binary), so scan only past <content> when present.
  const contentAt = head.indexOf("<content>")
  const body = (contentAt >= 0 ? head.slice(contentAt + "<content>".length) : head).slice(0, WRITE_GATE_HEAD_BYTES)
  const raw: string[] = []
  for (const rawLine of body.split("\n")) {
    // `read` prefixes EVERY line with its line number (`1: apiVersion:
    // inkwell/v2`). Dropping this strip is the cheapest way to ship a plugin
    // that is plausibly, silently inert — no token, no event, no gate, clean
    // logs. Guarded by a dedicated test against a captured trajectory string.
    const line = rawLine.replace(/^\s*\d+:\s?/, "")

    const apiVersion = /^\s*apiVersion:\s*["']?([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/.exec(line)
    if (apiVersion) {
      const namespace = apiVersion[1]!
      // Stoplisted on the NAMESPACE, before the keys are built. `apps` is on the
      // list but `apps/v1` is not, so checking only the finished tokens would
      // let Kubernetes' own API groups straight back in through the specific
      // key.
      if (WRITE_GATE_IDENTITY_STOPLIST.has(namespace.toLowerCase())) continue
      // Most specific FIRST, and never reduced ahead of the search: `inkwell/v2`
      // is what the file actually declares, `inkwell` is the fallback, and
      // gateDecision takes the first key that resolves.
      //
      // The old first-dot-label push (platform.acme.com -> `platform`) is gone.
      // It existed only because the segment-splitting matcher could never match
      // a dotted token; the classifier now compares whole normalized fields, so
      // `platform.acme.com` is matchable directly and the lossy reduction has no
      // job left. Keeping it would keep manufacturing generic English words —
      // `platform`, `monitoring`, `networking` — and offering them to the user
      // as the name of their file's format (#99 review, blockers A and C).
      raw.push(`${namespace}/${apiVersion[2]!}`)
      raw.push(namespace)
      continue
    }

    const yamlLanguageServer = /^\s*#\s*yaml-language-server:\s*\$schema=(\S+)/.exec(line)
    if (yamlLanguageServer) {
      raw.push(reduceSchemaReference(yamlLanguageServer[1]!) ?? "")
      continue
    }

    const schemaKey = /^\s*["']?\$schema["']?\s*[:=]\s*["']?(\S+)/.exec(line)
    if (schemaKey) {
      raw.push(reduceSchemaReference(schemaKey[1]!) ?? "")
      continue
    }

    // XML root only, and only the DEFAULT namespace, and only through the same
    // reduction every other extractor uses.
    //
    // #99 review, blocker B: this extractor took the LAST path segment of the
    // namespace URI raw. Probed against real files that produced `4.0.0` for a
    // maven pom, `2003` for an msbuild project and `android` for an Android
    // layout — a version, a year and an operating system, each offered to the
    // user as the name of their file's format. Two fixes, both structural:
    //   - `xmlns:foo=` is a PREFIX binding for a vocabulary the document
    //     BORROWS (an Android layout borrows the android namespace; its own
    //     format is the layout schema). Only a default `xmlns=` names the
    //     document's own format, so only that one is read. This is what kills
    //     `android`, and it kills it by meaning rather than by denylist.
    //   - the URI goes through reduceSchemaReference(), so the version-shaped
    //     stems fall to WRITE_GATE_VERSION_RE instead of being pushed verbatim.
    //     A pom therefore declares NOTHING, which is the honest answer: nothing
    //     in that URI names the format in a way a stash query could use.
    if (/^\s*<[A-Za-z_]/.test(line)) {
      const xmlns = /(?:^|\s)xmlns\s*=\s*["']([^"']+)["']/.exec(line)
      if (xmlns) {
        raw.push(reduceSchemaReference(xmlns[1]!) ?? "")
        continue
      }
    }

    // DROPPED, #99 review: `[tool.<name>]` in pyproject.toml and a
    // `#!/usr/bin/env <interp>` shebang were extractors here and neither one is
    // a schema authority. `[tool.ruff]` names a TOOL that reads a section of a
    // file whose format is PEP 518's, and `tsx` names an INTERPRETER, not the
    // format of the script it runs. Both violated the rule this function is
    // built on — a file that names its own schema authority is telling you
    // where to look — so the rule and the code now agree instead of the rule
    // being aspirational. The four that remain (apiVersion, a
    // yaml-language-server pragma, a `$schema` key, an XML root namespace) each
    // name the authority for the WHOLE file.
  }

  const out: string[] = []
  for (const candidate of raw) {
    const token = candidate.toLowerCase()
    if (!WRITE_GATE_TOKEN_RE.test(token)) continue
    if (WRITE_GATE_VERSION_RE.test(token)) continue
    if (WRITE_GATE_IDENTITY_STOPLIST.has(token)) continue
    if (out.includes(token)) continue
    out.push(token)
    if (out.length === 3) break
  }
  return out
}

/**
 * Did this `read` result carry the envelope extractFormatIdentity() is written
 * against?
 *
 * #99 review: the ledger reason `no-identity` conflated three different things,
 * and one of them was the bug stage 1 exists to catch. "The session never read
 * this file", "the file declares no format authority" (the real/known-tool
 * cell, correct at zero) and "our parser did not recognize what `read`
 * returned" all produced the same word, so the histogram could not tell a
 * correct zero from a broken parse — the exact failure mode where every other
 * signal still looks healthy. This is the third cause, made checkable: opencode
 * 1.18 `read` returns `<path>…</path>\n<type>file</type>\n<content>\n1: …`,
 * so an output with no `<content>` marker is one this parser was not written
 * for, whatever else it may be.
 */
export function readOutputRecognized(head: unknown): boolean {
  return typeof head === "string" && head.includes("<content>")
}

/**
 * Normalize an identity field the way akm's own indexer normalizes a tag:
 * hyphen/underscore to space, case folded, whitespace collapsed — and `/` and
 * `.` preserved verbatim. Preserving those two is the whole of the blocker-A
 * fix: the previous matcher split fields on /[^a-z0-9]+/ and compared segments,
 * so a needle containing `/` or `.` could never equal any segment and a needle
 * containing `-` could never equal one either. `compose-spec` — the single
 * largest product of reduceSchemaReference(), the decision-4 headline fix — was
 * therefore unmatchable against an asset literally named `compose-spec`.
 */
function normalizeIdentityField(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()
}

/**
 * The classifier, deliberately separate from the ranker.
 *
 * akmSearch is a candidate GENERATOR: it will happily return `signwell-automation`
 * for the query "inkwell" with a high score, because that is what a relevance
 * ranker is for. Blocking an edit on that would be a false positive that costs a
 * real user a real round-trip, so the decision to block is made here.
 *
 * The rule is DECLARATION, not mention: a hit authorizes the gate only when the
 * asset's whole normalized `name` equals the whole normalized key. One field,
 * one comparison, no second way in.
 *
 * #99 review, blocker C: the rule before this one was word-membership across
 * ref/name/tags, and akm SYNTHESIZES tags from the title slug when frontmatter
 * supplies none — `knowledge/presence-svg-animation-complexity` carries
 * ["presence","svg","animation","complexity"] with no `tags:` of its own. So
 * "does a top-5 asset carry this word as a tag" degenerated into "does its title
 * contain this word", which is the fuzzy match this function's contract says it
 * excludes. Measured against a real 23k-entry stash, that rule fired on 15 of 34
 * single-word tokens real files produce, every one of them wrong.
 *
 * #99 review round 3: narrowing that to "an AUTHORED tag" was not enough, and
 * for a reason the authored/synthesized split cannot reach — a hand-written tag
 * is a TOPIC label, so an asset about jamstack storefronts genuinely carries
 * `vercel`, and an asset about catalog import/export genuinely carries `xml`.
 * Both tags are authored and neither is a claim to BE that format. Measured
 * against the same real stash, the tag clause was the sole authorizer on every
 * remaining false fire — `vercel`/`netlify` -> jamstack-storefront, `xml` -> two
 * Salesforce/catalog assets, `jest` -> a mocking memory, `rollup` -> a bundling
 * memory — so the clause is gone rather than narrowed again. The benchmark's own
 * true positive does not need it: the key ladder emits `inkwell/v2` and then
 * `inkwell`, and the fixture asset is NAMED `inkwell`, so it resolves on the
 * fallback key (measured against harbor/stashes/inkwell, not argued).
 *
 * Never reads hit.score, hit.description, hit.tags or hit.ref. Score is the
 * ranker's output and reading it re-couples the two. A description branch is how "the
 * inkwell format" in prose smuggles a fuzzy match back in. `ref` is a PATH: its
 * interior segments are containers the author chose for filing, so
 * `.../docker-homelab/references/networking` would authorize the gate for every
 * file declaring `networking.k8s.io/v1`. The ref is still what the gate message
 * cites — it is just not evidence.
 */
export function assetDeclaresFormat(key: string, hit: { name?: string }): "name" | null {
  const needle = typeof key === "string" ? normalizeIdentityField(key) : ""
  if (!needle) return null
  const name = typeof hit?.name === "string" ? hit.name : ""
  return name && normalizeIdentityField(name) === needle ? "name" : null
}

/**
 * The asset's one-line description is inlined ON PURPOSE. It is already in the
 * search hit (free), and it is what manufactures the experience of uncertainty
 * that prompt sentences could not: the #99 trajectory failed because a file it
 * could already read made the task feel self-sufficient. Belt and braces — a
 * model that refuses the gate and simply retries the edit may still have been
 * handed the answer. Do NOT trim it to "force" a tool call: reward is the
 * objective, engagement is only the proxy.
 */
export function formatGateMessage(filePath: string, token: string, ref: string, description: string): string {
  const build = (desc: string) => {
    const cited = desc ? ` — "${desc}"` : ""
    return `AKM: ${filePath} declares \`${token}\`. Your bundle documents this format at \`${ref}\`${cited}.`
      + ` You have not opened it this session. Call akm_show with ref "${ref}", then repeat this edit.`
      + " This gate fires once per file per session; repeating this edit unchanged will proceed."
  }
  const trimmed = description.replace(/\s+/g, " ").trim().slice(0, WRITE_GATE_DESC_CHARS)
  let message = build(trimmed)
  if (message.length > WRITE_GATE_MESSAGE_CHARS) {
    // Shrink the flexible part (the description) before touching the
    // instruction; the trailing "call akm_show / retry" sentence is the whole
    // point of the message and must survive a long path or ref.
    const overflow = message.length - WRITE_GATE_MESSAGE_CHARS
    message = build(trimmed.slice(0, Math.max(0, trimmed.length - overflow)))
  }
  return message.length > WRITE_GATE_MESSAGE_CHARS ? `${message.slice(0, WRITE_GATE_MESSAGE_CHARS - 1)}…` : message
}

// --- write gate: resolution (#99) -------------------------------------------

function rememberResolution(token: string, resolution: Resolution): Resolution {
  if (identityCache.size >= WRITE_GATE_IDENTITY_CACHE_CAP) {
    const oldest = identityCache.keys().next()
    if (!oldest.done) identityCache.delete(oldest.value)
  }
  identityCache.set(token, {
    resolution,
    expiresAt: resolution.status === "resolved" ? Number.POSITIVE_INFINITY : Date.now() + WRITE_GATE_NEGATIVE_TTL_MS,
  })
  return resolution
}

const WRITE_GATE_TIMEOUT = Symbol("akm-write-gate-timeout")

function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof WRITE_GATE_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof WRITE_GATE_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(WRITE_GATE_TIMEOUT), ms)
    // Never hold the process open for a gate timer.
    ;(timer as { unref?: () => void }).unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * Resolve one format token to the stash asset that documents it. Memoized on
 * identityCache and de-duped through identityInflight, so a session that reads
 * six inkwell files costs one search. Uses the public `akm search` CLI the
 * akm_search tool calls; `warmIndexInBackground()` already ran at
 * session.created, so a warm local search is ~130ms against a multi-second
 * model round-trip. Never rejects.
 */
async function resolveIdentity(host: GateHost, token: string): Promise<Resolution> {
  const cached = cachedResolution(token)
  if (cached) return cached
  const inflight = identityInflight.get(token)
  if (inflight) return inflight

  const pending = (async (): Promise<Resolution> => {
    try {
      const raced = await raceWithTimeout(
        // This search is the PLUGIN's, not the model's. Attribute it to a non-user
        // event source (`AKM_EVENT_SOURCE=audit`) so akm's utility scores and
        // feedback ranking do not count it as demand, which would contaminate
        // the treatment arm of an observe-mode rollout. The model-initiated
        // akm_search tool deliberately stays attributed to the user.
        host.search(token),
        WRITE_GATE_RESOLVE_TIMEOUT_MS,
      )
      if (raced === WRITE_GATE_TIMEOUT) return rememberResolution(token, { status: "error", reason: "search-timeout" })
      const hits = Array.isArray((raced as GateSearchResponse | undefined)?.hits) ? (raced as GateSearchResponse).hits! : []
      for (const hit of hits) {
        if (!assetDeclaresFormat(token, hit as { name?: string })) continue
        const ref = typeof hit.ref === "string" ? hit.ref : ""
        if (!ref) continue
        return rememberResolution(token, {
          status: "resolved",
          ref,
          description: typeof hit.description === "string" ? hit.description : "",
        })
      }
      return rememberResolution(token, { status: "none", cause: hits.length === 0 ? "no-search-hits" : "no-declaration" })
    } catch (error: unknown) {
      host.log("warn", "AKM write gate resolution failed", {
        subsystem: "write-gate",
        token,
        error: host.formatError(error),
      })
      return rememberResolution(token, { status: "error", reason: "search-error" })
    } finally {
      identityInflight.delete(token)
    }
  })()
  // Only register as in-flight if it is actually still in flight: a synchronous
  // throw from akmSearch settles `pending` before this line runs, and parking a
  // settled promise here would leave a Map entry nothing ever clears.
  if (!cachedResolution(token)) identityInflight.set(token, pending)
  return pending
}

// --- write gate: session bookkeeping (#99) ----------------------------------

function resolveGatePath(directory: string | undefined, filePath: string): string {
  return path.resolve(directory ?? process.cwd(), filePath)
}

// Records the observation even when it found no tokens: an entry here is the
// evidence that this session SAW this file's pre-existing content, which is what
// the gate's create/edit distinction turns on, and the empty-token case is also
// what separates "declares nothing" from "never read".
function noteFileIdentity(sessionID: string | undefined, absPath: string, observation: FileObservation): void {
  if (!sessionID) return
  const perFile = sessionFileIdentity.get(sessionID) ?? new Map<string, FileObservation>()
  if (!perFile.has(absPath) && perFile.size >= WRITE_GATE_SESSION_PATH_CAP) {
    const oldest = perFile.keys().next()
    if (!oldest.done) perFile.delete(oldest.value)
  }
  perFile.set(absPath, observation)
  sessionFileIdentity.set(sessionID, perFile)
}

export function noteShownRefs(sessionID: string | undefined, refs: string[]): void {
  if (!sessionID || refs.length === 0) return
  const shown = sessionShownRefs.get(sessionID) ?? new Set<string>()
  for (const ref of refs) {
    if (!shown.has(ref) && shown.size >= WRITE_GATE_SESSION_PATH_CAP) {
      const oldest = shown.values().next()
      if (!oldest.done) shown.delete(oldest.value)
    }
    shown.add(ref)
  }
  sessionShownRefs.set(sessionID, shown)
}

/**
 * Is this call the session AUTHORING content at `absPath` rather than editing
 * content that was already there?
 *
 * Two shapes, and they are discriminated differently because the tools offer
 * different evidence. `write` carries {filePath, content} and is byte-identical
 * for a create and for a full overwrite, so the discriminator cannot be the
 * inputs — it is `observed`: a write to a path this session never READ is a path
 * whose pre-existing content this session never saw, so nothing it reads back
 * afterwards can be anything but its own output. `edit` with an empty
 * `oldString` is opencode 1.18's own create-this-file form (it is rejected
 * outright on a file that already exists), which is input-level evidence and
 * needs no read record at all.
 */
function isSessionCreate(tool: string, args: Record<string, unknown>, observed: FileObservation | undefined): boolean {
  if (tool === "write") return !observed
  return tool === "edit" && args.oldString === ""
}

function noteSessionCreated(sessionID: string, absPath: string): void {
  const created = sessionCreatedPaths.get(sessionID) ?? new Set<string>()
  if (!created.has(absPath) && created.size >= WRITE_GATE_SESSION_PATH_CAP) {
    const oldest = created.values().next()
    if (!oldest.done) created.delete(oldest.value)
  }
  created.add(absPath)
  sessionCreatedPaths.set(sessionID, created)
}

function latchGate(sessionID: string, absPath: string): void {
  const latched = sessionGateLatched.get(sessionID) ?? new Set<string>()
  if (!latched.has(absPath) && latched.size >= WRITE_GATE_SESSION_PATH_CAP) {
    const oldest = latched.values().next()
    if (!oldest.done) latched.delete(oldest.value)
  }
  latched.add(absPath)
  sessionGateLatched.set(sessionID, latched)
}

/**
 * Record what a file the session just READ declares about its own format, and
 * warm the resolution for any token we have not seen. Fire-and-forget: the
 * search must never sit on a tool's return path.
 *
 * `read` is the only caller. #99 review: `write` output used to be an identity
 * source too, on the "write a file, then edit it" argument, and that is exactly
 * the write-then-revise CREATE trajectory — crediting it made a file the
 * session had just invented indistinguishable from one that already existed,
 * and put the gate inside the fictional-create (96%) and real-create (29%)
 * cells. Movement there could then no longer be read as noise, confounding
 * attribution across three of the four cells this change is measured through.
 *
 * Round 3: an observation is still recorded for a path the session created —
 * this function does not know, and should not have to know, which paths those
 * are. The insulation lives at the decision instead (sessionCreatedPaths), which
 * is what makes it survive the model reading back its own output.
 */
export function observeFileIdentity(
  host: GateHost,
  sessionID: string | undefined,
  directory: string | undefined,
  filePath: unknown,
  head: unknown,
  /** Did the host's read output have the shape `head` was extracted from? Defaults to V1's `<content>` envelope check. */
  recognized: boolean = readOutputRecognized(head),
): void {
  if (typeof filePath !== "string" || !filePath) return
  const tokens = extractFormatIdentity(typeof head === "string" ? head : "", filePath)
  noteFileIdentity(sessionID, resolveGatePath(directory, filePath), {
    tokens,
    recognized,
  })
  for (const token of tokens) {
    if (cachedResolution(token) || identityInflight.has(token)) continue
    void (async () => {
      try {
        await resolveIdentity(host, token)
      } catch {
        // resolveIdentity never rejects; belt-and-braces so a future change
        // cannot turn this into an unhandled rejection on the read path.
      }
    })()
  }
}

// --- write gate: decision (#99) ---------------------------------------------

// One loud complaint per process when the ledger itself cannot be written.
//
// #99 review: this is the one subsystem whose entire purpose IS the ledger, and
// appendMemoryEvent() returns {ok:false} rather than throwing — so a read-only
// state dir, a full disk or a bad mode produced an EMPTY histogram, which is
// byte-for-byte what "the gate never fired" looks like. The promote-to-enforce
// decision would then be made against a file nothing ever reached. Once per
// process, matching this file's existing convention for structural faults
// (applyPatchWarned, writeGateModeWarned): the condition is persistent, so
// repeating it on every write would bury everything else in the log.
let gateLedgerWriteWarned = false

function emitWriteGate(
  host: GateHost,
  input: { tool: string; sessionID?: string; callID?: string },
  directory: string | undefined,
  filePath: string | undefined,
  reason: GateReason,
  status: "ok" | "skipped" | "failed",
  refs?: string[],
  // The KEY that resolved, on the paths where one did. The key ladder tries
  // `inkwell/v2` before `inkwell`, so without this an analyst reading the
  // histogram cannot tell a specific declaration from a bare-namespace
  // fallback — and that is the difference between a strong hit and a coincidence.
  token?: string,
): void {
  if (status !== "ok") gateSkipReasons.set(reason, (gateSkipReasons.get(reason) ?? 0) + 1)
  const written = host.writeEvent({
    event: "write_gate",
    sessionId: input.sessionID,
    scope: buildEventScope(input.sessionID, directory, input.tool),
    input: { tool: input.tool, callID: input.callID, reason, mode: AKM_WRITE_GATE, filePath, token },
    refs,
    outcome: { status },
  })
  if (written.ok || gateLedgerWriteWarned) return
  gateLedgerWriteWarned = true
  host.log("error", "AKM write gate ledger write failed", {
    subsystem: "write-gate",
    sessionID: input.sessionID,
    reason,
    path: opencodeEventLog(),
    error: written.error,
    consequence: "write_gate events are being dropped; an empty stage-1 histogram is indistinguishable from a gate that never fired",
  })
}

/**
 * Decide whether this write-path tool call is blocked. Returns null for every
 * non-fire path.
 *
 * INVARIANT: every watched-tool invocation emits EXACTLY ONE `write_gate` event
 * with a named reason. There is no branch that declines to gate without leaving
 * a typed record of why, so a run where the #99 cell did not move is
 * diagnosable from the ledger alone — did the gate fire and get ignored, or did
 * it never fire? That distinction is the difference between a finding and a bug.
 */
export async function gateDecision(
  host: GateHost,
  input: { tool: string; sessionID: string; callID: string },
  output: { args?: unknown },
): Promise<GateDecision | null> {
  gateWatchedInvocations += 1
  const directory = typeof (input as { directory?: unknown }).directory === "string"
    ? (input as { directory?: string }).directory
    : undefined
  const args = (output?.args ?? {}) as Record<string, unknown>

  // Checked before "off" so a misconfiguration is never reported as a
  // deliberate kill switch. resolveWriteGateMode() refuses to guess; this is
  // where the refusal becomes visible on every watched call.
  if (AKM_WRITE_GATE === "invalid") {
    if (!writeGateModeWarned) {
      writeGateModeWarned = true
      host.log("error", "AKM write gate disabled: unrecognized AKM_WRITE_GATE value", {
        subsystem: "write-gate",
        sessionID: input.sessionID,
        value: writeGateInvalidValue,
        expected: "off | observe | enforce",
        reason: "an unrecognized value is a configuration error, not a request for the default mode",
      })
    }
    emitWriteGate(host, input, directory, undefined, "invalid-mode", "skipped")
    return null
  }
  if (AKM_WRITE_GATE === "off") {
    emitWriteGate(host, input, directory, undefined, "disabled", "skipped")
    return null
  }
  // apply_patch carries `patchText` and no `filePath`, so the gate is
  // STRUCTURALLY blind on the gpt-* model family. Parsing the patch envelope to
  // recover paths is deliberately out of scope; pretending the gate is live
  // there would be exactly the silent degradation this codebase forbids, so it
  // is one loud warning per process plus a typed skip on every call.
  if (input.tool === host.patchTool) {
    if (!applyPatchWarned) {
      applyPatchWarned = true
      host.log("warn", `AKM write gate inert for ${host.patchTool}`, {
        subsystem: "write-gate",
        toolName: input.tool,
        sessionID: input.sessionID,
        reason: `${host.patchTool} carries patchText and no ${host.pathKey}; the gate cannot resolve a target file`,
      })
    }
    emitWriteGate(host, input, directory, undefined, "apply-patch-unsupported", "skipped")
    return null
  }
  // `filePath` (not `path`) on edit/write/read — confirmed against the
  // installed opencode 1.18 tool schemas. A `path`-only args object must
  // produce this typed reason, not a crash and not a silent return.
  const targetPath = args[host.pathKey]
  if (typeof targetPath !== "string" || !targetPath) {
    emitWriteGate(host, input, directory, undefined, "no-file-path", "skipped")
    return null
  }
  const absPath = resolveGatePath(directory, targetPath)

  // #99 review: the create cells have to be insulated, and the discriminator
  // has to come from what these tools actually hand the hook.
  //
  //   edit  -> { filePath, oldString, newString }. `oldString` is a claim about
  //            text that must ALREADY be in the file. opencode 1.18 rejects an
  //            empty one outright on an existing file ("oldString cannot be
  //            empty when editing an existing file. Provide the exact text to
  //            replace, or use write for an intentional full-file replacement")
  //            and treats it as create-this-file otherwise. The inputs alone
  //            discriminate, so read them.
  //   write -> { filePath, content }. Byte-identical for a create and for a
  //            full overwrite; nothing in the inputs says whether the path
  //            existed a moment ago. The inputs CANNOT discriminate here.
  //
  // So the rule that holds for BOTH is not an input test but an evidence test:
  // gate only where this session has already observed the file's PRE-EXISTING
  // content. The oldString check is the extra, input-level create signal that
  // `edit` — and only `edit` — actually offers.
  //
  // #99 review round 3: reading that evidence off the CURRENT call was not
  // enough. "No read record for this path" is a fact about right now, and a
  // model that verifies its own output erases it — write /app/service.yaml,
  // read it back, then fix it up, and the read-back writes an observation for a
  // path this session invented. Reproduced in enforce mode: BLOCKED, on a create.
  // So the create is RECORDED when it happens and the record is what the gate
  // consults from then on, for the rest of the session.
  const observed = sessionFileIdentity.get(input.sessionID)?.get(absPath)
  if (isSessionCreate(input.tool, args, observed)) noteSessionCreated(input.sessionID, absPath)

  if (input.tool === "edit" && typeof args.oldString === "string" && args.oldString === "") {
    emitWriteGate(host, input, directory, absPath, "create-not-edit", "skipped")
    return null
  }

  if (sessionCreatedPaths.get(input.sessionID)?.has(absPath)) {
    emitWriteGate(host, input, directory, absPath, "session-created", "skipped")
    return null
  }

  if (sessionGateLatched.get(input.sessionID)?.has(absPath)) {
    emitWriteGate(host, input, directory, absPath, "latched", "skipped")
    return null
  }

  if (!observed) {
    // An edit to a file this session never opened and never wrote — the model
    // is editing from knowledge it got somewhere else. Creates no longer land
    // here; they land on `session-created` above. Zero cost, no I/O.
    emitWriteGate(host, input, directory, absPath, "file-not-read", "skipped")
    return null
  }
  const tokens = observed.tokens
  if (tokens.length === 0) {
    // The whole real/known-tool cell lands on `no-identity` — the file declares
    // no authority and that zero is correct. `read-output-unrecognized` is the
    // other thing that used to hide in that word: the read output was not the
    // shape this module parses, so the extractor could not have worked and a
    // clean-looking ledger would have been a lie.
    emitWriteGate(host, input, directory, absPath, observed.recognized ? "no-identity" : "read-output-unrecognized", "skipped")
    return null
  }

  let resolved: { token: string; resolution: Extract<Resolution, { status: "resolved" }> } | undefined
  let noneCause: "no-search-hits" | "no-declaration" | undefined
  let errorReason: "search-timeout" | "search-error" | undefined
  let pendingToken: string | undefined
  for (const token of tokens) {
    const cached = cachedResolution(token)
    if (cached?.status === "resolved") {
      resolved = { token, resolution: cached }
      break
    }
    // "hits came back, none declared it" is the more specific answer, so it wins
    // the report when a file declares several keys that miss for different
    // reasons.
    if (cached?.status === "none") { noneCause = cached.cause === "no-declaration" ? "no-declaration" : noneCause ?? cached.cause; continue }
    if (cached?.status === "error") { errorReason = cached.reason; continue }
    if (identityInflight.has(token)) pendingToken ??= token
  }

  if (!resolved && pendingToken) {
    // Bounded, and only ever awaits an ALREADY-RUNNING resolve started by the
    // read hook. It never STARTS one: a search on the blocking path would put
    // akm's latency in front of every edit the user makes.
    const inflight = identityInflight.get(pendingToken)
    if (inflight) {
      const raced = await raceWithTimeout(inflight, WRITE_GATE_INFLIGHT_WAIT_MS)
      if (raced !== WRITE_GATE_TIMEOUT && raced.status === "resolved") resolved = { token: pendingToken, resolution: raced }
      else if (raced !== WRITE_GATE_TIMEOUT && raced.status === "none") noneCause = raced.cause === "no-declaration" ? "no-declaration" : noneCause ?? raced.cause
      else if (raced !== WRITE_GATE_TIMEOUT && raced.status === "error") errorReason = raced.reason
    }
  }

  if (!resolved) {
    if (noneCause) {
      // "the search returned nothing" and "it returned hits and none of them
      // declared the format" are a coverage problem and a precision problem. One
      // word for both told the rollout nothing about which one to fix.
      emitWriteGate(host, input, directory, absPath, noneCause === "no-search-hits" ? "no-search-hits" : "no-declaring-asset", "skipped")
    } else if (errorReason) {
      emitWriteGate(host, input, directory, absPath, errorReason, "failed")
    } else {
      emitWriteGate(host, input, directory, absPath, "resolution-pending", "skipped")
    }
    return null
  }

  if (sessionShownRefs.get(input.sessionID)?.has(resolved.resolution.ref)) {
    emitWriteGate(host, input, directory, absPath, "already-shown", "skipped", [resolved.resolution.ref], resolved.token)
    return null
  }

  // Latch BEFORE returning the decision, so release is unconditional and
  // livelock is impossible by construction: the model can always get its edit
  // through by repeating it. A latch conditioned on compliance would be a trap.
  latchGate(input.sessionID, absPath)
  gateEverActed = true
  if (AKM_WRITE_GATE === "observe") {
    // Stage 1 of the rollout: everything runs, nothing is blocked, and the
    // would-fire count is readable off the ledger before an eval slice is spent.
    emitWriteGate(host, input, directory, absPath, "observe", "ok", [resolved.resolution.ref], resolved.token)
    return null
  }
  emitWriteGate(host, input, directory, absPath, "fired", "ok", [resolved.resolution.ref], resolved.token)
  return {
    filePath: targetPath,
    token: resolved.token,
    ref: resolved.resolution.ref,
    description: resolved.resolution.description,
  }
}

// Warn once per process if watched write tools were seen and the gate never
// acted on any of them. Every OTHER signal in this design looks healthy in that
// state — the events are all there, they just all say "skipped" — so without
// this the feature can ship dead and nobody notices.
export function warnIfWriteGateInert(host: GateHost): void {
  // Not a warning when the operator turned the gate off — "never acted" is the
  // requested behaviour there, not a symptom. Nor on `invalid`, which already
  // produced its own, louder error; a second warning would just bury it.
  if (AKM_WRITE_GATE === "off" || AKM_WRITE_GATE === "invalid") return
  if (gateInertWarned || gateEverActed || gateWatchedInvocations === 0) return
  gateInertWarned = true
  host.log("warn", "AKM write gate never acted", {
    subsystem: "write-gate",
    mode: AKM_WRITE_GATE,
    watchedInvocations: gateWatchedInvocations,
    skipReasons: Object.fromEntries(gateSkipReasons),
  })
}


/** Tear down every per-session map for a deleted session. */
export function clearGateSession(sessionID: string): void {
  sessionFileIdentity.delete(sessionID)
  sessionGateLatched.delete(sessionID)
  sessionShownRefs.delete(sessionID)
  sessionCreatedPaths.delete(sessionID)
}
