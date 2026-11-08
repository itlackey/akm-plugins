// Per-session holder of the session bootstrap (rules and most-used list, see
// claude/shared/session-bootstrap.ts) for the OpenCode V1 and V2 plugins.
//
// OpenCode rebuilds the system prompt on every request, so the plugin re-sends the held text
// each turn; akm is asked once when the session starts (or the plugin first sees it, which
// covers a resumed session) and again after each compaction. Callbacks for the same event
// within DUPLICATE_WINDOW_MS share one load.
import { claimBootstrap } from "../claude/shared/session-bootstrap"

export type SessionBootstrap = {
  /** Load for a session the plugin has not loaded yet; a no-op once it has. */
  ensure(sessionID: string): Promise<void>
  /** Load again after a compaction: the new context holds none of it. */
  compacted(sessionID: string): Promise<void>
  /**
   * The held text, after any load in flight has finished or `waitMs` has passed, whichever is
   * first: a slow akm must not hold a request back. The load carries on for the next one.
   */
  text(sessionID: string): Promise<string>
  clear(sessionID: string): void
}

/** `load` renders the bootstrap for a session and returns "" when it has nothing or a lookup failed. */
export function createSessionBootstrap(load: (sessionID: string) => Promise<string>, waitMs = 3_000): SessionBootstrap {
  const texts = new Map<string, string>()
  const loading = new Map<string, Promise<void>>()
  const started = new Set<string>()
  const seen: Record<string, number> = {}

  function refresh(sessionID: string, kind: "start" | "compact"): Promise<void> {
    started.add(sessionID)
    if (!claimBootstrap(seen, `${sessionID}:${kind}`)) return loading.get(sessionID) ?? Promise.resolve()
    const run = load(sessionID)
      .then(
        (text) => {
          // A failed lookup keeps what the session already holds.
          if (text) texts.set(sessionID, text)
        },
        () => {},
      )
      .finally(() => {
        if (loading.get(sessionID) === run) loading.delete(sessionID)
      })
    loading.set(sessionID, run)
    return run
  }

  return {
    ensure: (sessionID) => (started.has(sessionID) ? loading.get(sessionID) ?? Promise.resolve() : refresh(sessionID, "start")),
    compacted: (sessionID) => refresh(sessionID, "compact"),
    async text(sessionID) {
      const inFlight = loading.get(sessionID)
      if (inFlight) {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([inFlight, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))])
        if (timer) clearTimeout(timer)
      }
      return texts.get(sessionID) ?? ""
    },
    clear(sessionID) {
      texts.delete(sessionID)
      loading.delete(sessionID)
      started.delete(sessionID)
      delete seen[`${sessionID}:start`]
      delete seen[`${sessionID}:compact`]
    },
  }
}
