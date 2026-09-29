#!/usr/bin/env node
/**
 * opencode-cc-go CLI
 *
 *   status              show bridge health, plan, credits and model count
 *   doctor              diagnose a broken install (key, node, port, catalog)
 *   start [port]        start the bridge in the foreground
 *   models [--vision]   list the models the catalog will register
 *   schema [--json]     print the discovered /alpha/generate schema
 *   discover            regenerate catalog + schema + parts from the live API
 *
 * Zero dependencies; only Node built-ins.
 */

import { spawn } from "node:child_process"
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..")
const HOST = process.env.CMD_BRIDGE_HOST || "127.0.0.1"

// The bridge auto-selects a free port, so never assume 8787 -- ask. Resolved
// before any route is contacted.
let PORT = Number(process.env.CMD_BRIDGE_PORT || 8787)
const { discoverPort } = await import(new URL("../src/port.js", import.meta.url).href)
const { syncBaseURL, checkDrift, defaultConfigPath } =
  await import(new URL("../src/config-sync.js", import.meta.url).href)
if (!process.env.CMD_BRIDGE_PORT) {
  const found = await discoverPort({ host: HOST })
  if (found) PORT = found.port
}

const read = (n, f) => {
  try { const p = path.join(REPO, n); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : f }
  catch { return f }
}
const catalog = read("catalog.json", { models: [] })
const schema = read("schema.generated.json", { paths: {} })
const parts = read("parts.generated.json", { inputModalitiesOverall: [] })

const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m` }

async function health() {
  try {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 2500)
    const r = await fetch(`http://${HOST}:${PORT}/health`, { signal: ac.signal }); clearTimeout(t)
    return await r.json()
  } catch { return null }
}

/**
 * Config keys OpenCode discarded as legacy, read from its own log.
 *
 * These produce no error anywhere else: the config parses, requests succeed, and
 * the setting is simply never applied. The only trace is a
 * "configuration normalization diagnostic" WARN, so that is what we read.
 *
 * Only the tail of the log is scanned — the file grows without bound — and
 * only entries NEWER than the config file are considered. Without that scope the
 * check reports problems that were already fixed, because the log is append-only
 * and a corrected config leaves the old warnings behind forever.
 */
function droppedConfigKeys(providerId = "commandcode") {
  const logPath = path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    "opencode", "log", "opencode.log",
  )
  let text
  try {
    // Warnings describe the config as it was when OpenCode read it, so anything
    // older than the config's own mtime is describing a superseded version.
    const since = statSync(defaultConfigPath()).mtimeMs
    const fd = openSync(logPath, "r")
    const len = statSync(logPath).size
    const start = Math.max(0, len - 2 * 1024 * 1024)
    const buf = Buffer.alloc(len - start)
    readSync(fd, buf, 0, buf.length, start)
    closeSync(fd)
    text = buf
      .toString("utf8")
      .split("\n")
      .filter((line) => {
        const m = line.match(/^timestamp=(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/)
        return m ? Date.parse(m[1]) >= since : false
      })
      .join("\n")
  } catch { return [] }

  const out = []
  for (const line of text.split("\n")) {
    if (!line.includes("normalization diagnostic")) continue
    const m = line.match(/path=(\S+?)\.(\S+)\s+kind=(\S+)/)
    if (!m) continue
    const [, provider, key, kind] = m
    if (!line.includes(`provider.${providerId}.`)) continue
    if (kind !== "unsupported") continue
    out.push(`${provider}.${key} (${kind})`)
  }
  return [...new Set(out)]
}

async function credits() {
  try {
    const key = process.env.COMMAND_CODE_API_KEY ||
      JSON.parse(readFileSync(path.join(os.homedir(), ".commandcode", "auth.json"), "utf8")).apiKey
    let v = "1.69.0"
    try { v = JSON.parse(readFileSync(path.join(os.homedir(), ".local/lib/node_modules/command-code/package.json"), "utf8")).version } catch {}
    const r = await fetch("https://api.commandcode.ai/alpha/billing/credits", {
      headers: { Authorization: `Bearer ${key}`, "x-command-code-version": v },
    })
    return await r.json()
  } catch { return null }
}

const cmd = process.argv[2] || "status"
const flag = (n) => process.argv.includes(n)

