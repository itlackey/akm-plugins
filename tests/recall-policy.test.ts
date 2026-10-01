import { describe, expect, test } from "bun:test"

import { isNonTaskPrompt, shouldRecall, stripLeadingEnvelopes } from "../claude/shared/recall-policy"

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

// The same rule `akm curate` applies from 0.9.17-alpha.6. Measured 2026-09-27:
// at least 53% of 30 days of per-prompt curate calls were harness/tool
// envelopes or the stash README line rather than task queries; long prompts,
// by contrast, usually had a relevant asset.
describe("AKM recall policy skips harness/tool envelopes (non-task prompts)", () => {
  const envelopeTags = [
    "<task-notification>",
    "<agent-message",
    "<cross-session-message",
    "<bash-input>",
    "<bash-stdout>",
    "<bash-stderr>",
    "<system-reminder>",
    "<local-command",
    "<command-name>",
    "<command-message>",
  ]

  test.each(envelopeTags)("skips a %s envelope", (tag) => {
    const name = tag.replace(/[<>]/g, "")
    const payload = `${tag}${tag.endsWith(">") ? "" : ' from="x">'} tool-generated content</${name}>`
    const decision = shouldRecall(payload)
    expect(decision.shouldRecall).toBe(false)
    expect(decision.reason).toBe("skip-nontask")
  })

  test("still curates a real question that mentions an envelope tag", () => {
    const decision = shouldRecall("fix the hook so a <system-reminder> block is not sent to curate")
    expect(decision.shouldRecall).toBe(true)
    expect(decision.reason).not.toBe("skip-nontask")
  })

  test("skips the exact AKM stash README boilerplate", () => {
    // Literal text from src/assets/stash-skeleton/README.md in the akm CLI
    // repo, truncated exactly as the harness's STASH_BOILERPLATE constant is.
    const boilerplate = "This is an **AKM stash** — a structured knowledge repository that stores reusable"
    const decision = shouldRecall(boilerplate)
    expect(decision.shouldRecall).toBe(false)
    expect(decision.reason).toBe("skip-nontask")
  })

  test("skips the post-compaction continuation message, which opens with prose instead of a tag", () => {
    const continuation = [
      "This session is being continued from a previous conversation that ran out of context.",
      "The summary below covers the earlier portion of the conversation.",
      "",
      "Summary:",
      "<analysis>fix the flaky retry logic in the deploy pipeline</analysis>",
    ].join("\n")
    expect(isNonTaskPrompt(continuation)).toBe(true)
    const decision = shouldRecall(continuation)
    expect(decision.shouldRecall).toBe(false)
    expect(decision.reason).toBe("skip-nontask")
  })

  test("skips a generic XML-like payload with no specific envelope tag", () => {
    const decision = shouldRecall("<mcp_tool_result>ok</mcp_tool_result>")
    expect(decision.shouldRecall).toBe(false)
    expect(decision.reason).toBe("skip-nontask")
  })

  test("still curates a task prompt longer than 2,000 characters", () => {
    const prompt = "fix the flaky retry logic in the deploy pipeline. ".repeat(50)
    expect(prompt.length).toBeGreaterThan(2000)
    const decision = shouldRecall(prompt)
    expect(decision.shouldRecall).toBe(true)
    expect(decision.reason).not.toBe("skip-nontask")
  })

  test("still curates an ordinary short task prompt", () => {
    const decision = shouldRecall("fix the login bug in the auth module")
    expect(decision.shouldRecall).toBe(true)
    expect(decision.reason).toBe("coding-task")
  })

  test("still curates a long task prompt", () => {
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

// Claude Code sometimes prepends a <system-reminder> block to a prompt the user
// typed (a worktree notice, "the user started your background task"). Two real
// ones were logged as `user prompt` rows, and the whole text was classed as an
// envelope because it starts with a tag and closes one: the user's own words
// were neither curated nor captured. What follows the leading blocks is what
// was typed; a text that is nothing but blocks is still no prompt.
describe("AKM recall policy and harness blocks that lead a typed prompt", () => {
  const worktree = "<system-reminder> You are operating in a git worktree. Worktree path: /tmp/wt Worktree name: wt </system-reminder>"
  const task = "fix the flaky retry logic in the deploy pipeline"

  test("a typed prompt behind a leading <system-reminder> block is a task, and the typed text is its query", () => {
    expect(isNonTaskPrompt(`${worktree} ${task}`)).toBe(false)
    expect(stripLeadingEnvelopes(`${worktree} ${task}`)).toBe(task)

    const decision = shouldRecall(`${worktree} ${task}`)
    expect(decision.shouldRecall).toBe(true)
    expect(decision.reason).toBe("coding-task")
    expect(decision.query).toBe(task)
  })

  test("the block's own words do not drive the decision", () => {
    // `worktree` says "akm"-free prose today, but a reminder naming akm or a
    // workflow must not turn a chit-chat prompt into an explicit-akm recall.
    const reminder = "<system-reminder> Use the akm workflow and remember the memory of the previous session. </system-reminder>"
    const decision = shouldRecall(`${reminder} thanks`)
    expect(decision.shouldRecall).toBe(false)
    expect(decision.reason).toBe("skip-short")
  })

  test("strips every leading block, whatever its tag, and a nested block of the same name with it", () => {
    const stacked = `<local-command-caveat>x</local-command-caveat><command-name>/foo</command-name>\n${worktree}\n${task}`
    expect(stripLeadingEnvelopes(stacked)).toBe(task)

    const nested = `<system-reminder>outer <system-reminder>inner</system-reminder> still outer</system-reminder> ${task}`
    expect(stripLeadingEnvelopes(nested)).toBe(task)
    // A block that is nothing but nested blocks leaves nothing behind.
    expect(isNonTaskPrompt("<system-reminder>outer <system-reminder>inner</system-reminder> still outer</system-reminder>")).toBe(true)
  })

  test("keeps a pure envelope a non-task: nothing is left once its blocks are stripped", () => {
    for (const envelope of [
      "<task-notification><task-id>t-1</task-id><summary>done</summary></task-notification>",
      '<agent-message from="a1"> [Subagent hand-back] DONE. </agent-message>',
      `${worktree}<task-notification>done</task-notification>  `,
      `${worktree}\n\n${worktree}`,
    ]) {
      expect(stripLeadingEnvelopes(envelope)).toBe("")
      expect(isNonTaskPrompt(envelope)).toBe(true)
      expect(shouldRecall(envelope).reason).toBe("skip-nontask")
    }
  })

  test("still skips a continuation or the stash README line behind a block", () => {
    expect(isNonTaskPrompt(`${worktree} This session is being continued from a previous conversation that ran out of context.`)).toBe(true)
    expect(isNonTaskPrompt(`${worktree} This is an **AKM stash** — a structured knowledge repository that stores reusable`)).toBe(true)
  })

  test("leaves everything else alone", () => {
    // Prose first, a tag mentioned later, an unclosed block, a comment, an empty text.
    expect(stripLeadingEnvelopes(`fix the hook so a ${worktree} block is not sent`)).toBe(`fix the hook so a ${worktree} block is not sent`)
    expect(stripLeadingEnvelopes(`<system-reminder> never closed ${task}`)).toBe(`<system-reminder> never closed ${task}`)
    expect(stripLeadingEnvelopes(`<!-- attach --> ${task}`)).toBe(`<!-- attach --> ${task}`)
    expect(stripLeadingEnvelopes("   ")).toBe("")
    expect(isNonTaskPrompt("   ")).toBe(false)
    // A typed remainder that is itself tag-shaped keeps the existing rule.
    expect(isNonTaskPrompt(`${worktree} <foo> text </bar>`)).toBe(true)
    expect(isNonTaskPrompt(`${worktree} <!-- attach --> ${task}`)).toBe(false)
  })
})
