// Thin wrapper around `Bun.spawnSync` that invokes the Claude plugin's
// hook runtime (claude/hooks/akm-hook.ts). Mirrors the runHook pattern in
// tests/claude-plugin.test.ts:36-59 so the unit tests and the eval
// framework exercise the hook through the same entrypoint.

import path from "node:path"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { mkdtempSync } from "node:fs"

export type RunHookResult = {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

const REPO_ROOT = path.resolve(import.meta.dir, "../../..")
const HOOK_SCRIPT = path.join(REPO_ROOT, "claude/hooks/akm-hook.ts")

export function runClaudeHook(
  args: string[],
  options: { input?: string; env: Record<string, string> },
): RunHookResult {
  let stdin: "ignore" | Blob = "ignore"
  if (options.input !== undefined) {
    const tmp = mkdtempSync(path.join(tmpdir(), "akm-eval-stdin-"))
    const inputPath = path.join(tmp, "stdin.txt")
    writeFileSync(inputPath, options.input)
    stdin = Bun.file(inputPath)
  }
  const start = performance.now()
  const result = Bun.spawnSync([process.execPath, HOOK_SCRIPT, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...options.env },
    stdio: [stdin, "pipe", "pipe"],
  })
  const durationMs = performance.now() - start
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode ?? -1,
    durationMs,
  }
}

// Parse refs (e.g. `skill:code-review`, `knowledge:foo/bar`) out of the
// `additionalContext` block the hook emits as JSON on stdout. Mirrors the
// types listed in AGENTS.md: skill, command, agent, knowledge, memory,
// script, workflow, vault, wiki.
const REF_RE = /\b(skill|command|agent|knowledge|memory|script|workflow|vault|wiki):[A-Za-z0-9._\/-]+/g

export function parseInjectedRefs(stdout: string): { context: string; refs: string[] } {
  const trimmed = stdout.trim()
  if (!trimmed) return { context: "", refs: [] }
  let payload: any
  try {
    payload = JSON.parse(trimmed)
  } catch {
    return { context: "", refs: [] }
  }
  const ctx: string = payload?.hookSpecificOutput?.additionalContext ?? ""
  const seen = new Set<string>()
  const refs: string[] = []
  for (const m of ctx.matchAll(REF_RE)) {
    if (!seen.has(m[0])) {
      seen.add(m[0])
      refs.push(m[0])
    }
  }
  return { context: ctx, refs }
}
