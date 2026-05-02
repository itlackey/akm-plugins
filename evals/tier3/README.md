# Tier 3 — LLM-in-the-loop scenarios

**Status: scaffolded, not yet implemented.**

This tier evaluates plugin effectiveness end-to-end with a real LLM
agent driving the plugin. A scenario describes a user goal, runs it
against a Claude or OpenCode harness with a seeded fixture stash, and
hands the resulting transcript to a judge model that scores the outcome
against a fixed rubric.

See the design doc for the planned rollout. MVP target:

- 4 scenarios (curate-skill, dispatch-agent, record-feedback, evolve-stash)
- Single judge model: Claude Sonnet 4.6 at `temperature: 0`
- Pairwise A/B mode with N=3 trials and shuffled labels for variance control
- Per-run cost cap and verdict caching keyed on `sha256(transcript)`

Layout (when implemented):

```
tier3/
├── runner.ts
├── scenarios/*.yaml
├── judge/{client.ts,rubric.ts,prompts.ts}
├── harness/{claude.ts,opencode.ts}
└── ab.ts
```

Trigger: `workflow_dispatch` only, requires `ANTHROPIC_API_KEY`.
