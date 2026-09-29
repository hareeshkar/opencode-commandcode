/**
 * opencode-commandcode — OpenCode plugin
 *
 * Registers Command Code as a native OpenCode provider and supervises the
 * bridge process, so a user installs one npm package and gets the provider with
 * no `opencode.json` edits at all.
 *
 * WHAT IT DOES
 * ------------
 *  1. `config` hook  — injects the provider + models into OpenCode's live
 *     config. The model list is read from the generated catalog, so the
 *     provider's models, context limits and input modalities (text vs image)
 *     always match what the bridge actually serves.
 *  2. `event` hook   — lazily starts the bridge on first use and restarts it if
 *     it has died, so `ECONNREFUSED` never reaches the model layer.
 *  3. `tool` hook    — exposes a `commandcode_status` tool the agent can call
 *     to report bridge health, plan, credits and the discovered schema.
 *
 * SELF-HEALING NOTES
 * ------------------
 * The bridge is a child process the plugin owns. If the port stops answering we
 * respawn it, but we do so at most once per N seconds to avoid a respawn loop
 * when the bridge is legitimately slow to start.
 */

import { spawn, execFile } from "node:child_process"
import { appendFileSync } from "node:fs"
import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * Locate the package root by walking up from this module until we find a
 * directory containing a known artifact. This makes the plugin work whether it
 * is loaded as <pkg>/src/plugin.js, <pkg>/index.js, or copied into a plugin
 * directory alongside its JSON artifacts.
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

const PORT = process.env.CMD_BRIDGE_PORT || "8787"
const HOST = process.env.CMD_BRIDGE_HOST || "127.0.0.1"
const BASE_URL = `http://${HOST}:${PORT}/v1`
const BRIDGE_MAIN = path.join(REPO, "src", "bridge.js")

// ------------------------------------------------------------- artifacts

function readArtifact(name, fallback) {
  try {
    const p = path.join(REPO, name)
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"))
  } catch {}
  return fallback
}

const CATALOG = readArtifact("catalog.json", { models: [] })
const SCHEMA = readArtifact("schema.generated.json", { paths: {} })
const PARTS = readArtifact("parts.generated.json", { partTypes: [] })

// --------------------------------------------------------------- logging

const LOG_FILE = process.env.CMD_LOG_FILE || "/tmp/opencode-commandcode.log"
let logSink = console.error
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  try { logSink(`[commandcode] ${msg}`) } catch {}
  try { appendFileSync(LOG_FILE, line + "\n") } catch {}
}

// --------------------------------------------------------- bridge control

let child = null
let lastStart = 0
const RESTART_COOLDOWN_MS = 10_000
let warnedMissing = false

async function isUp(timeoutMs = 1500) {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    const r = await fetch(`http://${HOST}:${PORT}/health`, { signal: ac.signal })
    clearTimeout(t)
    return r.ok
  } catch { return false }
}

async function ensureBridge() {
  if (await isUp()) return true

  if (!existsSync(BRIDGE_MAIN)) {
    if (!warnedMissing) { warnedMissing = true; log(`bridge not found at ${BRIDGE_MAIN}`) }
    return false
  }

  const now = Date.now()
  if (now - lastStart < RESTART_COOLDOWN_MS) return false
  lastStart = now

  try {
    child = spawn(process.execPath, [BRIDGE_MAIN], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, CMD_BRIDGE_PORT: PORT, CMD_BRIDGE_HOST: HOST },
    })
    child.unref()
  } catch (e) {
    log(`failed to spawn bridge: ${e.message}`)
    return false
  }

  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 250))
    if (await isUp(1000)) { log(`bridge up on ${HOST}:${PORT}`); return true }
  }
  log("bridge did not become healthy in time")
  return false
}

// ------------------------------------------------- provider construction

/**
 * Build the OpenCode provider object from the generated catalog.
 * Each model carries:
 *   - limit.context / limit.output  (so OpenCode can budget context)
 *   - modalities.input              (so image prompts route only to vision models)
 *   - reasoning                     (so the TUI shows a thinking budget)
 */
