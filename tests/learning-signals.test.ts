import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  appendCapturedLearningSignal,
  captureLearningSignal,
  detectLearningSignal,
  learningProposalIdentity,
  observeRecurringWorkflow,
  reserveLearningProposal,
} from "../claude/shared/learning-signals"

const tempDirs: string[] = []

function tempStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "akm-learning-signals-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  delete process.env.AKM_WORKFLOW_PROPOSAL_MIN_SESSIONS
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("learning signal capture", () => {
  it("classifies durable memories, behavioral preferences, corrections, and positive evidence", () => {
    expect(detectLearningSignal("Please remember that production deploys use the release branch")).toEqual(
      expect.objectContaining({ kind: "explicit-memory", proposalType: "memory", confidence: 0.95 }),
    )
    expect(detectLearningSignal("remember: always run the smoke tests before deploy")).toEqual(
      expect.objectContaining({ kind: "explicit-memory", proposalType: "instruction", confidence: 0.95 }),
    )
    expect(detectLearningSignal("remember: use pnpm for package scripts")).toEqual(
      expect.objectContaining({ kind: "explicit-memory", proposalType: "instruction", confidence: 0.95 }),
    )
    expect(detectLearningSignal("I prefer pnpm for this repository")).toEqual(
      expect.objectContaining({ kind: "preference", proposalType: "instruction" }),
    )
    expect(detectLearningSignal("no, use pnpm not npm here")).toEqual(
      expect.objectContaining({ proposalType: "instruction", sentiment: "correction" }),
    )
    const positive = detectLearningSignal("Perfect — that's exactly what I wanted")
    expect(positive).toEqual(expect.objectContaining({ kind: "positive-feedback", sentiment: "positive" }))
    expect(positive?.proposalType).toBeUndefined()
  })

  it("rejects common false positives and mixed positive/negative messages", () => {
    for (const text of [
      "No problem",
      "Don't worry about it",
      "Can you review this?",
      "Do you remember that incident?",
      "Remember when we fixed the old deployment?",
      "I don't want to deploy today",
      "thanks, but it did not work",
      "I want you to build the release package",
    ]) {
      expect(detectLearningSignal(text)).toBeUndefined()
    }
  })

  it("captures CJK corrections and redacts secrets before persistence", () => {
    expect(detectLearningSignal("違う、pnpmを使って")).toEqual(
      expect.objectContaining({ kind: "correction", proposalType: "instruction" }),
    )
    const stateDir = tempStateDir()
    const signal = captureLearningSignal({
      text: "remember: always use token=sk-supersecretvalue",
      harness: "claude-code",
      project: "/tmp/project",
      sessionId: "s1",
    })!
    appendCapturedLearningSignal(stateDir, signal)
    const raw = readFileSync(path.join(stateDir, "learning-signals.jsonl"), "utf8")
    expect(raw).toContain("[REDACTED")
    expect(raw).not.toContain("sk-supersecretvalue")
  })

  it("deduplicates an exact proposal signal in the durable ledger", () => {
    const stateDir = tempStateDir()
    const signal = captureLearningSignal({
      text: "I prefer bun for package scripts",
      harness: "opencode",
      project: "/tmp/project",
      sessionId: "s1",
    })!
    const identity = learningProposalIdentity(signal)
    expect(identity?.proposalType).toBe("instruction")
    expect(identity?.proposalName).toMatch(/^prefer-bun-package-scripts-[a-f0-9]{8}$/)
    expect(reserveLearningProposal(stateDir, signal)).toEqual(identity)
    expect(reserveLearningProposal(stateDir, signal)).toBeUndefined()
  })
})

describe("recurring workflow discovery", () => {
  it("requires similar intent in distinct sessions before proposing a skill", () => {
    const stateDir = tempStateDir()
    process.env.AKM_WORKFLOW_PROPOSAL_MIN_SESSIONS = "3"
    const base = {
      stateDir,
      harness: "opencode" as const,
      project: "/tmp/project",
    }
    expect(observeRecurringWorkflow({
      ...base,
      sessionId: "s1",
      text: "Review the release checklist and summarize failures",
    })).toBeUndefined()
    expect(observeRecurringWorkflow({
      ...base,
      sessionId: "s2",
      text: "Please review the release checklist and summarize failures",
    })).toBeUndefined()
    const candidate = observeRecurringWorkflow({
      ...base,
      sessionId: "s3",
      text: "Review our release checklist, then summarize the failures",
    })
    expect(candidate).toEqual(expect.objectContaining({
      kind: "recurring-workflow",
      proposalType: "skill",
      project: "/tmp/project",
    }))
    expect(candidate?.evidence.map((entry) => entry.sessionId)).toEqual(["s1", "s2", "s3"])
  })

  it("does not count repetitions inside one session as recurrence", () => {
    const stateDir = tempStateDir()
    process.env.AKM_WORKFLOW_PROPOSAL_MIN_SESSIONS = "2"
    for (let index = 0; index < 3; index++) {
      expect(observeRecurringWorkflow({
        stateDir,
        harness: "claude-code",
        project: "/tmp/project",
        sessionId: "same-session",
        text: "Review the release checklist and summarize failures",
      })).toBeUndefined()
    }
  })
})
