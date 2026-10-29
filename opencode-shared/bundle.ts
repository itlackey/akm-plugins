import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Where the active AKM bundle lives: `AKM_BUNDLE_DIR`, else `akm info`'s
// `bundleDir`. Used to validate refs seen in arbitrary tool calls and to export
// the bundle location into shell environments. The answer, including "unknown",
// is cached for the life of the plugin process.
export type BundleDirResolver = ReturnType<typeof createBundleDirResolver>

export function createBundleDirResolver() {
  let cached: string | undefined
  return {
    /** `runInfo` returns `akm info --format json -q` stdout, or null when it failed. */
    async get(runInfo: () => Promise<string | null>): Promise<string | undefined> {
      const override = process.env.AKM_BUNDLE_DIR?.trim()
      if (override) return override
      if (cached !== undefined) return cached || undefined
      const raw = await runInfo()
      let value = ""
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>
          if (typeof parsed?.bundleDir === "string") value = parsed.bundleDir.trim()
        } catch {
          // not JSON: unknown
        }
      }
      cached = value
      return value || undefined
    },
  }
}

/**
 * The calling plugin package's version: the `package.json` beside the module
 * (source layout) or one level up (the published `dist/index.js`). "0.0.0" when
 * neither is readable.
 */
export function readPluginVersion(moduleUrl: string, packageName: string): string {
  const dir = path.dirname(fileURLToPath(moduleUrl))
  for (const candidate of [path.join(dir, "package.json"), path.join(dir, "..", "package.json")]) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, "utf8")) as { name?: unknown; version?: unknown }
      if (manifest.name === packageName && typeof manifest.version === "string" && manifest.version) return manifest.version
    } catch {
      // try the next location
    }
  }
  return "0.0.0"
}
