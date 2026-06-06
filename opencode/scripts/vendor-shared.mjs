#!/usr/bin/env node
/**
 * prepack: vendor shared modules from claude/shared/ into opencode/shared/ and
 * rewrite the `../claude/shared/` imports in index.ts to `./shared/` so that
 * the published tarball is self-contained.
 *
 * claude/shared/ is the single canonical source for shared modules. The
 * published tarball does not include the parent claude/ dir, so we vendor a
 * copy and rewrite imports at pack time. postpack reverts index.ts and removes
 * the vendored copy so the dev tree stays clean.
 *
 * If shared/ already exists in opencode/ when this runs (manual setup, or
 * a previously interrupted pack), we still re-copy so the snapshot is fresh.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const opencodeDir = path.resolve(here, "..")
const repoRoot = path.resolve(opencodeDir, "..")
const sourceDir = path.join(repoRoot, "claude", "shared")
const targetDir = path.join(opencodeDir, "shared")
const indexPath = path.join(opencodeDir, "index.ts")
const indexBackup = path.join(opencodeDir, "index.ts.prepack-bak")

if (!existsSync(sourceDir)) {
  console.error(`vendor-shared: source ${sourceDir} not found`)
  process.exit(1)
}

mkdirSync(targetDir, { recursive: true })
const entries = readdirSync(sourceDir).filter((name) => name.endsWith(".ts"))
if (entries.length === 0) {
  console.error(`vendor-shared: no .ts files found in ${sourceDir}`)
  process.exit(1)
}
for (const name of entries) {
  copyFileSync(path.join(sourceDir, name), path.join(targetDir, name))
}

// Only snapshot the backup if one does not already exist. Re-running prepack
// without an intervening postpack (e.g. interrupted pack, npm pack --dry-run
// twice in a row) must not clobber the original with the rewritten copy.
const current = readFileSync(indexPath, "utf8")
if (!existsSync(indexBackup)) {
  writeFileSync(indexBackup, current)
}
const rewritten = current.replace(/from "\.\.\/claude\/shared\//g, 'from "./shared/')
if (rewritten !== current) {
  writeFileSync(indexPath, rewritten)
}

console.log(`vendor-shared: copied ${entries.length} shared module(s) into ${targetDir} and rewrote index.ts imports`)
