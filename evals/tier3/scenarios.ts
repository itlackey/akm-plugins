// Scenario YAML schema and loader for tier-3 evals.
//
// A scenario is a small declarative description of a user goal that the
// evaluation framework can run end-to-end against either plugin and then
// hand to the LLM judge for scoring.

import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import YAML from "yaml"

export type ScenarioPlugin = "claude" | "opencode"

export type Scenario = {
  id: string
  description: string
  plugins: ScenarioPlugin[]
  seed_stash: string                  // fixture stash dir name (under fixtures/stash)
  user_turns: Array<{
    role: "user"
    content: string
  }>
  // What the agent should do during the run, used by the judge.
  expectations: {
    must_curate_refs?: string[]       // these refs MUST appear in the injected context
    may_curate_refs?: string[]        // these MAY appear; bonus if they do
    must_record_feedback_for?: string[]  // refs the agent should fire feedback on
    forbid_refs?: string[]            // refs that MUST NOT appear (vault leak protection)
    max_total_tokens?: number         // soft budget for the judge to consider
  }
  judge_rubric: "default" | "strict"  // selector for rubric variant
  weight?: number
}

export function loadScenario(filePath: string): Scenario {
  const body = readFileSync(filePath, "utf8")
  const raw = YAML.parse(body) as Record<string, unknown>
  const id = raw.id as string
  if (!id) throw new Error(`Scenario at ${filePath} missing id`)
  return {
    id,
    description: (raw.description as string) ?? "",
    plugins: ((raw.plugin ?? raw.plugins ?? ["claude"]) as ScenarioPlugin[]) || ["claude"],
    seed_stash: (raw.seed_stash as string) ?? "default",
    user_turns: (raw.user_turns as Scenario["user_turns"]) ?? [],
    expectations: (raw.expectations as Scenario["expectations"]) ?? {},
    judge_rubric: (raw.judge_rubric as Scenario["judge_rubric"]) ?? "default",
    weight: (raw.weight as number) ?? 1,
  }
}

export function loadScenarios(dir: string, glob?: string): Scenario[] {
  const re = glob ? new RegExp("^" + glob.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$") : null
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
  const out: Scenario[] = []
  for (const f of files) {
    const scenario = loadScenario(path.join(dir, f))
    if (re && !re.test(scenario.id)) continue
    out.push(scenario)
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}
