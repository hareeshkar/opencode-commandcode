/**
 * opencode-commandcode-go — OpenCode plugin
 *
 * Registers Command Code as a native OpenCode provider and supervises the
 * bridge, so an installed user gets the provider without editing any config.
 *
 * WHAT IT DOES
 * ------------
 *  1. `config` hook — injects the provider and its models into OpenCode's live
 *     config, built from the discovered catalog so models, context limits and
 *     input modalities always match what the bridge actually serves.
 *
 *     The baseURL is resolved with `discoverPort()` at config time, which means
 *     it is correct *before* OpenCode issues any request. That is the one
 *     advantage this path has over the installer: there is no window in which
 *     the port in the config can be stale (§ config-sync.js explains why the
 *     installer path needs self-healing at all).
 *
 *  2. plan gate — this package is only for the $1 Go plan. If the account is
 *     on a tier that already has API access, the plugin declines to register
 *     and says why, rather than adding a bridge nobody needs.
 *
 *  3. `event` hook — starts the bridge on first use and revives it if it died.
 *
 *  4. `tool` hook — `commandcode_status`, so the agent can report bridge
 *     health, plan, credits, discovered schema and config drift on demand.
 *
 * SELF-HEALING NOTES
 * ------------------
 * The bridge is a child process the plugin owns. Liveness is checked through
 * /health, which is deliberately non-blocking, so a slow upstream never looks
 * like a dead bridge. Restarts are rate-limited so a slow start cannot become a
 * respawn loop.
 */

import { spawn } from "node:child_process"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * Locate the package root by walking up until a known artifact appears. This
 * makes the plugin work whether it is loaded as <pkg>/src/plugin.js, as
 * <pkg>/plugin.js, or as a copy inside a plugin directory.
 */
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

// Static imports are resolved lazily because the module may be loaded from a
// directory that only contains plugin.js.
const load = async (rel) => import(new URL(`../${rel}`, import.meta.url).href)

const HOST = process.env.CMD_BRIDGE_HOST || "127.0.0.1"
const BRIDGE_MAIN = path.join(REPO, "src", "bridge.js")
const RESTART_COOLDOWN_MS = 10_000
const HEALTH_TIMEOUT_MS = 1500

// ------------------------------------------------------------------ logging

const LOG_FILE = process.env.CMD_LOG_FILE || path.join(os.tmpdir(), "opencode-commandcode-go.log")
let logSink = (m) => { try { appendFileSync(LOG_FILE, `${m}\n`) } catch {} }

function log(msg) {
  const line = `[${new Date().toISOString()}] [commandcode-go] ${msg}`
  try { logSink(line) } catch {}
  if (process.env.CMD_DEBUG) {
    try { process.stderr.write(`${line}\n`) } catch {}
  }
}

// ---------------------------------------------------------------- artifacts

async function artifacts() {
  const read = (name, fallback) => {
    try {
      const p = path.join(REPO, name)
      return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback
    } catch { return fallback }
  }
  return {
    catalog: read("catalog.json", { models: [] }),
    schema: read("schema.generated.json", { paths: {} }),
    parts: read("parts.generated.json", { partTypes: [] }),
  }
}

// ----------------------------------------------------------- bridge control

let child = null
let lastStart = 0
let warnedMissing = false
let disabled = false

async function isUp(timeoutMs = HEALTH_TIMEOUT_MS) {
  const { discoverPort, isServing } = await load("src/port.js")
  const found = await discoverPort({ host: HOST })
  if (!found) return false
  return isServing(found.port, HOST, timeoutMs)
}

/** The baseURL OpenCode should use, resolved live. */
async function currentBaseURL() {
  const { discoverPort } = await load("src/port.js")
  const found = await discoverPort({ host: HOST })
  if (!found) return null
  return `http://${HOST}:${found.port}/v1`
}

async function ensureBridge() {
  if (disabled) return false
  if (await isUp()) return true

  if (!existsSync(BRIDGE_MAIN)) {
    if (!warnedMissing) {
      warnedMissing = true
      log(`bridge not found at ${BRIDGE_MAIN}; run: npm install -g opencode-commandcode-go`)
    }
    disabled = true
    return false
  }

  const now = Date.now()
  if (now - lastStart < RESTART_COOLDOWN_MS) return false
  lastStart = now

  try {
    child = spawn(process.execPath, [BRIDGE_MAIN], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    })
    child.unref()
  } catch (e) {
    log(`failed to spawn bridge: ${e.message}`)
    return false
  }

  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (await isUp(1000)) {
      const base = await currentBaseURL()
      log(`bridge up on ${base}`)
      return true
    }
  }
  log("bridge did not become healthy in time")
  return false
}

// ------------------------------------------------- provider construction

/**
 * Build the OpenCode provider from the discovered catalog. Mirrors
 * scripts/install.js so both registration paths produce identical config.
 */
function buildProvider(baseURL) {
  return async function build() {
    const { catalog } = await artifacts()
    const models = {}
    for (const m of catalog.models || []) {
      const input = m.inputModalities?.length ? m.inputModalities : ["text"]
      const entry = {
        name: m.name || m.id,
        limit: {
          context: m.contextWindow || 128000,
          output: m.reasoningEfforts?.length ? 65536 : 16384,
        },
        // vision models are flagged so OpenCode never routes an image to a
        // text-only model
        modalities: { input, output: ["text"] },
      }
      if (m.reasoningEfforts?.length) {
        entry.reasoning = true
        entry.options = { reasoningEffort: m.reasoningEfforts[0] }
      }
      models[m.id] = entry
    }
    return {
      commandcode: {
        npm: "@ai-sdk/openai-compatible",
        name: "Command Code (Go plan)",
        options: { baseURL, apiKey: "local-bridge" },
        models,
      },
    }
  }
}

