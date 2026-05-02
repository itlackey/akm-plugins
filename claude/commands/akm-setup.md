---
description: Detect installed agent CLIs and persist `agent.default` so reflect/propose/distill can shell out.
argument-hint: [--force]
---

Run `akm setup` to detect the local agent CLI surface and persist `agent.default` in the config.

1. Run `akm --format json -q setup`. The command probes for `opencode`, `claude`, `codex`, `gemini`, and `aider` on PATH and records the first one it finds as `agent.default`.
2. Surface the detected agent (or report "no agent CLI found on PATH" and stop).
3. If the user passed `--force`, append `--force` to the call so it re-runs detection even when `agent.default` is already set.
4. After running, confirm by reading back `akm --format json -q config get agent.default`. Mention that the SessionStart hook also performs this check on first run, gated by a stamp file under the plugin state dir.

Without an agent CLI on PATH, `/akm-reflect` and `/akm-propose` cannot generate proposals. Suggest the user install one (e.g. `bun install -g opencode-ai`) and rerun `/akm-setup --force`.
