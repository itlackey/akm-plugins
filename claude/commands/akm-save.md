---
description: Commit (and push, when writable) pending changes in a git-backed AKM stash.
argument-hint: [stash-name] [commit message]
---

Parse `"$ARGUMENTS"` into an optional stash name and an optional commit message. Run:

```sh
akm --format json -q save [<stash-name>] [-m "<message>"]
```

Only commits when the target stash is a git-backed source. Pushes automatically when the stash is marked `writable` in config and has a remote configured. No-op for non-git stashes.

Report the resulting commit sha (or the "no changes" status) back to the user. If the user asked you to save after editing stash assets and no changes were committed, suggest running `akm index` and confirming the stash is git-initialized and writable (`akm config get writable`).