if (cmd === "status" || cmd === "doctor") {
  const h = await health()
  console.log(c.b("opencode-cc-go"))
  if (h?.plan) {
    const p = h.plan
    const line = p.needsBridge === true
      ? `${c.g("Go ($1)")} ${c.d("(needs this bridge - no Provider API)")}`
      : p.needsBridge === false
        ? `${c.y(p.label)} ${c.d("(already has API access - you do not need this bridge)")}`
        : `${c.d(p.id || "unknown plan")}`
    console.log(`  plan          ${line}`)
  }
  console.log(`  bridge        ${h ? c.g("healthy") : c.r("unreachable")}  (http://${HOST}:${PORT})`)
  const drift = checkDrift({ port: PORT, host: HOST })
  if (drift.inSync) {
    console.log(`  opencode.json ${c.g("in sync")}  ${c.d(drift.configured)}`)
  } else {
    console.log(`  opencode.json ${c.y("OUT OF SYNC")}  ${c.d(drift.note)}`)
  }
  if (h) {
    const up = h?.upstream
  const upText = up?.pending ? c.y("checking…")
    : up?.reachable ? c.g("reachable")
    : c.r("unreachable")
  console.log(`  upstream      ${upText}  ${c.d(up?.base || "")}`)
    if (h.upstream?.user) console.log(`  account       ${h.upstream.user}`)
    if (h.cliVersion) console.log(`  cli version   ${h.cliVersion}`)
    console.log(`  catalog       ${h.catalog?.models} models ${c.d(`(${h.catalog?.generatedAt?.slice(0, 10)})`)}`)
    console.log(`  schema        ${h.schema?.paths} paths ${c.d(`(${h.schema?.generatedAt?.slice(0, 10)})`)}`)
  }
  if (h?.plan?.needsBridge === false) {
    console.log("")
    console.log(c.y(`  This package is for the $1 Go plan only.`))
    console.log(`  ${h.plan.note}`)
  }
  const cr = await credits()
  if (cr) {
    console.log(`  credits       ${cr.credits.monthlyCredits} / 10 ${c.d("this cycle")}`)
    const w = cr.windowLimits
    if (w?.fiveHour) console.log(`  5h window     ${w.fiveHour.used} / ${w.fiveHour.cap} used`)
    if (w?.weekly) console.log(`  weekly window ${w.weekly.used} / ${w.weekly.cap} used`)
  }
  const vision = (catalog.models || []).filter((m) => m.inputModalities?.includes("image"))
  console.log(`  modalities    ${(parts.inputModalitiesOverall || []).join(", ") || "text, image"}`)
  console.log(`  vision models ${vision.length} of ${(catalog.models || []).length}`)
  if (cmd === "doctor") {
    let bad = false
    if (!h) {
      console.log(c.y("\n  Bridge is down. Start it with:  opencode-cc-go start"))
      bad = true
    } else if (h.upstream?.pending) {
      console.log(c.dim("\n  upstream check still in progress; run status again in a moment"))
    }
    if (!drift.inSync) {
      console.log(c.y(`\n  ${drift.note}`))
      console.log(`  Fix it with:  opencode-cc-go sync`)
      if (h) bad = true
    }

    // OpenCode silently discards config keys it considers legacy, with only a
    // log line to show for it. A top-level `reasoning` on a model is the case
    // that bit this package: 75 warnings, zero effect, everything still "worked".
    // Nothing in the config or the API response reveals it, so read the log.
    const dropped = droppedConfigKeys()
    if (dropped.length) {
      console.log(c.y(`\n  OpenCode discarded ${dropped.length} unsupported config key(s):`))
      for (const d of dropped.slice(0, 5)) console.log(`    ${d}`)
      if (dropped.length > 5) console.log(c.d(`    …and ${dropped.length - 5} more`))
      console.log(c.d("  Reinstall the provider to regenerate it:  opencode-cc-go install"))
      bad = true
    }
    if (bad) process.exit(1)
    console.log(c.g("\n  all good"))
  }
} else if (cmd === "start") {
  const p = spawn(process.execPath, [path.join(REPO, "src", "bridge.js")], { stdio: "inherit", env: { ...process.env, CMD_BRIDGE_PORT: String(PORT) } })
  p.on("exit", (code) => process.exit(code ?? 0))
} else if (cmd === "sync") {
  // One-shot repair for drift the bridge could not fix itself, e.g. the config
  // was edited by hand, or a dotfile manager reverted it.
  const r = syncBaseURL({ port: PORT, host: HOST })
  if (r.changed) {
    console.log(c.g(`updated ${defaultConfigPath()}`))
    console.log(`  ${r.from} -> ${r.to}`)
    console.log(c.d("  restart OpenCode if it is currently running"))
  } else {
    console.log(r.reason === "already correct" ? c.g("already in sync") : c.y(r.reason))
  }
} else if (cmd === "models") {
  const only = flag("--vision")
  for (const m of catalog.models || []) {
    if (only && !m.inputModalities?.includes("image")) continue
    const mods = (m.inputModalities || ["text"]).join("+")
    console.log(`  ${m.id.padEnd(40)} ${String(m.contextWindow || "?").padStart(9)}  ${mods}`)
  }
} else if (cmd === "schema") {
  if (flag("--json")) { console.log(JSON.stringify(schema, null, 2)) }
  else {
    console.log(c.b(`/alpha/generate  (${schema.pathCount} paths, discovered)`))
    for (const [k, v] of Object.entries(schema.paths || {})) {
      const ex = v.options ? ` = ${v.options.join("|")}` : v.expected !== undefined ? ` = ${v.expected}` : ""
      console.log(`  ${k.padEnd(34)} ${String(v.kind).padEnd(10)} ${v.required ? "required" : "optional"}${c.d(ex)}`)
    }
    console.log(c.d("\n  input part types:"))
    for (const p of parts.partTypes || []) console.log(c.d(`    ${p.type.padEnd(26)} ${p.modalities.join(",")}`))
  }
} else if (cmd === "discover") {
  const steps = [
    ["catalog", "extract + build catalog", ["scripts/extract-catalog.mjs", "scripts/build-catalog.mjs"]],
    ["envelope", "extract CLI envelope", ["scripts/extract-envelope.mjs"]],
    ["schema", "brute-force the schema", ["scripts/probe-schema.mjs"]],
    ["parts", "map content-part union", ["scripts/probe-parts.mjs"]],
  ]
  for (const [name, desc, files] of steps) {
    console.log(c.b(`\n== ${name}: ${desc}`))
    for (const f of files) {
      const r = spawn(process.execPath, [path.join(REPO, f)], { stdio: "inherit" })
      const code = await new Promise((res) => r.on("exit", res))
      if (code !== 0) { console.log(c.r(`  ${f} failed (${code})`)); process.exit(code ?? 1) }
    }
  }
  console.log(c.g("\ndiscovery complete"))
} else {
  console.log(`usage: opencode-cc-go <status|doctor|sync|start|models|schema|discover>`)
  process.exit(1)
}
