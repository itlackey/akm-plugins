// Memory harvest fidelity metric.
//
// At session end, the Claude hook reads its per-session buffer and
// invokes `akm remember --name claude-session-…` with the buffer
// contents (after a 2-entry trivial threshold). We replay each fixture
// session log through `capture-memory session-end`, then read the
// ACTUAL stdin the hook piped to akm (captured by the fake-akm shim)
// and score:
//
//   - captured: did `akm remember` get invoked? (binary per fixture)
//   - body_chars: size of the payload that was committed
//   - name_format_ok: does the memory name match the documented format
//     `claude-session-YYYYMMDD-<short-sid>`?
//   - secret_leakage_detected: does the captured payload contain
//     secret-shaped values (e.g. `KEY=non-empty-value`)? This is a
//     plugin-behavior observation, NOT an assertion of correctness:
//     vault values are protected by the akm CLI, but the plugin's
//     buffer captures raw user prompts including ones the user typed
//     by accident. A non-zero count here is a finding for the plugin
//     authors to consider scrubbing the buffer.
//
// What this metric used to claim and no longer does:
//   - "ref_coverage": removed. The captured body IS the buffer (the hook
//     pipes it untouched), so coverage was always 1.0 — a tautology.
//   - "vault_leaks: 0" against fixtures that contained no leak: removed
//     and replaced with the real test above.

