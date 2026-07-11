---
description: Detect, install (with explicit user consent), and configure the akm CLI. This is the canonical install consent point — the SessionStart hook never installs on its own.
---

`/akm-setup` is the single consent point for installing or upgrading the `akm`
CLI and for triggering the interactive `akm setup` wizard. The SessionStart
hook deliberately does **not** install global packages on its own — that would
be too aggressive for a public release. This slash command is where the human
explicitly approves an install.

Follow these steps **in order**. Do not skip step 2's confirmation gate.

## 1. Detect what is installed

Run, via Bash:

```sh
akm --version
```

Capture the result.

- If the command prints a version that satisfies `^0.9.0-beta.0 || ^0.9.0`
  (for example `0.9.0`, `0.9.0-beta.6`, `0.9.4`), skip to step **3** —
  installation is not needed.
- If the command is not found, the akm CLI is **not installed**.
- If the command prints a version outside that range (older `0.8.x`/`0.7.x`,
  or a future `1.x`), the installed version is **incompatible**.

For the not-installed and incompatible cases, continue to step 2.

## 2. Ask the user before installing — REQUIRED

Tell the user, in plain language, exactly what is about to happen and **wait
for explicit confirmation** before running any install command. For example:

> "I detected that `akm` is not installed (or that the installed version
> `X.Y.Z` does not satisfy the required `^0.9.0-beta.0 || ^0.9.0`). I'm about
> to run:
>
> &nbsp;&nbsp;`bun install -g akm-cli@^0.9.0-beta.0`
>
> (or `npm install -g akm-cli@^0.9.0-beta.0` if Bun is unavailable).
>
> This installs a global Node.js package on your machine. Do you want me to
> proceed?"

Only after the user confirms with an affirmative response (e.g. "yes",
"go ahead", "do it") may you actually run the install. If the user declines
or asks for an alternative, do not install — explain how they can install
manually using the [official AKM install docs](https://github.com/itlackey/akm)
or by running one of the install commands above themselves.

Pick the installer in this order, based on what is on PATH:

1. `bun install -g akm-cli@^0.9.0-beta.0` (preferred — matches what the hook
   also recommends).
2. `npm install -g akm-cli@^0.9.0-beta.0` (fallback when Bun is unavailable).

After the install completes, re-run `akm --version` and confirm the version
now satisfies `^0.9.0-beta.0 || ^0.9.0`. If it still does not, report the failure clearly to
the user — do **not** loop into another install attempt without asking again.

## 3. Run the interactive setup wizard

`akm setup` is the human-facing interactive configuration wizard. Do not run
it from the agent (it requires a TTY). Instead, tell the user:

> "akm is now installed (version X.Y.Z). To configure stash location,
> providers, semantic search, registries, sources, output defaults, and the
> agent CLI, run `akm setup` yourself in a terminal."

If the task is only to create the working stash for agent-safe workflows,
suggest `akm init` instead — that one is safe for the agent to run.

After the user completes `akm setup`, you may confirm the result by running
`akm config get defaults.agent` (the v0.8.0 canonical slot; the legacy
`agent.default` shape is auto-migrated on load).

## 4. Agent CLI prerequisites

Without an agent CLI on PATH, `/akm-improve` and `/akm-propose` cannot
generate agent-backed proposals. Suggest the user install one (for example
`opencode`, `claude`, `codex`, `gemini`, or `aider`) and then run
`akm setup` manually to wire it in.
