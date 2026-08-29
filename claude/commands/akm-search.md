---
description: Search AKM bundles or registries from Claude.
argument-hint: "[query] [flags]"
allowed-tools: Bash(akm search *)
---

Parse `"$ARGUMENTS"` as two parts: the free-text query, then any flags the user typed. The first token starting with `--` begins the flag section; everything before it is the query. Quote only the query — quoting the whole argument string turns every flag into a search term.

Supported flags: `--from local|registry|all|<bundle-name>`, `--type <asset-type>`, and `--include-proposed`. Pass anything else the user typed through verbatim. When the user supplied no query, drop the quoted query argument entirely and browse.

Run:

```sh
akm search "<query>" <flags> --format json -q
```

Report the top hits back to the user with the returned refs, descriptions, and next-step hints. When the best match is a bundle asset, offer to inspect it with `akm show <ref>`. When the best match is a registry kit, surface the returned `installRef`.
