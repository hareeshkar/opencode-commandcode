/**
 * opencode-commandcode-go — OpenCode plugin (v2 module shape)
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The $1 Command Code "Go" plan has no Provider API, so OpenCode cannot reach
 * its models on its own. This plugin supervises the local bridge and keeps
 * OpenCode's provider definition pointed at it.
 *
 * EXPORT SHAPE — read this before changing anything
 * -------------------------------------------------
 * OpenCode v2 requires the default export to be an OBJECT with an `id` and a
 * `setup` function:
 *
 *     export default { id: "…", async setup(ctx) { … } }
 *
 * Exporting a bare async function — which is what the v1 `Plugin` type is —
 * fails at load with:
 *
 *     Plugin must export a default definition with an id and an effect or
 *     setup function. (SchemaError(Expected object at ["default"]))
 *
 * Three plugins in this very config (rtk, skillful, subagent-delegate) are the
 * working reference. Match them.
 *
 * WHAT IT DOES
 * ------------
 *  1. Starts the bridge if it is not already running, and revives it if it died.
 *     The bridge auto-selects a free port and rewrites the provider `baseURL`
 *     itself, so the port can never go stale (see src/config-sync.js).
 *  2. Applies the plan gate. On a tier that already has API access, it leaves a
 *     clear note rather than quietly installing a bridge nobody needs.
 *  3. Registers a `commandcode_status` tool so the agent can report health,
 *     plan, credits, discovered schema and config drift on demand.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Walk up until a known artifact appears, so the plugin works from any layout. */
function findRepoRoot() {
  let dir = HERE
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "catalog.json"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(HERE, "..")
}

const REPO = findRepoRoot()
const load = (rel) => import(new URL(`../${rel}`, import.meta.url).href)

const HOST = process.env.CMD_BRIDGE_HOST || "127.0.0.1"
const BRIDGE_MAIN = path.join(REPO, "src", "bridge.js")

// ------------------------------------------------------------------ logging

const LOG_FILE = process.env.CMD_LOG_FILE || path.join(os.tmpdir(), "opencode-commandcode-go.log")
function log(msg) {
  const line = `[${new Date().toISOString()}] [commandcode-go] ${msg}`
  try { appendFileSync(LOG_FILE, line + "\n") } catch {}
  if (process.env.CMD_DEBUG) {
    try { process.stderr.write(line + "\n") } catch {}
  }
}

// ---------------------------------------------------------------- artifacts

function readArtifact(name, fallback) {
  try {
    const p = path.join(REPO, name)
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback
  } catch { return fallback }
}

// ----------------------------------------------------------- bridge control
//
// All of this lives in lifecycle.js so the plugin, the CLI and the tests share
// one implementation. The plugin's job is to call it and to clean up on exit —
// not to reimplement process management.

const lifecycle = await load("src/lifecycle.js")

let envInfo = null

async function isUp(timeoutMs = 1500) {
  try {
    return Boolean(await lifecycle.probeBridge({ host: HOST, timeoutMs }))
  } catch { return false }
}

async function currentBaseURL() {
  try {
    const found = await lifecycle.probeBridge({ host: HOST })
    return found ? `http://${HOST}:${found.port}/v1` : null
  } catch { return null }
}

async function ensureBridge() {
  if (envInfo && !envInfo.hasCredentials) return false
  const r = await lifecycle.start({ bridgeMain: BRIDGE_MAIN, host: HOST, envInfo })
  if (!r.ok) log(`bridge not started: ${r.reason}`)
  else if (r.started) log(`bridge started on ${r.baseURL} (owned by this process)`)
  else log(`bridge already serving on ${r.baseURL} (not started by us; will not be stopped)`)
  return r.ok
}

// ------------------------------------------------------------- the status tool

