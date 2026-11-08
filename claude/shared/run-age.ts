/** Bounded age of a workflow run's last update: "<1h ago", "5h ago", "9d ago", or "unknown" for anything that is not a past ISO timestamp. */
export function runAge(updatedAt: unknown, now: number = Date.now()): string {
  const then = typeof updatedAt === "string" ? Date.parse(updatedAt) : Number.NaN
  if (!Number.isFinite(then) || then > now) return "unknown"
  const hours = Math.floor((now - then) / 3_600_000)
  if (hours < 1) return "<1h ago"
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}
