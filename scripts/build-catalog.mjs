#!/usr/bin/env node
// Merge two sources into the shipping catalog.json:
//
//   1. STATIC  - parsed from the installed command-code CLI bundle. This is the
//                authoritative declaration of contextWindow, inputModalities
//                and reasoningEfforts, but it does NOT know which models your
//                plan can actually call.
//   2. LIVE    - probed against /alpha/generate. Ground truth for reachability
//                on your specific plan.
//
// Merge rule: only models that are BOTH in the static catalog AND reachable.
// Reachability is re-probed on demand by `npm run probe`; a cached result is
// used when the API is unreachable (e.g. offline) so the bridge still starts.
//
// Usage:
//   node scripts/build-catalog.mjs            # uses cached reachability
//   node scripts/build-catalog.mjs --probe    # re-probes first (spends credits)

import { readFileSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTRACTED = path.join(ROOT, "catalog.extracted.json")
const CACHE = path.join(ROOT, "catalog.reachability.json")
const OUT = path.join(ROOT, "catalog.json")

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"))

function apiKey() {
  if (process.env.COMMAND_CODE_API_KEY) return process.env.COMMAND_CODE_API_KEY
  const p = path.join(os.homedir(), ".commandcode", "auth.json")
  if (existsSync(p)) return readJson(p).apiKey
  throw new Error("no key")
}
function cliVersion() {
  try {
    return readJson(
      path.join(os.homedir(), ".local/lib/node_modules/command-code/package.json"),
    ).version
  } catch {
    return "1.69.0"
  }
}

const VERSION = cliVersion()

// Minimal, schema-correct /alpha/generate call. We deliberately ask the model
// to emit one token so the probe is as cheap as possible.
async function probeModel(id, key) {
  const body = {
    config: {
      workingDir: ROOT,
      date: new Date().toISOString(),
      environment: `${os.platform()}-${os.arch()}`,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: null, taste: null, skills: null,
    permissionMode: "standard",
    threadId: crypto.randomUUID(),
    mode: "agent",
    promptCache: "off",
    params: {
      model: id,
      messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single word OK" }] }],
      tools: [],
      system: "You are terse.",
      max_tokens: 16,
      stream: true,
    },
  }
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), 45_000)
  try {
    const r = await fetch("https://api.commandcode.ai/alpha/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "x-command-code-version": VERSION,
        "x-cli-environment": "production",
        "User-Agent": "cli",
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    if (!r.ok) {
      const t2 = await r.text().catch(() => "")
      let m = ""
      try { m = JSON.parse(t2).error?.message || "" } catch {}
      return { reachable: false, status: r.status, reason: m.slice(0, 160) }
    }
    // drain
    for await (const _ of r.body) { /* consume */ }
    return { reachable: true, status: 200 }
  } catch (e) {
    return { reachable: false, status: 0, reason: String(e.message).slice(0, 160) }
  } finally {
    clearTimeout(t)
  }
}

const extracted = readJson(EXTRACTED)

// ---- optional live re-probe
if (process.argv.includes("--probe")) {
  const key = apiKey()
  const cache = {}
  const list = extracted.models
  process.stderr.write(`probing ${list.length} models against /alpha/generate...\n`)
  // sequential: parallel requests would trip the 5h window limiter
  for (const [i, m] of list.entries()) {
    const res = await probeModel(m.id, key)
    cache[m.id] = res
    process.stderr.write(
      `  [${String(i + 1).padStart(2)}/${list.length}] ${res.reachable ? "OK  " : "BLOCK"} ${m.id}\n`,
    )
  }
  writeFileSync(CACHE, JSON.stringify({ probedAt: new Date().toISOString(), cliVersion: VERSION, results: cache }, null, 2))
  process.stderr.write(`wrote ${path.relative(ROOT, CACHE)}\n`)
}

const reach = existsSync(CACHE)
  ? readJson(CACHE).results
  : {}

// When there is no reachability data yet, fall back to the full static list so
// the bridge is still useful; `npm run probe` narrows it afterwards.
const offline = Object.keys(reach).length === 0

// A handful of catalog entries declare no contextWindow upstream. Rather than
// shipping null (which makes downstream context budgeting NaN), fall back to a
// conservative 128k -- the smallest window any reachable model truly supports --
// and record which entries were defaulted so the behaviour stays auditable.
const DEFAULT_CONTEXT = Number(process.env.CMD_DEFAULT_CONTEXT || 128000)

const models = extracted.models
  .filter((m) => offline || reach[m.id]?.reachable)
  .map((m) => ({
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow || DEFAULT_CONTEXT,
    ...(m.contextWindow ? {} : { contextWindowDefaulted: true }),
    inputModalities: m.inputModalities,
    reasoning: !!m.reasoningEfforts?.length,
    reasoningEfforts: m.reasoningEfforts,
  }))
  .sort((a, b) => a.id.localeCompare(b.id))

const defaulted = models.filter((m) => m.contextWindowDefaulted).map((m) => m.id)

const out = {
  $comment:
    "Generated by scripts/build-catalog.mjs. Do not hand-edit. " +
    "Run `npm run catalog` to regenerate.",
  cliVersion: VERSION,
  generatedAt: new Date().toISOString(),
  reachabilitySource: offline ? "none (offline fallback: full static list)" : "live probe",
  staticModelCount: extracted.models.length,
  shippableModelCount: models.length,
  contextWindowDefaulted: defaulted,
  modalitiesSeen: [...new Set(extracted.models.flatMap((m) => m.inputModalities || []))].sort(),
  models,
}
writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n")
process.stderr.write(
  `catalog.json: ${models.length}/${extracted.models.length} models shippable ` +
  `(${out.reachabilitySource}); modalities seen: ${out.modalitiesSeen.join(", ")}\n`,
)
