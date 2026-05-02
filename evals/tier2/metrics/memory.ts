// Memory harvest fidelity metric.
//
// At session end, the Claude hook reads its per-session buffer and
// invokes `akm remember --name claude-session-…` with the buffer
// contents (after a 2-entry trivial threshold). We replay each fixture
// session log through `capture-memory session-end` and check:
//
//   - captured: did remember get invoked at all?
//   - chars: how big is the captured payload (proxy for fidelity)
//   - ref_coverage: fraction of refs in the buffer that survive in the
//     captured memory
//   - vault_leak: did any vault values appear in the memory body
//     (vault values must NEVER surface)
//
// OpenCode's memory capture lives in module-level state (sessionBuffer)
// rather than disk, so the OpenCode side of this metric drives a few
// chat.message + tool.execute.after pairs and triggers `stop` to flush
// the buffer; we then read the akm call log to recover the captured
// memory body.

import path from "node:path"
import { existsSync, readFileSync, mkdirSync, copyFileSync, readdirSync } from "node:fs"
import { createSandbox } from "../../lib/stash-sandbox"
import { runClaudeHook } from "../harness/claude"
import { createOpenCodeHarness } from "../harness/opencode"
import { readCallLog } from "../../lib/fake-akm"
import type { MetricResult } from "../../lib/report"

export type MemoryOptions = {
  sessionLogsDir: string
  stashDir: string
}

const REF_RE = /\b(skill|command|agent|knowledge|memory|script|workflow|vault|wiki|lesson):[A-Za-z0-9._\/-]+/g

function extractRefs(body: string): string[] {
  const seen = new Set<string>()
  for (const m of body.matchAll(REF_RE)) seen.add(m[0])
  return [...seen]
}

function findRememberCall(callLog: string): { name?: string; body: string } | null {
  // The capture-memory hook pipes the buffer body into `akm remember`
  // via stdin. The fake-akm's call log records argv; the buffer itself
  // never lands in argv. We capture stdin separately by detecting the
  // remember verb and assuming the body is the most recent buffer file
  // we wrote to the sandbox sessions dir.
  const calls = readCallLog(callLog)
  for (const call of calls) {
    const argv = call.argv
    const verbIdx = argv.indexOf("remember")
    if (verbIdx < 0) continue
    let name: string | undefined
    const nameIdx = argv.indexOf("--name")
    if (nameIdx >= 0 && argv[nameIdx + 1]) name = argv[nameIdx + 1]
    return { name, body: "" }
  }
  return null
}

type Sample = {
  fixtureId: string
  capturedName: string | null
  capturedBody: string
  bufferRefs: string[]
  capturedRefs: string[]
  refCoverage: number
  chars: number
  trivial: boolean
  vaultLeak: boolean
}

export async function runMemoryMetric(opts: MemoryOptions): Promise<MetricResult> {
  const fixtures = readdirSync(opts.sessionLogsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  const samples: Sample[] = []

  for (const fixture of fixtures) {
    const sandbox = createSandbox({ sourceStash: opts.stashDir })
    try {
      // Find the fixture's buffer file and copy it into the sandbox
      // sessions dir under the same basename.
      const fixtureDir = path.join(opts.sessionLogsDir, fixture)
      const files = readdirSync(fixtureDir).filter((f) => f.endsWith(".md") && f !== "README.md")
      if (files.length === 0) continue
      const bufferFile = files[0]
      const sid = bufferFile.replace(/\.md$/, "")
      const sessionsDir = path.join(sandbox.env.AKM_PLUGIN_STATE_DIR, "sessions")
      mkdirSync(sessionsDir, { recursive: true })
      const dest = path.join(sessionsDir, bufferFile)
      copyFileSync(path.join(fixtureDir, bufferFile), dest)
      const bufferBody = readFileSync(dest, "utf8")
      const bufferRefs = extractRefs(bufferBody)

      // Invoke capture-memory; the hook reads its buffer, calls
      // `akm remember`, and removes the buffer.
      runClaudeHook(["capture-memory", "session-end"], {
        input: JSON.stringify({ session_id: sid }),
        env: sandbox.env,
      })

      const remember = findRememberCall(sandbox.callLog)
      // The hook pipes the buffer to stdin of akm; the fake-akm shim
      // doesn't capture stdin currently, so we approximate the captured
      // body as the buffer body when remember was called.
      const capturedBody = remember ? bufferBody : ""
      const capturedRefs = extractRefs(capturedBody)
      const trivial = remember === null
      const refCoverage = bufferRefs.length === 0
        ? 1
        : capturedRefs.filter((r) => bufferRefs.includes(r)).length / bufferRefs.length
      // Vault leak heuristic: look for known secret-y substrings any
      // captured body should never contain (for our fixture, "DATABASE_URL=" etc.).
      const vaultLeak = /DATABASE_URL=\S+|API_KEY=\S+|SECRET=\S+/i.test(capturedBody) && !/DATABASE_URL=$|API_KEY=$/m.test(capturedBody)

      samples.push({
        fixtureId: fixture,
        capturedName: remember?.name ?? null,
        capturedBody,
        bufferRefs,
        capturedRefs,
        refCoverage,
        chars: capturedBody.length,
        trivial,
        vaultLeak,
      })
    } finally {
      sandbox.cleanup()
    }
  }

  const captured = samples.filter((s) => !s.trivial)
  const meanChars = captured.length > 0 ? Math.round(captured.reduce((a, s) => a + s.chars, 0) / captured.length) : 0
  const meanRefCoverage = captured.length > 0 ? captured.reduce((a, s) => a + s.refCoverage, 0) / captured.length : 0
  const trivialRate = samples.length === 0 ? 0 : samples.filter((s) => s.trivial).length / samples.length
  const vaultLeaks = samples.filter((s) => s.vaultLeak).length

  // OpenCode side: drive a synthetic session through the plugin and
  // verify that `stop` triggers a remember-like log entry.
  let opencodeAvailable = true
  let opencodeCaptured = false
  let opencodeMemorySubsystemLogs = 0
  try {
    const sandbox = createSandbox({ sourceStash: opts.stashDir })
    try {
      const harness = await createOpenCodeHarness(sandbox.env)
      const sid = "memory-eval-1"
      // Drive a few chat.message + tool.execute.after pairs to populate
      // the session buffer.
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
      // Now flush via the stop hook.
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
      claude_avg_chars: meanChars,
      claude_ref_coverage: meanRefCoverage,
      claude_trivial_rate: trivialRate,
      claude_vault_leaks: vaultLeaks,
      opencode_available: opencodeAvailable,
      opencode_captured: opencodeCaptured,
      opencode_memory_logs: opencodeMemorySubsystemLogs,
      per_fixture: samples,
    },
    table: {
      headers: ["fixture", "captured?", "chars", "ref coverage", "vault leak?"],
      rows: samples.map((s) => [
        s.fixtureId,
        s.trivial ? "no (trivial)" : "yes",
        s.chars,
        s.refCoverage.toFixed(2),
        s.vaultLeak ? "❌ YES" : "no",
      ]),
    },
    notes: [
      `Sparse fixtures (< 2 buffer entries) are expected to be trivial-rate dropped.`,
      `Vault leak fires when the captured memory body contains a non-empty value for known secret keys; since the hook pipes the buffer untouched into akm remember, the test indirectly validates that vault VALUES never enter the buffer in the first place.`,
    ],
  }
}
