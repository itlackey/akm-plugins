// The ONE place the OpenCode plugins reach akm in-process. Automatic recall calls
// `curate` from the supported `akm-cli/api` entry point instead of starting the
// `akm` CLI; every tool (search/show/curate/feedback/remember) and every other
// helper still goes through the CLI (see akm-cli.ts).
//
// Contract of `akm-cli/api`'s `curate` (shared with the akm side):
//   - resolves to exactly the stdout text
//     `akm --shape agent -q curate <query> [--limit N] [--type T] --format <format>`
//     prints, computed in-process (no child process);
//   - rejects with an Error whose message is the CLI's error text and whose `code`
//     property is the CLI's error code when the CLI would have failed;
//   - there is no `cwd` option (curate does no cwd-based ranking); the call never
//     writes to the host's stdout/stderr/env. The text carries the CLI's trailing
//     newline, so callers trim it.
//
// `akm-cli/api` is imported lazily, by a non-literal specifier, for two reasons:
// an akm-cli that predates the entry point must degrade recall to "off, logged"
// rather than stop the plugin from loading, and tests substitute the function
// here instead of mocking a module (module mocks are process-global in bun).

export type CurateOptions = { limit?: number; type?: string; format?: "text" | "json" }
export type CurateFn = (query: string, options?: CurateOptions) => Promise<string>

const API_SPECIFIER = "akm-cli/api"

let override: CurateFn | undefined
let loaded: Promise<CurateFn> | undefined

/** Test seam: substitute the in-process curate. `undefined` restores the real import. */
export function setCurateForTests(fn: CurateFn | undefined): void {
  override = fn
}

/** The in-process `curate`. Rejects (and retries on the next call) when `akm-cli/api` cannot be loaded. */
export function loadCurate(): Promise<CurateFn> {
  if (override) return Promise.resolve(override)
  if (!loaded) {
    loaded = import(API_SPECIFIER).then(
      (mod: { curate?: unknown }) => {
        if (typeof mod.curate !== "function") throw new Error(`'${API_SPECIFIER}' does not export curate()`)
        return mod.curate as CurateFn
      },
      (error: unknown) => {
        loaded = undefined
        throw new Error(
          `The '${API_SPECIFIER}' entry point could not be loaded (${error instanceof Error ? error.message : String(error)}). Automatic recall needs an akm-cli that provides it.`,
        )
      },
    )
  }
  return loaded
}