function statusTool() {
  return {
    description:
      "Report Command Code bridge health: reachability, detected plan and whether " +
      "it even needs this bridge, remaining credits, model count, supported input " +
      "modalities, and whether OpenCode's config is in sync with the running bridge.",
    // `input` is declared as a JSON Schema at the registration site; there is
    // no `args` shorthand in the v2 API.
    async execute(args) {
      const catalog = readArtifact("catalog.json", { models: [] })
      const schema = readArtifact("schema.generated.json", { paths: {} })
      const parts = readArtifact("parts.generated.json", { inputModalitiesOverall: [] })
      const out = []

      if (!(await isUp(3000))) {
        const started = await ensureBridge()
        out.push(`bridge: ${started ? "restarted and healthy" : "UNREACHABLE (start failed)"}`)
        if (!started) return { content: out.join("\n") }
      } else out.push("bridge: healthy")

      const base = await currentBaseURL()
      if (base) {
        try {
          const h = await (await fetch(`${base.replace(/\/v1$/, "")}/health?deep=1`)).json()
          out.push(`upstream: ${h.upstream?.reachable ? "reachable" : "unreachable"}`)
          if (h.upstream?.user) out.push(`account: ${h.upstream.user}`)
          if (h.plan?.id) {
            const need =
              h.plan.needsBridge === true ? "needs this bridge"
              : h.plan.needsBridge === false ? "already has API access - does NOT need this bridge"
              : ""
            out.push(`plan: ${h.plan.id}${need ? ` (${need})` : ""}`)
          }
          if (h.cliVersion) out.push(`cli version: ${h.cliVersion}`)
          if (h.catalog) out.push(`models in catalog: ${h.catalog.models}`)
          if (h.schema) out.push(`schema paths discovered: ${h.schema.paths}`)
          if (h.config) {
            out.push(
              `opencode.json: ${h.config.inSync ? "in sync" : `OUT OF SYNC - ${h.config.note}`}` +
                (h.config.inSync ? "" : " (fix: opencode-cc-go sync)"),
            )
          }
        } catch (e) {
          out.push(`health fetch failed: ${e.message}`)
        }
      }

      const vision = (catalog.models || []).filter((m) => m.inputModalities?.includes("image"))
      out.push(`vision-capable models: ${vision.length} of ${(catalog.models || []).length}`)
      out.push(`input modalities: ${(parts.inputModalitiesOverall || []).join(", ") || "text, image"}`)

      if (args?.detail === "full") {
        out.push("", "Discovered /alpha/generate fields:")
        for (const [k, v] of Object.entries(schema.paths || {})) {
          const extra = v.options ? ` = ${v.options.join("|")}` : v.expected !== undefined ? ` = ${v.expected}` : ""
          out.push(`  ${k}: ${v.kind}${extra} (${v.required ? "required" : "optional"})`)
        }
      }
      // A v2 tool's execute must return `{ content: string }`. Returning a bare
      // string registers the tool fine and then fails at call time with
      //   a is not an Object. (evaluating '"output"in a')
      return { content: out.join("\n") }
    },
  }
}

// ----------------------------------------------------------------- the plugin