// ------------------------------------------------------------------ the tool

function makeStatusTool() {
  return {
    description:
      "Report Command Code bridge health: whether the bridge is reachable, the " +
      "detected plan and whether it even needs this bridge, remaining credits, " +
      "the model count, input modalities, and whether OpenCode's config is in " +
      "sync with the running bridge. Use this to diagnose connectivity.",
    args: {
      detail: { type: "string", optional: true, description: "Set to 'full' for the raw schema dump." },
    },
    async execute(args) {
      const [{ catalog, schema, parts }, { checkDrift }, { discoverPort }] = await Promise.all([
        artifacts(),
        load("src/config-sync.js"),
        load("src/port.js"),
      ])
      const lines = []
      const up = await isUp(3000)
      if (!up) {
        const started = await ensureBridge()
        lines.push(`bridge: ${started ? "restarted and healthy" : "UNREACHABLE (start failed)"}`)
        if (!started) return lines.join("\n")
      } else {
        lines.push("bridge: healthy")
      }

      const found = await discoverPort({ host: HOST })
      try {
        const r = await fetch(`http://${HOST}:${found?.port}/health`)
        const h = await r.json()
        lines.push(`upstream: ${h.upstream?.reachable ? "reachable" : "UNREACHABLE"}`)
        if (h.upstream?.user) lines.push(`account: ${h.upstream.user}`)
        if (h.plan?.id) {
          const need = h.plan.needsBridge === true ? "needs this bridge" :
            h.plan.needsBridge === false ? "already has API access - does NOT need this bridge" : ""
          lines.push(`plan: ${h.plan.id}${need ? ` (${need})` : ""}`)
        }
        if (h.cliVersion) lines.push(`cli version: ${h.cliVersion}`)
        if (h.catalog) lines.push(`models in catalog: ${h.catalog.models}`)
        if (h.schema) lines.push(`schema paths discovered: ${h.schema.paths}`)
        if (h.config) {
          lines.push(
            `opencode.json: ${h.config.inSync ? "in sync" : `OUT OF SYNC - ${h.config.note}`}` +
              (h.config.inSync ? "" : " (fix: opencode-cc-go sync)"),
          )
        }
      } catch (e) {
        lines.push(`health fetch failed: ${e.message}`)
      }

      const vision = (catalog.models || []).filter((m) => m.inputModalities?.includes("image"))
      lines.push(`vision-capable models: ${vision.length} of ${(catalog.models || []).length}`)
      lines.push(`input modalities: ${(parts.inputModalitiesOverall || []).join(", ") || "text, image"}`)

      if (args?.detail === "full") {
        lines.push("")
        lines.push("Discovered /alpha/generate fields:")
        for (const [k, v] of Object.entries(schema.paths || {})) {
          const extra = v.options ? ` = ${v.options.join("|")}` : v.expected !== undefined ? ` = ${v.expected}` : ""
          lines.push(`  ${k}: ${v.kind}${extra} (${v.required ? "required" : "optional"})`)
        }
      }
      return lines.join("\n")
    },
  }
}

// ----------------------------------------------------------------- the plugin

export const CommandCodeGoPlugin = async ({ client, directory }) => {
  // Prefer OpenCode's structured log sink when the SDK exposes one.
  if (client?.app?.log) {
    const prev = logSink
    logSink = (line) => {
      prev(line)
      client.app
        .log({ body: { service: "commandcode-go", level: "info", message: line } })
        .catch(() => {})
    }
  }

  // Warm the bridge in the background; never block plugin initialisation.
  ensureBridge().catch(() => {})

  return {
    config: async (cfg) => {
      try {
        // Make sure something is serving before we hand OpenCode a baseURL.
        const ok = await ensureBridge()
        const baseURL = (await currentBaseURL()) || `http://${HOST}:8787/v1`
        if (!ok) log(`bridge unavailable; registering provider anyway (base ${baseURL})`)

        // Plan gate: do not register on a tier that already has API access.
        try {
          const { fetchPlanId, classifyPlan } = await load("src/plan.js")
          const planId = await fetchPlanId({
            apiBase: process.env.CMD_API_BASE || "https://api.commandcode.ai",
            apiKey: process.env.COMMAND_CODE_API_KEY,
          })
          const info = classifyPlan(planId)
          if (info.needsBridge === false) {
            log(`plan ${planId} already has API access - not registering the bridge provider`)
            if (!cfg.provider?.commandcode) return
          }
        } catch (e) {
          log(`plan check skipped: ${e.message}`)
        }

        if (!cfg.provider) cfg.provider = {}
        // Do not clobber a user-authored provider with the same id.
        if (cfg.provider.commandcode) {
          // Only refresh the URL, which is the one field that can go stale.
          const existing = cfg.provider.commandcode
          const base = await currentBaseURL()
          if (base && existing?.options?.baseURL !== base) {
            existing.options = existing.options || {}
            existing.options.baseURL = base
            log(`refreshed existing provider baseURL -> ${base}`)
          }
          return
        }
        const provider = await buildProvider(baseURL)()
        cfg.provider.commandcode = provider.commandcode
        log(`registered provider "commandcode" with ${Object.keys(provider.commandcode.models).length} models at ${baseURL}`)
      } catch (e) {
        log(`config hook failed: ${e.message}`)
      }
    },

    event: async ({ event }) => {
      if (event?.type === "session.idle" || event?.type === "session.created") {
        if (!(await isUp(800))) ensureBridge().catch(() => {})
      }
    },

    tool: { commandcode_status: makeStatusTool() },
  }
}

export const CommandCodePlugin = CommandCodeGoPlugin
export default CommandCodeGoPlugin
