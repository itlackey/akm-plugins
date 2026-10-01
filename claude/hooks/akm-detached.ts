#!/usr/bin/env bun

// Windows only: `bun akm-detached.ts <command> <args...>` runs an akm invocation to
// completion with this process's own stdout and stderr, which the hook pointed at a
// log file. akm-hook.ts starts it detached; see spawnDetachedAkm() there for why a
// Windows hook cannot detach akm.cmd itself.

import { spawnSync } from "node:child_process"
import { spawnPlan } from "../shared/spawn-plan"

const [command, ...args] = process.argv.slice(2)
if (command) {
  const plan = spawnPlan(command, args)
  spawnSync(plan.command, plan.args, {
    stdio: "inherit",
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  })
}
