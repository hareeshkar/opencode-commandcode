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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PROVIDER_ID = "commandcode"
const PORT = process.env.CMD_BRIDGE_PORT || "8787"
const HOST = process.env.CMD_BRIDGE_HOST || "127.0.0.1"
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
      entry.reasoning = true
      entry.options = { reasoningEffort: m.reasoningEfforts[0] }
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
