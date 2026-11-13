// On a cold start akm builds its index inline in the first read that finds none, and two reads doing it at once
// contend: the loser fails with INDEX_DB_CONTENDED (exit 75). A new session fires its bootstrap lookups and its
// recall together, so they race each other. The first read of the process therefore goes alone; the rest wait
// for it to settle, whatever its outcome, and then run as usual. Once it has, the gate is open for good.
let warm = false
let first: Promise<void> | undefined

export function afterFirstRead<T>(read: () => Promise<T>): Promise<T> {
  if (warm) return read()
  if (first) return first.then(read)
  const run = read()
  first = run.then(
    () => {},
    () => {},
  ).then(() => {
    warm = true
    first = undefined
  })
  return run
}

/** Test seam: back to a process that has not read yet. */
export function resetColdStartForTests(): void {
  warm = false
  first = undefined
}
