// A copy of the Claude/Codex plugin whose bundled akm-cli is a bridge to the `akm` on PATH.
//
// The hook runs `<plugin root>/node_modules/akm-cli/dist/cli.js` under Bun and never looks at PATH. Tests and
// evals drive it with a fake akm on PATH (evals/lib/fake-akm.ts, or a script a test writes), so they run the
// hook from this copy, where that cli.js hands its arguments to the `akm` the sandbox put on PATH. The hook,
// the shared modules and the manifests are the repository's own files; only node_modules differs.

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const claudeDir = path.resolve(import.meta.dir, "../../claude")
const spawnPlanPath = path.join(claudeDir, "shared/spawn-plan.ts")

// spawnPlan() is what the hook itself uses to start a batch file, so akm.cmd works here as it did on PATH.
const bridge = `import { spawnSync } from "node:child_process"
import { spawnPlan } from ${JSON.stringify(spawnPlanPath)}

const akm = Bun.which("akm")
if (!akm) {
  console.error("bridged akm-cli: no akm on PATH")
  process.exit(127)
}
const plan = spawnPlan(akm, process.argv.slice(2))
const result = spawnSync(plan.command, plan.args, { stdio: "inherit", windowsVerbatimArguments: plan.windowsVerbatimArguments })
process.exit(result.status ?? 1)
`

/** Write the bridge as `<pluginRoot>/node_modules/akm-cli/dist/cli.js`. */
export function writeBridgedAkmCli(pluginRoot: string): void {
  const dist = path.join(pluginRoot, "node_modules", "akm-cli", "dist")
  mkdirSync(dist, { recursive: true })
  writeFileSync(path.join(dist, "cli.js"), bridge)
}

/**
 * A new plugin root under `parent` (a fresh temp directory when omitted, removed when the process exits; pass a
 * directory something else removes where the process may not exit normally, as under `bun test`).
 */
export function makeBridgedPluginRoot(parent?: string): string {
  const root = mkdtempSync(path.join(parent ?? tmpdir(), "akm-plugin-"))
  for (const entry of ["hooks", "shared", ".claude-plugin", ".codex-plugin", "package.json"]) cpSync(path.join(claudeDir, entry), path.join(root, entry), { recursive: true })
  writeBridgedAkmCli(root)
  if (!parent) process.on("exit", () => rmSync(root, { recursive: true, force: true }))
  return root
}
