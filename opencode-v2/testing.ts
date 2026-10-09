// Test harness for the V2 plugin, kept beside the plugin because it needs this
// package's `effect`. It is NOT part of the published bundle (dist is built from
// index.ts alone). It runs the real `Plugin.define` entrypoint against a fake
// OpenCode context: the same registration calls the host makes, recorded, plus a
// way to push events and to read back everything the host's logger received.
import { Effect, Exit, Logger, References, Queue, Scope, Stream } from "effect"
import plugin from "./index"

export type LoggedLine = { level: string; message: string; annotations: Record<string, unknown> }

type Callback = (input: any) => Effect.Effect<void, any>

export type HostFake = {
  /** Tools registered through `tool.transform`, by name. */
  tools: Map<string, any>
  /** Hooks registered through `session.hook`, by name. */
  sessionHooks: Map<string, Callback>
  toolHooks: Map<string, Callback>
  shellHooks: Map<string, Callback>
  logs: LoggedLine[]
  /** Push a native event onto the stream the plugin subscribed to. */
  emit(event: unknown): Promise<void>
  /** Resolve once the plugin's event subscription is attached. */
  subscribed: Promise<void>
  /** Close the plugin scope (the host unloading it). */
  unload(): Promise<void>
  runPrompt(sessionID: string, text: string): Promise<void>
  /** Run the `context` hook against a request whose system parts are `system`; returns the parts afterwards. */
  runContext(sessionID: string, system: Array<{ type: "text"; text: string }>): Promise<Array<{ type: "text"; text: string }>>
  runToolHook(name: string, input: unknown): Promise<void>
  /** Run `shell.create.before` against `env`, as the host does when it creates a shell; returns the env afterwards. */
  runShellCreate(env?: Record<string, string | undefined>): Promise<Record<string, string | undefined>>
  callTool(name: string, input: unknown, sessionID?: string): Promise<{ content: string; metadata?: Record<string, unknown> }>
}

export async function startPlugin(directory: string): Promise<HostFake> {
  const tools = new Map<string, any>()
  const sessionHooks = new Map<string, Callback>()
  const toolHooks = new Map<string, Callback>()
  const shellHooks = new Map<string, Callback>()
  const logs: LoggedLine[] = []
  const events = await Effect.runPromise(Queue.unbounded<unknown>())
  let markSubscribed!: () => void
  const subscribed = new Promise<void>((resolve) => {
    markSubscribed = resolve
  })

  const registration = { dispose: Effect.void }
  const ctx: any = {
    location: { directory, project: { directory } },
    tool: {
      transform: (callback: (editor: unknown) => void) =>
        Effect.sync(() => {
          callback({
            add: (tool: { name: string }) => tools.set(tool.name, tool),
            list: () => [...tools.values()],
            get: (id: string) => tools.get(id),
            namespace: () => undefined,
            update: () => undefined,
            remove: (id: string) => tools.delete(id),
          })
          return registration
        }),
      hook: (name: string, callback: Callback) => Effect.sync(() => (toolHooks.set(name, callback), registration)),
    },
    shell: { hook: (name: string, callback: Callback) => Effect.sync(() => (shellHooks.set(name, callback), registration)) },
    session: { hook: (name: string, callback: Callback) => Effect.sync(() => (sessionHooks.set(name, callback), registration)) },
    event: {
      subscribe: () => {
        markSubscribed()
        return Stream.fromQueue(events)
      },
    },
  }

  const logger = Logger.make((options: any) => {
    const annotations: Record<string, unknown> = {}
    const raw = options.fiber?.getRef?.(References.CurrentLogAnnotations)
    if (raw && typeof raw === "object") Object.assign(annotations, raw)
    const message = Array.isArray(options.message) ? options.message.join(" ") : String(options.message)
    logs.push({ level: String(options.logLevel), message, annotations })
  })

  const scope = await Effect.runPromise(Scope.make())
  await Effect.runPromise(
    (plugin as any).effect(ctx).pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(Logger.layer([logger]))),
  )

  const run = <A>(effect: Effect.Effect<A, any>) => Effect.runPromise(effect as Effect.Effect<A, never>)

  return {
    tools,
    sessionHooks,
    toolHooks,
    shellHooks,
    logs,
    subscribed,
    emit: (event) => run(Queue.offer(events, event)).then(() => undefined),
    unload: () => run(Scope.close(scope, Exit.void)),
    runPrompt: (sessionID, text) => run(sessionHooks.get("prompt")!({ sessionID, prompt: { text } })),
    runContext: async (sessionID, system) => {
      const input = { sessionID, system: [...system] }
      await run(sessionHooks.get("context")!(input))
      return input.system
    },
    runToolHook: (name, input) => run(toolHooks.get(name)!(input)),
    runShellCreate: async (env = { PATH: "/usr/bin" }) => {
      const input = { command: "echo", cwd: directory, timeout: 0, shell: "sh", env }
      await run(shellHooks.get("create.before")!(input))
      return input.env
    },
    callTool: (name, input, sessionID = "ses_test") =>
      run(tools.get(name).execute(input, { sessionID })) as Promise<{ content: string; metadata?: Record<string, unknown> }>,
  }
}
