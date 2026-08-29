import { describe, it, expect } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

function resolveFromTest(relativePath: string): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    relativePath,
  )
}

const fixtureStashDir = resolveFromTest("../evals/fixtures/stash")

describe("OpenCode eval harness", () => {
  it("keeps auto-feedback routed through the sandbox akm shim", async () => {
    const resultDir = mkdtempSync(path.join(tmpdir(), "akm-eval-harness-"))
    const resultPath = path.join(resultDir, "feedback.json")
    const stashSandboxUrl = pathToFileURL(resolveFromTest("../evals/lib/stash-sandbox.ts")).href
    const fakeAkmUrl = pathToFileURL(resolveFromTest("../evals/lib/fake-akm.ts")).href
    const harnessUrl = pathToFileURL(resolveFromTest("../evals/tier2/harness/opencode.ts")).href
    const script = `
      const { writeFileSync } = await import("node:fs")
      const { createSandbox } = await import(${JSON.stringify(stashSandboxUrl)})
      const { readCallLog } = await import(${JSON.stringify(fakeAkmUrl)})
      const { createOpenCodeHarness, uninstallEnvPatch } = await import(${JSON.stringify(harnessUrl)})

      async function waitForFeedback(callLogPath, timeoutMs = 2000) {
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

      const sandbox = createSandbox({ sourceStash: ${JSON.stringify(fixtureStashDir)} })
      try {
        const harness = await createOpenCodeHarness(sandbox.env)
        await harness.toolAfter({
          sessionID: "eval-feedback-1",
          tool: "akm_show",
          toolArgs: { ref: "skills/code-review" },
          output: "{\\"ok\\":false,\\"error\\":\\"asset not found\\",\\"ref\\":\\"skills/code-review\\"}",
        })
        const feedback = await waitForFeedback(sandbox.callLog)
        writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
          feedback,
          calls: readCallLog(sandbox.callLog),
          logs: harness.client.__logs,
        }))
      } finally {
        sandbox.cleanup()
        uninstallEnvPatch()
      }
    `
    const proc = Bun.spawn([process.execPath, "--eval", script], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited

    try {
      if (exitCode !== 0) {
        throw new Error(`OpenCode eval harness exited ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`)
      }
      expect(exitCode).toBe(0)
      expect(stdout).toBe("")
      expect(stderr).toBe("")

      // A FAILING lookup, because a successful read-only one deliberately
      // emits nothing (AKM_READ_ONLY_TOOLS). What this test is about is the
      // routing — that the harness's child-process patch sends the plugin's
      // `akm feedback` spawn to the sandbox shim rather than to a real akm on
      // PATH — and the negative path exercises exactly the same spawn.
      const result = JSON.parse(readFileSync(resultPath, "utf8")) as { feedback: string[][]; calls: unknown[]; logs: unknown[] }
      if (result.feedback.length === 0) {
        throw new Error(`The eval harness did not route feedback: ${JSON.stringify(result)}`)
      }
      expect(result.feedback).toContainEqual([
        "feedback",
        "skills/code-review",
        "--negative",
        "--reason",
        "opencode auto: akm_show failed; confidence=0.65; source=tool_failure",
        "--format",
        "json",
        "-q",
      ])
    } finally {
      rmSync(resultDir, { recursive: true, force: true })
    }
  })
})
