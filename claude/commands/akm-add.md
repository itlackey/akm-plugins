---
description: Install a kit or register an external source from npm, GitHub, another git host, a URL, or a local directory.
argument-hint: <package-ref> [flags]
---

Run:

```sh
akm add "$ARGUMENTS" --format json
```

via the Bash tool and surface the response (the registered source id, name, and any
install-audit warnings).

## Supported package refs

- `npm:@scope/kit` — npm package
- `github:<owner>/<repo>` — GitHub shorthand
- `git+https://host/repo` — any git host
- `https://…` — raw URL (requires `--provider`, e.g. `--provider github` or
  `--provider website`)
- `./local/kit` — directory on disk

## Flags worth knowing

- `--name <name>` — register the source under a custom name.
- `--writable` — mark a git-backed source as push-writable. Required for `akm save` to push.
- `--trust` — bypass the install-audit block for this registration only. **Only set this
  after the user explicitly confirms** they trust the source.
- `--provider <name>` — provider hint. `website` registers an external website crawler;
  `github`, `git`, `npm` etc. force the registrar.
- `--type wiki` — route through the typed wiki registrar instead of registering a stash
  kit. Use this when the package ref is a wiki source.
- `--max-pages <N>` / `--max-depth <N>` — caps for the website crawler (defaults: 50, 3).
  Only meaningful when `--provider website`.
- `--options '<json>'` — provider-specific options as a JSON string.

## Confirmation rules

Before invoking `akm add`, **explicitly confirm with the user** when any of the following
apply:

- `--trust` is being requested (you are bypassing the install-audit gate).
- `--provider website` is being used (this triggers a crawler that may issue many HTTP
  requests against a third-party site).
- The ref points to a git host you have not used in this conversation before, or to a
  raw URL.

For a vanilla npm or GitHub install with default flags, you may proceed and report the
result.

## After install

- The new source is searchable immediately via `/akm-search` and `/akm-curate`.
- If the user asked you to install something to make later edits, remind them they will
  typically `akm clone <origin//ref>` to fork an asset into the working stash before
  editing — see `/akm-help` topic="clone".
