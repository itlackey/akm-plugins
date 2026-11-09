// The plugins read their settings from akm's config.json. Point every test process at an empty config
// directory so nothing in the suite reads the developer's own file; a test that needs settings makes a
// directory of its own with makeConfigDir() (tests/host-runtime.ts) and passes it as AKM_CONFIG_DIR.
import { afterAll } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = mkdtempSync(path.join(tmpdir(), "akm-plugins-test-config-"))
const emptyConfigDir = path.join(root, "empty")
mkdirSync(emptyConfigDir)
process.env.AKM_CONFIG_DIR = emptyConfigDir
afterAll(() => rmSync(root, { recursive: true, force: true }))