function buildProvider() {
  const models = {}
  for (const m of CATALOG.models || []) {
    const input = m.inputModalities?.length ? m.inputModalities : ["text"]
    const entry = {
      name: m.name || m.id,
      limit: {
        context: m.contextWindow || 128000,
        output: m.reasoningEfforts?.length ? 65536 : 16384,
      },
      modalities: { input: input, output: ["text"] },
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
      name: "Command Code",
      options: { baseURL: BASE_URL, apiKey: "local-bridge" },
      models,
    },
  }
}

// -------------------------------------------------------------- the tool

const statusTool = {
  description:
    "Report Command Code bridge health: whether the bridge is reachable, the " +
    "detected plan, remaining credits, the loaded model count, and the " +
    "discovered /alpha/generate schema. Use this to diagnose connectivity or " +
    "to see which models and input types are available.",
  args: {
    detail: { type: "string", optional: true, description: "Set to 'full' for the raw schema dump." },
  },
  async execute(args) {
    const lines = []
    const ok = await isUp(3000)
    if (!ok) {
      const started = await ensureBridge()
      lines.push(`bridge: ${started ? "restarted and healthy" : "UNREACHABLE (start failed)"}`)
      if (!started) return lines.join("\n")
    } else {
      lines.push("bridge: healthy")
    }

    try {
      const r = await fetch(`http://${HOST}:${PORT}/health`)
      const h = await r.json()
      lines.push(`upstream: ${h.upstream?.reachable ? "reachable" : "UNREACHABLE"}`)
      if (h.upstream?.plan) lines.push(`plan: ${h.upstream.plan}`)
      if (h.upstream?.user) lines.push(`account: ${h.upstream.user}`)
      if (h.catalog) lines.push(`models in catalog: ${h.catalog.models}`)
      if (h.schema) lines.push(`schema paths discovered: ${h.schema.paths}`)
      lines.push(`cli version: ${h.cliVersion}`)
    } catch (e) {
      lines.push(`health fetch failed: ${e.message}`)
    }

    const vision = (CATALOG.models || []).filter((m) => m.inputModalities?.includes("image"))
    lines.push(`vision-capable models: ${vision.length}`)
    lines.push(`input modalities supported: ${(PARTS.inputModalitiesOverall || []).join(", ") || "text, image"}`)

    if (args?.detail === "full") {
      lines.push("")
      lines.push("Discovered /alpha/generate fields:")
      for (const [k, v] of Object.entries(SCHEMA.paths || {})) {
        const extra = v.options ? ` = ${v.options.join("|")}` : v.expected !== undefined ? ` = ${v.expected}` : ""
        lines.push(`  ${k}: ${v.kind}${extra} (${v.required ? "required" : "optional"})`)
      }
    }
    return lines.join("\n")
  },
}

// ----------------------------------------------------------------- plugin

export const CommandCodePlugin = async ({ client, directory }) => {
  // Prefer OpenCode's structured log sink when the SDK exposes one.
  if (client?.app?.log) {
    logSink = (m) => {
      client.app
        .log({ body: { service: "commandcode", level: "info", message: m } })
        .catch(() => {})
    }
  }

  // Start the bridge eagerly in the background; do not block plugin init.
  ensureBridge().catch(() => {})

  return {
    // Inject the provider into OpenCode's live config so no opencode.json edit
    // is required. Runs before providers are resolved.
    config: async (cfg) => {
      const provider = buildProvider()
      if (!cfg.provider) cfg.provider = {}
      if (!cfg.provider.commandcode) {
        cfg.provider.commandcode = provider.commandcode
        log(`registered provider "commandcode" with ${Object.keys(provider.commandcode.models).length} models`)
      }
      if (process.env.CMD_DEBUG) {
        log(`config hook: provider keys now = ${Object.keys(cfg.provider).join(",")}`)
        log(`config hook: commandcode present = ${!!cfg.provider.commandcode}`)
      }
    },

    // Keep the bridge alive across the session.
    event: async ({ event }) => {
      if (event.type === "session.idle" || event.type === "session.created") {
        if (!(await isUp(800))) ensureBridge().catch(() => {})
      }
    },

    // Health/diagnostics tool.
    tool: { commandcode_status: statusTool },
  }
}

export default CommandCodePlugin
