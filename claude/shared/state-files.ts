/**
 * Shared helpers for the append-only state files both plugins keep under their
 * harness state dir (session.log, feedback.log, memory.log, quality-cache.tsv,
 * sessions/<sid>.md, extract.log, events.jsonl, memory-candidates.jsonl).
 *
 * This module is the single copy of three primitives that were previously
 * duplicated near-verbatim in claude/hooks/akm-hook.ts, ./memory-events.ts and
 * ./memory-candidates.ts:
 *
 *   chmodSafe()          best-effort owner-only hardening that never throws
 *   atomicWriteFileSync() write-temp-then-rename, with temp cleanup on failure
 *   rotateIfOversized()   size cap that keeps the newest half of the file
 *
 * Constraints this module must keep satisfying:
 *  - Zero third-party imports. claude/hooks/akm-hook.ts runs as a bare Bun
 *    script with no node_modules at hook-execution time, so only node:* builtins
 *    are importable here.
 *  - It is vendored into the published OpenCode tarball by
 *    opencode/scripts/vendor-shared.mjs, which copies every *.ts in
 *    claude/shared/ — no registration step is needed for a new file.
 */

import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"

/**
 * Best-effort chmod. State files can hold prompt fragments, ref names and
 * (despite redaction) sensitive contextual data, so they are locked to
 * owner-only. Filesystems and platforms without POSIX mode (Windows, FAT, some
 * FUSE mounts) silently skip: a hardening attempt must never crash a hook.
 */
export function chmodSafe(target: string, mode: number): void {
  try {
    chmodSync(target, mode)
  } catch {
    // Intentionally ignored — see the doc comment above.
  }
}

/**
 * Write a file atomically: temp file in the same directory, then rename over
 * the target. rename(2) is atomic on POSIX (and on Windows via Node's
 * implementation), so a concurrent reader always observes either the old
 * content in full or the new content in full — never a torn/partial write.
 *
 * A failed rename removes the temp file (nothing else ever prunes it) and then
 * rethrows, so each caller keeps its own error semantics: rotateIfOversized()
 * swallows the error, memory-candidates' replaceCandidates() propagates it.
 */
export function atomicWriteFileSync(filePath: string, content: string, mode?: number): void {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmpPath, content)
  if (mode !== undefined) chmodSafe(tmpPath, mode)
  try {
    renameSync(tmpPath, filePath)
  } catch (error) {
    // Don't orphan the temp file when the swap fails (EXDEV, permissions, a
    // concurrent unlink of the target dir, ...).
    try {
      rmSync(tmpPath, { force: true })
    } catch {}
    throw error
  }
}

// State-file rotation/caps (release-0.9.0 review §2 "Unbounded state growth"):
// every append-only file under the harness state dir previously grew without
// bound for the lifetime of the machine. AKM_PLUGIN_MAX_LOG_BYTES (default
// 1 MiB) is the shared cap for all of them.
const MAX_LOG_BYTES = (() => {
  const raw = Number(process.env.AKM_PLUGIN_MAX_LOG_BYTES)
  return Number.isFinite(raw) && raw > 0 ? raw : 1024 * 1024
})()

/**
 * Before an append: if the file already exceeds AKM_PLUGIN_MAX_LOG_BYTES,
 * rewrite it down to its newest half (by line count) via write-temp-then-rename
 * so a concurrent reader/writer never observes a truncated or partial file.
 *
 * Best-effort and never throws: a failed attempt just means the file keeps
 * growing until the next successful append/rotate.
 */
export function rotateIfOversized(filePath: string): void {
  try {
    const stat = statSync(filePath)
    if (stat.size <= MAX_LOG_BYTES) return
    const lines = readFileSync(filePath, "utf8").split("\n")
    if (lines[lines.length - 1] === "") lines.pop()
    // Keep-at-least-one-line guard: a single line larger than the cap would
    // make slice(ceil(len/2)) empty and rotation would erase the file instead
    // of capping it. Always retain the newest line.
    const keep = lines.length <= 1 ? lines : lines.slice(Math.ceil(lines.length / 2))
    // 0o600 on the replacement: without it the rewritten file would come back
    // at the umask default and quietly drop the owner-only posture the
    // originals are created with.
    atomicWriteFileSync(filePath, keep.length > 0 ? `${keep.join("\n")}\n` : "", 0o600)
  } catch {
    // Rotation is best-effort and must never throw — see the doc comment.
  }
}