export default {
  id: "opencode-commandcode-go",

  async setup(ctx) {
    log("plugin loaded (v2 module shape)")

    // 0. Register the tool FIRST, before any await.
    //
    //    ORDERING MATTERS. A transform registered after an await in setup() is
    //    accepted and logged as successful, but never reaches the agent. This
    //    file originally registered the tool after a multi-second bridge probe
    //    and a network plan check; the tool was then absent from a catalog of
    //    60 while the log still said "registered". The catalog is built from
    //    registrations made before setup yields.
    //
    //    The v2 API registers tools through a draft editor:
    //
    //        await ctx.tool.transform(editor => editor.add({ name, description, input, execute }))
    //
    //    `input` is a JSON Schema object, not the v1 `args` shorthand. There is
    //    no `ctx.tool.register`, and assigning onto `ctx.tool` does nothing.
    try {
      if (typeof ctx?.tool?.transform === "function") {
        const impl = statusTool()
        await ctx.tool.transform((editor) => {
          editor.add({
            name: "commandcode_status",
            description: impl.description,
            input: {
              type: "object",
              properties: {
                detail: {
                  type: "string",
                  description: "Set to 'full' to also dump every discovered /alpha/generate field.",
                },
              },
              additionalProperties: false,
            },
            execute: impl.execute,
          })
        })
        log("registered commandcode_status tool")
      } else {
        log("ctx.tool.transform unavailable; commandcode_status not registered")
      }
    } catch (e) {
      log(`tool registration failed: ${e.message}`)
    }

    // 0a. Classify the environment before doing anything that could leave a
    //     process or a file behind.
    //
    //     In a cloud sandbox there is no ~/.commandcode/auth.json and no
    //     persistent config, so the bridge only works if the operator injected
    //     COMMAND_CODE_API_KEY. Without it we say so and register nothing,
    //     rather than leaving a provider in the catalog that can never answer.
    envInfo = lifecycle.detectEnvironment()
    log(`environment: ${envInfo.kind} (${envInfo.reasons.join("; ") || "defaults"})`)

    if (!envInfo.hasCredentials) {
      log(
        "no Command Code credentials found. In a cloud sandbox set COMMAND_CODE_API_KEY; " +
          "on a local machine run `commandcode login`. The provider will not be registered.",
      )
    }

    // 1. Bring the bridge up before anything tries to use it.
    const up = envInfo.hasCredentials ? await ensureBridge() : false
    if (up) {
      const base = await currentBaseURL()
      const { checkDrift } = await load("src/config-sync.js")
      const port = base ? Number(base.match(/:(\d+)\/v1$/)?.[1]) : undefined
      // In a sandbox the config is ephemeral, so drift is not actionable and
      // repairing it is pointless work. Report and move on.
      const drift = port && envInfo.configWritable ? checkDrift({ port, host: HOST }) : null
      if (drift && !drift.inSync) {
        log(`config drift: ${drift.note} (run: opencode-cc-go sync)`)
      } else if (drift) {
        log(`bridge ready at ${base}; config in sync`)
      } else if (base) {
        log(`bridge ready at ${base}`)
      }
    } else if (envInfo.hasCredentials) {
      log("bridge unavailable at startup; the provider will fail until it recovers")
    }

    // 2. Plan gate: only the Go plan needs this.
    try {
      const { fetchPlanId, classifyPlan } = await load("src/plan.js")
      const planId = await fetchPlanId({
        apiBase: process.env.CMD_API_BASE || "https://api.commandcode.ai",
        apiKey: process.env.COMMAND_CODE_API_KEY,
      })
      const info = classifyPlan(planId)
      if (info.needsBridge === false) {
        log(`plan '${planId}' already has API access - this bridge is unnecessary here`)
      } else if (info.needsBridge === true) {
        log(`plan '${planId}' (Go) - bridge is the supported path`)
      }
    } catch (e) {
      log(`plan check skipped: ${e.message}`)
    }

    // 3. (tool registration happens at step 0, before any await — see above)

    // 3. (tool registration happens at step 0, before any await — see above)

    // 4. Return a teardown function.
    //
    //    The v2 loader runs whatever `setup` returns as the dispose callback:
    //
    //        const dispose = await module.default.setup(ctx)
    //        // ...later, on plugin reload or server shutdown:
    //        await dispose?.()
    //
    //    This is what stops the bridge when OpenCode closes. Without it a
    //    sandbox run leaves a process holding a loopback port with nothing left
    //    to reap it.
    //
    //    Two rules keep this safe:
    //      - only a bridge THIS process started is stopped. A launchd-managed
    //        bridge, or one the user started in a terminal, is left alone.
    //      - the state file is cleared by the bridge's own exit handler, so we
    //        do not delete a file describing a process that is still running.
    return async function dispose() {
      if (!lifecycle.ownsBridge()) {
        log("dispose: bridge was not started by us; leaving it running")
        return
      }
      const r = await lifecycle.stop()
      log(
        r.stopped
          ? `dispose: stopped bridge on port ${r.port}${r.escalated ? " (SIGKILL escalation)" : ""}`
          : `dispose: could not stop bridge: ${r.reason}`,
      )
    }
  },
}
