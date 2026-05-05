import { describe, it, expect } from "bun:test"
import { createSandbox } from "../evals/lib/stash-sandbox"
import { readCallLog } from "../evals/lib/fake-akm"
import { createOpenCodeHarness, uninstallEnvPatch } from "../evals/tier2/harness/opencode"

describe("OpenCode eval harness", () => {
  it("keeps auto-feedback routed through the sandbox akm shim", async () => {
    const originalEnv = { ...process.env }
    const sandbox = createSandbox({
      sourceStash: "/home/runner/work/akm-plugins/akm-plugins/evals/fixtures/stash",
    })

    try {
      const harness = await createOpenCodeHarness(sandbox.env)
      await harness.toolAfter({
        sessionID: "eval-feedback-1",
        tool: "akm_show",
        toolArgs: { ref: "skill:code-review" },
        output: "{\"ok\":true,\"type\":\"skill\",\"ref\":\"skill:code-review\",\"content\":\"Review pull requests...\"}",
      })

      await new Promise((resolve) => setTimeout(resolve, 500))

      const emitted = readCallLog(sandbox.callLog)
        .filter((call) => call.argv.includes("feedback"))
        .map((call) => call.argv)

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
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key]
      }
      for (const [key, value] of Object.entries(originalEnv)) {
        process.env[key] = value
      }
    }
  })
})
