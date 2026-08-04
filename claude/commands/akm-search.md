---
description: Search AKM bundles or registries from Claude.
argument-hint: "[query] [flags]"
---

Run:

```sh
akm search "$ARGUMENTS" --format json -q
```

Report the top hits back to the user with the returned refs, descriptions, and next-step hints. When the best match is a stash asset, offer to inspect it with `akm show <ref>`. When the best match is a registry kit, surface the returned `installRef`.
