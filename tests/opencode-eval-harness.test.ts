import { describe, it, expect } from "bun:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createSandbox } from "../evals/lib/stash-sandbox"
import { readCallLog } from "../evals/lib/fake-akm"
import { createOpenCodeHarness, uninstallEnvPatch } from "../evals/tier2/harness/opencode"

function resolveFromTest(relativePath: string): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    relativePath,
  )
}

function restoreProcessEnv(originalEnv: Record<string, string | undefined>) {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function waitForFeedback(callLogPath: string, timeoutMs = 2_000): Promise<string[][]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const emitted = readCallLog(callLogPath)
      .filter((call) => call.argv.includes("feedback"))
      .map((call) => call.argv)
    if (emitted.length > 0) return emitted
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return readCallLog(callLogPath)
    .filter((call) => call.argv.includes("feedback"))
    .map((call) => call.argv)
}

const fixtureStashDir = resolveFromTest("../evals/fixtures/stash")

describe("OpenCode eval harness", () => {
  it("keeps auto-feedback routed through the sandbox akm shim", async () => {
    const originalEnv = { ...process.env }
    const sandbox = createSandbox({
      sourceStash: fixtureStashDir,
    })

    try {
      const harness = await createOpenCodeHarness(sandbox.env)
      await harness.toolAfter({
        sessionID: "eval-feedback-1",
        tool: "akm_show",
        toolArgs: { ref: "skill:code-review" },
        output: "{\"ok\":true,\"type\":\"skill\",\"ref\":\"skill:code-review\",\"content\":\"Review pull requests...\"}",
      })

      const emitted = await waitForFeedback(sandbox.callLog)

      expect(emitted).toContainEqual([
        "--format",
        "json",
        "-q",
        "feedback",
        "skill:code-review",
        "--positive",
        "--note",
        "opencode auto: akm_show succeeded",
      ])
    } finally {
      sandbox.cleanup()
      uninstallEnvPatch()
      restoreProcessEnv(originalEnv)
    }
  })
})
