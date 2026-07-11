import { describe, expect, it } from "bun:test"
import path from "node:path"

// docs/akm-help-registry.md is the canonical source for the akm_help /
// /akm-help quick-reference table. scripts/generate-help-tables.mjs pushes it
// into the three embedded copies (claude/commands/akm-help.md,
// claude/skills/akm/SKILL.md, opencode/index.ts) between BEGIN/END GENERATED
// markers. This test shells out to the generator's `--check` mode so it
// fails — naming the drifted consumer and row — whenever any embedded copy
// stops matching the registry on ANY column (task, command, notes, or
// keywords), not just the command cell the old inline check covered.
//
// Uses Bun.spawnSync rather than node:child_process for the same reason as
// tests/fake-akm-contract.test.ts: tests/opencode-plugin.test.ts installs a
// `mock.module("node:child_process", ...)` at module scope whose replacement
// does not export spawnSync, and bun:test module mocks leak across files in
// the same `bun test` process. Importing spawnSync here would throw a
// SyntaxError whenever this file loads after that mock (file-order dependent
// — it passed locally and failed in CI).
const repoRoot = path.resolve(import.meta.dir, "..")
const generatorPath = path.join(repoRoot, "scripts/generate-help-tables.mjs")

describe("akm_help registry parity", () => {
  it("keeps claude/commands/akm-help.md, claude/skills/akm/SKILL.md, and opencode/index.ts in sync with docs/akm-help-registry.md", () => {
    const result = Bun.spawnSync(["node", generatorPath, "--check"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = result.stdout.toString()
    const stderr = result.stderr.toString()

    if (result.exitCode !== 0) {
      throw new Error(
        `Embedded akm_help tables have drifted from docs/akm-help-registry.md.\n` +
          `Run \`node scripts/generate-help-tables.mjs\` to resync, then commit the result.\n\n` +
          `${stdout}${stderr}`,
      )
    }

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("OK: all consumers match docs/akm-help-registry.md")
  })
})
