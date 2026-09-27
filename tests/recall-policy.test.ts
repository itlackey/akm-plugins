import { describe, expect, test } from "bun:test"

import { isNonTaskPrompt, shouldRecall } from "../claude/shared/recall-policy"

describe("AKM recall policy ref grammar", () => {
  test("recognizes 0.9.14 concept refs through the shared resolver contract", () => {
    expect(shouldRecall("Read skills/code-review before changing this.").reason).toBe("explicit-akm")
    expect(shouldRecall("Use team-playbook//knowledge/deploy#Rollback.").reason).toBe("explicit-akm")
  })

  test("does not treat retired type:name tokens as explicit AKM refs", () => {
    const decision = shouldRecall("skill:thing")

    expect(decision.shouldRecall).toBe(false)
    expect(decision.reason).toBe("skip-low-signal")
  })
})

// Ported from the retrieval eval harness's `_looks_like_nontask` / `classify`
// (akm-test-corpus/harness/retrieval/queries.py). Measured 2026-09-27: at
// least 53% of 30 days of per-prompt curate calls were harness/tool envelopes
// and long pastes rather than task queries, and every one of them still spent
// a curate subprocess and injected irrelevant assets into context.
describe("AKM recall policy skips harness/tool envelopes (non-task prompts)", () => {
  const envelopeTags = [
    "<task-notification>",
    "<agent-message",
    "<bash-input>",
    "<bash-stdout>",
    "<bash-stderr>",
    "<system-reminder>",
    "<local-command",
    "<command-name>",
    "<command-message>",
  ]

  // Each payload deliberately carries no closing `</...>` tag, so this proves
  // the literal tag match on its own rather than piggy-backing on the general
  // "XML-like" rule covered separately below.
  test.each(envelopeTags)("skips a payload carrying the %s envelope tag", (tag) => {
    const payload = `${tag} some trailing tool-generated content without a closing tag`
    const decision = shouldRecall(payload)
    expect(decision.shouldRecall).toBe(false)
    expect(decision.reason).toBe("skip-nontask")
  })

  test("skips the exact AKM stash README boilerplate", () => {
    // Literal text from src/assets/stash-skeleton/README.md in the akm CLI
    // repo, truncated exactly as the harness's STASH_BOILERPLATE constant is.
    const boilerplate = "This is an **AKM stash** — a structured knowledge repository that stores reusable"
    const decision = shouldRecall(boilerplate)
    expect(decision.shouldRecall).toBe(false)
    expect(decision.reason).toBe("skip-nontask")
  })

  test("skips a generic XML-like payload with no specific envelope tag", () => {
    const decision = shouldRecall("<mcp_tool_result>ok</mcp_tool_result>")
    expect(decision.shouldRecall).toBe(false)
    expect(decision.reason).toBe("skip-nontask")
  })

  test("skips a paste longer than 2,000 characters", () => {
    const paste = "a".repeat(2001)
    expect(paste.length).toBe(2001)
    const decision = shouldRecall(paste)
    expect(decision.shouldRecall).toBe(false)
    expect(decision.reason).toBe("skip-nontask")
  })

  test("does not skip a genuine task prompt sitting right at the 2,000 character boundary", () => {
    const prompt = "fix the flaky retry logic in the deploy pipeline. ".repeat(40).slice(0, 2000)
    expect(prompt.length).toBe(2000)
    const decision = shouldRecall(prompt)
    expect(decision.shouldRecall).toBe(true)
    expect(decision.reason).not.toBe("skip-nontask")
  })

  test("still curates an ordinary short task prompt", () => {
    const decision = shouldRecall("fix the login bug in the auth module")
    expect(decision.shouldRecall).toBe(true)
    expect(decision.reason).toBe("coding-task")
  })

  test("still curates a genuinely long task prompt under the paste limit", () => {
    const prompt = (
      "We need to refactor the deployment pipeline: review the rollback runbook, fix the flaky "
      + "healthcheck, update the changelog and release notes, and design the new error code convention. "
    ).repeat(8)
    expect(prompt.length).toBeGreaterThan(400)
    expect(prompt.length).toBeLessThan(2000)
    const decision = shouldRecall(prompt)
    expect(decision.shouldRecall).toBe(true)
    expect(decision.reason).not.toBe("skip-nontask")
  })

  test("isNonTaskPrompt is the same check shouldRecall uses internally", () => {
    expect(isNonTaskPrompt("<task-notification>payload not a task</task-notification>")).toBe(true)
    expect(isNonTaskPrompt("fix the login bug")).toBe(false)
  })
})
