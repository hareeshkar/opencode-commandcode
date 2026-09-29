#!/usr/bin/env node
/**
 * install.js — register Command Code as an OpenCode provider.
 *
 * WHY AN INSTALLER RATHER THAN ONLY A PLUGIN
 * ------------------------------------------
 * OpenCode's plugin `config` hook is the ideal injection point, and this package
 * ships a plugin that uses it. But plugin initialisation is not guaranteed on
 * every OpenCode build/channel (we verified that on opencode v2.0.19 the
 * `plugins` config key does not fire for `opencode run` or `opencode serve`,
 * including for previously-working plugins). Provider resolution, by contrast,
 * is stable and always reads `opencode.json`.
 *
 * So the primary, guaranteed path is to write the provider into opencode.json
 * directly. The installer is idempotent, preserves every other key, honours
 * `--dry-run`, and regenerates the model list from the discovered catalog so it
 * never drifts from what the bridge actually serves.
 *
 * Usage:
 *   node install.js                 # install into ~/.config/opencode/opencode.json
 *   node install.js --config <path> # target a specific config
 *   node install.js --remove        # remove the provider
 *   node install.js --dry-run       # print the change, write nothing
 *   node install.js --print         # print the provider block only
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..")
const { classifyPlan, fetchPlanId, DIRECT_API_INSTRUCTIONS } = await import(
  new URL("../src/plan.js", `file://${HERE}/`).href
)
const PROVIDER_ID = "commandcode"
const HOST = process.env.CMD_BRIDGE_HOST || "127.0.0.1"
// The bridge may have auto-selected a different port; ask rather than assume.
let PORT = process.env.CMD_BRIDGE_PORT || "8787"

// Resolve the real port before writing a baseURL into the user's config.
if (!process.env.CMD_BRIDGE_PORT) {
  try {
    const { discoverPort } = await import(new URL("../src/port.js", import.meta.url).href)
    const found = await discoverPort({ host: HOST })
    if (found) PORT = String(found.port)
  } catch {}
}

// Catalog entries that declare no window fall back to a conservative 128k.
const DEFAULT_CONTEXT = Number(process.env.CMD_DEFAULT_CONTEXT || 128000)

const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const val = (n, d) => {
  const i = args.indexOf(n)
  return i > -1 && args[i + 1] ? args[i + 1] : d
}

const CONFIG_PATH = val(
  "--config",
  process.env.OPENCODE_CONFIG ||
    path.join(os.homedir(), ".config", "opencode", "opencode.json"),
)

function readArtifact(name, fallback) {
  try {
    const p = path.join(REPO, name)
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback
  } catch {
    return fallback
  }
}

const CATALOG = readArtifact("catalog.json", { models: [] })
const SCHEMA = readArtifact("schema.generated.json", { paths: {} })

/** Build the provider block straight from the discovered catalog. */
function buildProvider() {
  const models = {}
  for (const m of CATALOG.models || []) {
    const input = m.inputModalities?.length ? m.inputModalities : ["text"]
    const entry = {
      name: m.name || m.id,
      limit: {
        context: m.contextWindow || DEFAULT_CONTEXT,
        output: m.reasoningEfforts?.length ? 65536 : 16384,
      },
      // vision models are flagged so OpenCode only routes image prompts to them
      modalities: { input, output: ["text"] },
    }
    if (m.reasoningEfforts?.length) {
      // `reasoning` belongs INSIDE options on OpenCode v2. A top-level
      // `reasoning` key is a v1 leftover and this build drops it with
      //   "omitted unsupported legacy setting" (one WARN per model, 75 of them
      //   on a 49-model catalog — so the setting silently never applied).
      // Verified against the shape the bailian-token-plan provider uses.
      entry.options = { reasoning: true, reasoningEffort: m.reasoningEfforts[0] }
    }
    models[m.id] = entry
  }
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Command Code",
    options: { baseURL: `http://${HOST}:${PORT}/v1`, apiKey: "local-bridge" },
    models,
  }
}

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
  } catch (e) {
    console.error(`error: ${CONFIG_PATH} is not valid JSON: ${e.message}`)
    process.exit(1)
  }
}

function writeConfig(cfg) {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n")
}

const provider = buildProvider()

if (flag("--print")) {
  console.log(JSON.stringify({ [PROVIDER_ID]: provider }, null, 2))
  process.exit(0)
}

if (flag("--remove")) {
  // ---- plan gate -------------------------------------------------------------
// Installing a bridge on a plan that already has API access is pointless and
// adds a moving part for nothing. Detect the plan and say so, unless the user
// explicitly overrides with --force.
async function checkPlan(force) {
  if (force) return null
  let key
  try {
    const p = process.env.CMD_AUTH_PATH ||
      path.join(os.homedir(), ".commandcode", "auth.json")
    key = process.env.COMMAND_CODE_API_KEY || JSON.parse(readFileSync(p, "utf8")).apiKey
  } catch {
    return null // cannot determine; let them proceed
  }
  let version = "1.69.0"
  try {
    version = JSON.parse(readFileSync(
      path.join(os.homedir(), ".local/lib/node_modules/command-code/package.json"), "utf8")).version
  } catch {}
  try {
    const planId = await fetchPlanId({ apiKey: key, cliVersion: version })
    const info = classifyPlan(planId)
    if (info.needsBridge === false) {
      console.log("")
      console.log(`  You are on the '${planId}' plan, which already includes API access.`)
      console.log("")
      console.log(DIRECT_API_INSTRUCTIONS)
      console.log("")
      process.exit(0)
    }
    if (info.needsBridge === true) {
      console.log(`  plan: ${planId} (Go) -- bridge is the supported path.`)
    }
    return info
  } catch {
    return null
  }
}

if (!flag("--print")) await checkPlan(flag("--force"))

const cfg = readConfig()
  if (cfg.provider && cfg.provider[PROVIDER_ID]) {
    delete cfg.provider[PROVIDER_ID]
    if (flag("--dry-run")) console.log("would remove provider 'commandcode'")
    else {
      writeConfig(cfg)
      console.log(`removed provider 'commandcode' from ${CONFIG_PATH}`)
    }
  } else {
    console.log("provider 'commandcode' is not present; nothing to do")
  }
  process.exit(0)
}

const cfg = readConfig()
if (!cfg.provider) cfg.provider = {}
const existed = !!cfg.provider[PROVIDER_ID]
cfg.provider[PROVIDER_ID] = provider

const modelCount = Object.keys(provider.models).length
const visionCount = Object.values(provider.models).filter(
  (m) => m.modalities?.input?.includes("image"),
).length

if (flag("--dry-run")) {
  console.log(`would ${existed ? "update" : "add"} provider 'commandcode' in ${CONFIG_PATH}`)
  console.log(`  models: ${modelCount} (${visionCount} with image input)`)
  process.exit(0)
}

writeConfig(cfg)
console.log(`${existed ? "updated" : "installed"} provider 'commandcode' in ${CONFIG_PATH}`)
console.log(`  ${modelCount} models registered (${visionCount} accept image input)`)
console.log("")
console.log("Next:")
console.log(`  1. start the bridge:   npm run bridge`)
console.log(`  2. verify:             npm run status`)
console.log(`  3. use a model:        opencode run -m commandcode/deepseek/deepseek-v4.1-flash "hi"`)
