#!/usr/bin/env node
/**
 * postpack: restore opencode/index.ts from the prepack backup and remove the
 * vendored opencode/shared/ directory so the working tree returns to its
 * dev-only shape (imports point back at ../shared, no in-tree copy of the
 * shared modules). See vendor-shared.mjs for the prepack counterpart.
 *
 * Safe to run multiple times: missing files / dirs are silently ignored.
 */
import { existsSync, renameSync, rmSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const opencodeDir = path.resolve(here, "..")
const targetDir = path.join(opencodeDir, "shared")
const indexPath = path.join(opencodeDir, "index.ts")
const indexBackup = path.join(opencodeDir, "index.ts.prepack-bak")

if (existsSync(indexBackup)) {
  renameSync(indexBackup, indexPath)
}
if (existsSync(targetDir)) {
  rmSync(targetDir, { recursive: true, force: true })
}
console.log("unvendor-shared: restored opencode/index.ts and removed vendored shared/")
