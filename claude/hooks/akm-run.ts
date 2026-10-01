#!/usr/bin/env bun

// Windows only: `bun akm-run.ts <timeout-ms> <command> <args...>` runs an akm
// invocation to completion with this process's own stdin, stdout and stderr (the
// hook's pipes, or a log file the hook pointed them at). Unless timeout-ms is 0, an
// akm that runs longer is taken down with everything it started and this exits
// RUN_TIMED_OUT. runPlan() in ../shared/spawn-plan.ts says why a Windows hook
// needs this between itself and akm.

import { spawn, spawnSync } from "node:child_process"
import path from "node:path"
import { RUN_TIMED_OUT, spawnPlan } from "../shared/spawn-plan"

const [timeout, command, ...args] = process.argv.slice(2)
const timeoutMs = Number(timeout) || 0

if (command) {
  const plan = spawnPlan(command, args)
  const child = spawn(plan.command, plan.args, {
    stdio: "inherit",
    windowsHide: true,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  })
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          // akm.cmd is cmd.exe starting node starting bun; stopping only the root would leave the rest running.
          // taskkill walks the tree down from a root that is still alive, so it goes first.
          if (child.pid) {
            spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
              stdio: "ignore",
              windowsHide: true,
            })
          }
          process.exit(RUN_TIMED_OUT)
        }, timeoutMs)
      : undefined
  child.on("error", () => process.exit(127))
  child.on("exit", (code) => {
    clearTimeout(timer)
    process.exit(code ?? 1)
  })
}
