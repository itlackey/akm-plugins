# Session log fixtures

These are pre-baked session buffers in the format the Claude hook writes
to `${AKM_PLUGIN_STATE_DIR}/sessions/<sid>.md` between turns.

The memory metric replays them through `capture-memory session-end` and
checks:
- whether a memory was captured at all (the hook drops trivial buffers
  with fewer than 2 entries),
- the captured memory's char length and ref coverage,
- that no vault values surface.

Each fixture is a directory: `<id>/<sid>.md` so the harness can copy it
into a sandbox sessions dir and invoke the hook.
