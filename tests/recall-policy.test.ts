import { describe, expect, test } from "bun:test"

import { shouldRecall } from "../claude/shared/recall-policy"

describe("AKM recall policy ref grammar", () => {
  test("recognizes 0.9.8 concept refs through the shared resolver contract", () => {
    expect(shouldRecall("Read skills/code-review before changing this.").reason).toBe("explicit-akm")
    expect(shouldRecall("Use team-playbook//knowledge/deploy#Rollback.").reason).toBe("explicit-akm")
  })

  test("does not treat retired type:name tokens as explicit AKM refs", () => {
    const decision = shouldRecall("skill:thing")

    expect(decision.shouldRecall).toBe(false)
    expect(decision.reason).toBe("skip-low-signal")
  })
})
