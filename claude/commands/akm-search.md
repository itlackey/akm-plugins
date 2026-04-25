---
description: Search AKM stash assets or registry kits from Claude.
argument-hint: <query> [flags]
---

Run:

```sh
akm --format json -q search "$ARGUMENTS"
```

Report the top hits back to the user with the returned refs, descriptions, and next-step hints. When the best match is a stash asset, offer to inspect it with `akm show <ref>`. When the best match is a registry kit, surface the returned `installRef`.