import path from "node:path"
import { readFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs"
import { createSandbox } from "../../lib/stash-sandbox"
import { runClaudeHook } from "../harness/claude"
import { createOpenCodeHarness } from "../harness/opencode"
import { readCallLog, readStdinForCall } from "../../lib/fake-akm"
import type { MetricResult } from "../../lib/report"

export type MemoryOptions = {
  sessionLogsDir: string
  stashDir: string
}

// Match secret-shaped lines: KEY=non-trivial-value where value contains
// at least one non-whitespace character that isn't a placeholder. We
// explicitly allow `KEY=` (empty placeholder, common in seeded vaults)
// to avoid flagging the fixture stash itself.
const SECRET_VALUE_RE = /(?:^|\s)([A-Z][A-Z0-9_]{2,})=(?!\s|$)([^\s]{4,})/m

function findRememberCall(callLog: string): { name?: string; callId: string; body: string } | null {
  const calls = readCallLog(callLog)
  for (const call of calls) {
    if (!call.argv.includes("remember")) continue
    let name: string | undefined
    const nameIdx = call.argv.indexOf("--name")
    if (nameIdx >= 0 && call.argv[nameIdx + 1]) name = call.argv[nameIdx + 1]
    const body = readStdinForCall(callLog, call.callId) ?? ""
    return { name, callId: call.callId, body }
  }
  return null
}

const NAME_FORMAT_RE = /^claude-session-\d{8}-[a-zA-Z0-9_-]+$/

type Sample = {
  fixtureId: string
  capturedName: string | null
  bodyChars: number
  bodyHeadings: number
  trivial: boolean
  nameFormatOk: boolean
  secretLeakageDetected: boolean
  secretEvidence?: string
}

export async function runMemoryMetric(opts: MemoryOptions): Promise<MetricResult> {
  const fixtures = readdirSync(opts.sessionLogsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  const samples: Sample[] = []

  for (const fixture of fixtures) {
    const sandbox = createSandbox({ sourceStash: opts.stashDir })
    try {
      const fixtureDir = path.join(opts.sessionLogsDir, fixture)
      const files = readdirSync(fixtureDir).filter((f) => f.endsWith(".md") && f !== "README.md")
      if (files.length === 0) continue
      const bufferFile = files[0]
      const sid = bufferFile.replace(/\.md$/, "")
      const sessionsDir = path.join(sandbox.env.AKM_PLUGIN_STATE_DIR, "sessions")
      mkdirSync(sessionsDir, { recursive: true })
      const dest = path.join(sessionsDir, bufferFile)
      copyFileSync(path.join(fixtureDir, bufferFile), dest)

      runClaudeHook(["capture-memory", "session-end"], {
        input: JSON.stringify({ session_id: sid }),
        env: sandbox.env,
      })

      const remember = findRememberCall(sandbox.callLog)
      const body = remember?.body ?? ""
      const headings = body ? (body.match(/^## /gm) ?? []).length : 0
      const nameFormatOk = remember ? NAME_FORMAT_RE.test(remember.name ?? "") : true
      const leakMatch = body ? SECRET_VALUE_RE.exec(body) : null

      samples.push({
        fixtureId: fixture,
        capturedName: remember?.name ?? null,
        bodyChars: body.length,
        bodyHeadings: headings,
        trivial: remember === null,
        nameFormatOk,
        secretLeakageDetected: !!leakMatch,
        secretEvidence: leakMatch ? leakMatch[0].trim().slice(0, 60) : undefined,
      })
    } finally {
      sandbox.cleanup()
    }
  }

  const captured = samples.filter((s) => !s.trivial)
  const meanChars = captured.length > 0 ? Math.round(captured.reduce((a, s) => a + s.bodyChars, 0) / captured.length) : 0
  const trivialRate = samples.length === 0 ? 0 : samples.filter((s) => s.trivial).length / samples.length
  const nameFormatViolations = samples.filter((s) => !s.trivial && !s.nameFormatOk).length
  const secretLeakages = samples.filter((s) => s.secretLeakageDetected).length

  // OpenCode side: drive a synthetic session and verify `stop` triggers
  // a memory-subsystem log entry. The OpenCode plugin's memory capture
  // doesn't pipe through akm in the same way, so the assertion is
  // weaker — just "did the plugin emit a captured-memory log entry".
  let opencodeAvailable = true
  let opencodeCaptured = false
  let opencodeMemorySubsystemLogs = 0
  try {
    const sandbox = createSandbox({ sourceStash: opts.stashDir })
    try {
      const harness = await createOpenCodeHarness(sandbox.env)
      const sid = "memory-eval-1"
      await harness.curateAndExtract({ sessionID: sid, prompt: "Help me review the diff and remember the steps" })
      await harness.toolAfter({
        sessionID: sid,
        tool: "akm_show",
        toolArgs: { ref: "skill:code-review" },
        output: '{"ok":true,"ref":"skill:code-review","content":"..."}',
      })
      await harness.toolAfter({
        sessionID: sid,
        tool: "akm_show",
        toolArgs: { ref: "command:summarize-diff" },
        output: '{"ok":true,"ref":"command:summarize-diff","template":"..."}',
      })
      const before = harness.client.__logs.length
      await harness.hooks.stop({ sessionID: sid })
      const after = harness.client.__logs.slice(before)
      opencodeMemorySubsystemLogs = after.filter((l) => l.extra?.subsystem === "memory" && (l.message ?? "").includes("captured")).length
      opencodeCaptured = opencodeMemorySubsystemLogs > 0
    } finally {
      sandbox.cleanup()
    }
  } catch (err) {
    opencodeAvailable = false
    console.error(`! OpenCode memory harness failed: ${(err as Error).message}`)
  }

  return {
    name: "memory",
    values: {
      n: samples.length,
      claude_captured: samples.length - samples.filter((s) => s.trivial).length,
      claude_avg_body_chars: meanChars,
      claude_trivial_rate: trivialRate,
      claude_name_format_violations: nameFormatViolations,
      claude_secret_leakages: secretLeakages,
      opencode_available: opencodeAvailable,
      opencode_captured: opencodeCaptured,
      opencode_memory_logs: opencodeMemorySubsystemLogs,
      per_fixture: samples,
    },
    table: {
      headers: ["fixture", "captured?", "body chars", "name format", "secret leakage?"],
      rows: samples.map((s) => [
        s.fixtureId,
        s.trivial ? "no (trivial)" : "yes",
        s.bodyChars,
        s.trivial ? "—" : (s.nameFormatOk ? "ok" : "WRONG"),
        s.secretLeakageDetected ? `LEAK: ${s.secretEvidence}` : "—",
      ]),
    },
    notes: [
      `Sparse fixtures (< 2 buffer entries) are expected to be trivial-rate dropped.`,
      `claude_secret_leakages > 0 means the plugin committed a buffer containing a secret-shaped value (e.g. KEY=value). This is a finding about the plugin's lack of buffer scrubbing — vault values stored via the akm CLI are protected, but raw user prompts captured into the buffer are not.`,
    ],
  }
}
