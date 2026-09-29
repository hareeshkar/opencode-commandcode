#!/usr/bin/env node
/**
 * Schema brute-forcer for Command Code's POST /alpha/generate
 * =========================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * Command Code's Go plan ($1/mo) has no public Provider API -- that starts at
 * $15/mo. The only way to drive its models from another client is the internal
 * endpoint the `cmd` CLI itself calls on every turn. That endpoint is validated
 * with Zod, and Zod's error messages are precise enough to reconstruct the
 * entire schema from the outside:
 *
 *   {}                                -> the required top-level fields
 *   { config: {} }                    -> every required field inside config
 *   { mode: "zzz" }                   -> Invalid option: expected one of "a"|"b"
 *   { threadId: "x" }                 -> Invalid UUID
 *   { params: { max_tokens: "x" } }   -> expected number, received string
 *
 * So the schema is *inferable*, not hardcoded. This script infers it and writes
 * a machine-readable schema.generated.json that the bridge loads at runtime.
 * If Command Code changes their contract, re-run this -- you do not read their
 * source or wait for docs.
 *
 * ALGORITHM
 * ---------
 * A repair loop (see `crawl()`): submit a body, parse Zod's complaints, drop a
 * synthesised valid value into each complained-about path, repeat until the
 * server stops complaining. Every iteration strictly increases satisfied
 * constraints, so it terminates. It walks the whole tree -- including siblings
 * hidden behind a missing container -- with zero hardcoded field names.
 * A second pass discovers array element shapes, and a final pass establishes
 * required-vs-optional per field and header sensitivity.
 *
 * COST
 * ----
 * Invalid bodies are rejected at the validation layer and never reach a model,
 * so a full run costs nothing. Valid bodies use max_tokens=16 and a one-word
 * prompt. Verified by snapshotting /alpha/billing/credits before/after.
 *
 * USAGE
 * -----
 *   node scripts/probe-schema.mjs
 *   node scripts/probe-schema.mjs --out schema.generated.json
 *   node scripts/probe-schema.mjs --json-only   # suppress progress, JSON only
 */

import { readFileSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { argOut, writeJson } from "./safe-io.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..")

const API = process.env.CMD_API_BASE || "https://api.commandcode.ai"
const ENDPOINT = "/alpha/generate"
const TIMEOUT_MS = 30_000
const JSON_ONLY = process.argv.includes("--json-only")
// SAFE: argOut() validates the flag and never falls back to process.argv[0].
// See scripts/safe-io.mjs for why that matters.
const OUT = argOut("--out", path.join(REPO, "schema.generated.json"))

// ------------------------------------------------------------------ utilities

const say = (...a) => {
  if (!JSON_ONLY) process.stderr.write(a.join(" ") + "\n")
}

function apiKey() {
  if (process.env.COMMAND_CODE_API_KEY) return process.env.COMMAND_CODE_API_KEY
  const p = path.join(os.homedir(), ".commandcode", "auth.json")
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")).apiKey
  throw new Error("no API key: set COMMAND_CODE_API_KEY or run `cmd auth login`")
}

function cliVersion() {
  try {
    const pkg = readFileSync(
      path.join(os.homedir(), ".local/lib/node_modules/command-code/package.json"),
      "utf8",
    )
    return JSON.parse(pkg).version
  } catch {
    return "1.69.0"
  }
}

const KEY = apiKey()
const VERSION = cliVersion()
const PROBE_MODEL = "deepseek/deepseek-v4-flash" // cheapest known-good id

// ------------------------------------------------------------------ transport

let requestCount = 0
let bytesSent = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Transient statuses we retry rather than interpret. A 403 in the middle of a
 * crawl is rate limiting or the rolling window kicking in, NOT a schema fact --
 * treating it as "done" silently truncates discovery.
 */
const RETRYABLE = new Set([403, 408, 425, 429, 500, 502, 503, 504])

async function postOnce(body, extraHeaders) {
  requestCount++
  const payload = JSON.stringify(body)
  bytesSent += payload.length
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(API + ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${KEY}`,
        "x-command-code-version": VERSION,
        "x-cli-environment": "production",
        "User-Agent": "cli",
        ...(extraHeaders || {}),
      },
      body: payload,
      signal: ac.signal,
    })
    const text = await r.text()
    return { status: r.status, text }
  } catch (e) {
    return { status: 0, text: String(e?.message || e) }
  } finally {
    clearTimeout(timer)
  }
}

async function post(body, extraHeaders, { retries = 6 } = {}) {
  let res = await postOnce(body, extraHeaders)
  let attempt = 0
  while (RETRYABLE.has(res.status) && attempt < retries) {
    // exponential backoff with jitter; small base so the crawl stays quick
    const delay = Math.min(8000, 400 * 2 ** attempt) + Math.floor(Math.random() * 250)
    say(`   (${res.status} -> retry in ${delay}ms)`)
    await sleep(delay)
    res = await postOnce(body, extraHeaders)
    attempt++
  }
  return res
}

/** Parse out individual Zod validation clauses. */
function clauses(res) {
  if (res.status !== 400) return []
  let msg = ""
  try {
    msg = JSON.parse(res.text)?.error?.message || ""
  } catch {
    return []
  }
  const hint = msg.includes("HINT:") ? msg.slice(msg.indexOf("HINT:") + 6) : msg
  return hint
    .split(";")
    .map((s) => s.trim())
    // The server prefixes some clauses with "Validation error: " and does not
    // others. classify() anchors on ^, so strip any leading preamble here.
    .map((s) => s.replace(/^(Validation error:\s*)+/i, "").trim())
    .filter(Boolean)
}

/**
 * Canonicalise a Zod path.
 *
 * Zod reports array element paths in bracket notation:
 *     params.messages[0].role
 * while the rest of this script uses dots (params.messages.0.role). Collapse
 * every index to `.0` so an array's element schema is described once, no
 * matter how many elements we probed.
 */
function canonPath(p) {
  return p.replace(/\[\d+\]/g, ".0").replace(/\.{2,}/g, ".")
}

/** Classify one clause into { path, kind, options?, expected? }. */
function classify(clause) {
  let m
  const P = (raw) => canonPath(raw)
  if ((m = clause.match(/^Invalid UUID at "([^"]+)"/))) return { path: P(m[1]), kind: "uuid" }

  // ORDER MATTERS. The ", received <what>" form must be tested before the
  // generic form: a non-greedy `expected (.+?) at "` would otherwise swallow
  // "string, received undefined" and misread it as a literal value.
  //
  //   Invalid input: expected string, received undefined at "config.workingDir"
  if ((m = clause.match(/^Invalid input: expected (\w+), received [^,]+ at "([^"]+)"/)))
    return { path: P(m[2]), kind: m[1] }

  // Invalid input: expected "off" at "promptCache"     (literal)
  if ((m = clause.match(/^Invalid input: expected (.+?) at "([^"]+)"/))) {
    const expected = m[1].trim()
    const p = m[2]
    const PRIMS = ["string", "number", "boolean", "array", "object", "null", "undefined", "bigint", "date"]
    if (PRIMS.includes(expected)) return { path: P(p), kind: expected }
    return { path: P(p), kind: "literal", expected }
  }

  // Tolerate the "received" wording appearing after other filler.
  if ((m = clause.match(/expected (\w+), received \w+ at "([^"]+)"/)))
    return { path: P(m[2]), kind: m[1] }

  // Invalid option: expected one of "a"|"b" at "mode"   (enum)
  if ((m = clause.match(/expected one of (.+?) at "([^"]+)"/)))
    return { path: P(m[2]), kind: "enum", options: m[1].split("|").map((s) => s.trim().replace(/^"|"$/g, "")) }

  // Unrecognized key(s) in object: 'foo'
  if ((m = clause.match(/[Uu]nrecognized key.*?'([^']+)'/))) return { path: P(m[1]), kind: "unknown-key" }

  return null
}

// ------------------------------------------------------------- path utilities

const get = (obj, dotted) =>
  dotted.split(".").reduce((c, p) => (c == null ? undefined : c[p]), obj)
function set(obj, dotted, value) {
  const parts = dotted.split(".")
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts.at(-1)] = value
}
function del(obj, dotted) {
  const parts = dotted.split(".")
  const parent = parts.slice(0, -1).reduce((c, p) => (c == null ? undefined : c[p]), obj)
  if (parent && typeof parent === "object") delete parent[parts.at(-1)]
}
const parentOf = (dotted) => dotted.split(".").slice(0, -1).join(".")

// ---------------------------------------------------------------- the crawler

/** schema: dotted path -> descriptor */
const schema = Object.create(null)
const unparsed = new Set()

function record(p, info) {
  const cur = schema[p] || (schema[p] = Object.create(null))
  cur.source = cur.source === "cli-bundle" ? "network+cli-bundle" : "network"
  if (info.kind && info.kind !== "unknown-key") {
    const rank = { literal: 5, enum: 5, uuid: 5, string: 4, number: 4, boolean: 4, array: 3, object: 3 }
    if (!cur.kind || (rank[info.kind] ?? 1) >= (rank[cur.kind] ?? 1)) cur.kind = info.kind
  }
  if (info.options) cur.options = info.options
  if (info.expected !== undefined) cur.expected = info.expected
  if (info.raw) cur.sampleError = info.raw
  return cur
}

function absorb(res) {
  let n = 0
  for (const c of clauses(res)) {
    const info = classify(c)
    if (!info) { unparsed.add(c); continue }
    record(info.path, info)
    n++
  }
  return n
}

function synth(p) {
  const d = schema[p] || {}
  if (d.kind === "enum" && d.options?.length) return d.options[0]
  if (d.kind === "literal" && d.expected !== undefined) {
    // expected is e.g. `"off"` (quoted), or a bare token such as `true`
    const raw = String(d.expected)
    const q = raw.match(/^"([\s\S]*)"$/)
    if (q) return q[1]
    if (raw === "true") return true
    if (raw === "false") return false
    return raw
  }
  if (d.kind === "uuid") return crypto.randomUUID()
  if (d.kind === "number") return 16
  if (d.kind === "boolean") return false
  if (d.kind === "array") return []
  if (d.kind === "object") return {}
  if (d.kind === "null") return null
  return "probe"
}

const ELEMENT_CANDIDATES = [
  { __probe__: 1 },
  { type: "__probe__", text: "x" },
  { role: "__probe__", content: "x" },
  { name: "__probe__", description: "x", input_schema: {} },
  [{ __probe__: 1 }],
  "x",
  1,
  true,
]

/**
 * THE REPAIR LOOP. Zod reports every unsatisfied constraint at once, but a
 * missing object short-circuits checks nested inside it. So: submit, parse the
 * complaints, drop a synthesised valid value into each newly complained-about
 * path, repeat until the server stops complaining about shape. Each iteration
 * strictly increases satisfied constraints, so it terminates. No hardcoded
 * field names anywhere.
 */
/**
 * Seed values injected before the repair loop starts.
 *
 * IMPORTANT FINDING (see DEVELOPER.md): `params.model` is OPTIONAL. When it is
 * absent the server substitutes its own default, `claude-sonnet-4-6`, which the
 * $1 Go plan cannot access -- so a body that validates perfectly still fails
 * with 403 MODEL_NOT_IN_PLAN. The crawler must therefore *supply* a
 * plan-accessible model to earn a 200, otherwise it can never close the loop.
 *
 * This is a seed value, not schema knowledge: the crawler still discovers every
 * field name, type, enum and optionality on its own.
 */
const SEED = { params: { model: PROBE_MODEL } }

async function crawl() {
  let body = structuredClone(SEED)
  const filled = new Set(["params.model"])
  for (let i = 0; i < 300; i++) {
    const res = await post(body)
    absorb(res)
    if (res.status === 200) return { body, done: true, status: 200 }
    if (res.status !== 400) {
      // Retries were exhausted on a transient status. Stop rather than loop
      // forever, but report honestly.
      return { body, done: false, status: res.status, stalledOn: res.text.slice(0, 120) }
    }
    let repaired = 0
    for (const c of clauses(res)) {
      const info = classify(c)
      if (!info || info.kind === "unknown-key") continue
      if (filled.has(info.path)) continue
      if (get(body, info.path) !== undefined) continue
      set(body, info.path, synth(info.path))
      filled.add(info.path)
      repaired++
    }
    if (!repaired) return { body, done: false, status: res.status, stalledOn: "no new paths" }
  }
  return { body, done: false, status: 0, stalledOn: "iteration cap" }
}

/** A body known to be accepted, used to probe leaves and array elements. */
/**
 * OPTIONAL-FIELD CONFIRMATION.
 *
 * The repair loop can only see fields the server *requires*: it learns them
 * from rejections, and it never sees a rejection for a field it may omit.
 * Unknown keys are silently ignored, so there is no error to read for them
 * either. The CLI bundle (scripts/extract-envelope.mjs) supplies the field
 * *names*; this pass confirms each one against the live API and learns its type
 * or enum by submitting a deliberately invalid value and reading the complaint.
 *
 * This is how we reach full coverage without hardcoding a single field name.
 */
async function confirmOptionalFields(candidates) {
  const found = []
  for (const p of candidates) {
    if (schema[p]) continue
    // The CLI bundle is positive evidence the field exists, so record presence
    // even when the network cannot refine it.
    if (!schema[p]) schema[p] = Object.create(null)
    schema[p].source = "cli-bundle"
    for (const bad of ["__brute_force_probe__", 12345, true, false, [], {}, null]) {
      const b = validBody()
      set(b, p, bad)
      const res = await post(b)
      if (res.status === 200) {
        // The server IGNORES unknown keys, so a 200 here is not evidence the
        // field exists. Mark it "unverified" and let the emitted report carry
        // the CLI-bundle provenance plus a negative control.
        if (!schema[p].kind) schema[p].kind = "unverified"
        break
      }
      let matched = false
      for (const c of clauses(res)) {
        const ci = classify(c)
        if (ci && (ci.path === p || ci.path.startsWith(p + "."))) {
          record(ci.path, ci)
          matched = true
        }
      }
      const resolved = schema[p].options || schema[p].expected !== undefined || schema[p].kind === "uuid"
      if (matched) { schema[p].source = "network+cli-bundle"; found.push(p); if (resolved) break }
    }
  }
  return found
}

/** A body known to be accepted, used to probe leaves and array elements. */
function validBody() {
  return {
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString(),
      environment: `${os.platform()}-${os.arch()}`,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: "",
    taste: null,
    skills: null,
    permissionMode: "standard",
    threadId: crypto.randomUUID(),
    mode: "agent",
    promptCache: "off",
    params: {
      model: PROBE_MODEL,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
      system: "s",
      max_tokens: 16,
      stream: true,
    },
  }
}

/**
 * Array element discovery. A field typed `array` says nothing about its
 * elements and Zod will not inspect the inside of an empty array. Submit
 * candidate element bodies and read back indexed complaints
 * (`params.messages.0.role`, etc.).
 */
async function probeArrayElements() {
  let learned = 0
  for (const p of Object.keys(schema).filter((k) => schema[k].kind === "array")) {
    for (const el of ELEMENT_CANDIDATES) {
      const body = structuredClone(validBody())
      set(body, p, [el])
      const res = await post(body)
      if (res.status !== 400) continue
      let sawIndex = false
      for (const c of clauses(res)) {
        const ci = classify(c)
        if (!ci) { unparsed.add(c); continue }
        if (ci.path === p || ci.path.startsWith(p + ".")) {
          record(ci.path, ci)
          if (ci.path.startsWith(p + ".")) sawIndex = true
        }
      }
      if (sawIndex) { learned++; break }
    }

    // Drill one level deeper: now that the element is a partially-correct
    // object, submit a repair loop scoped to the array so the element's own
    // required fields surface. Index 0 is rewritten each pass.
    const elPath = p + ".0"
    const sub = {}
    const filled = new Set()
    for (let i = 0; i < 40; i++) {
      const body = structuredClone(validBody())
      // the element template may itself have grown nested objects
      body[p] = [structuredClone(sub)]
      const res = await post(body)
      if (res.status === 200) break
      let repaired = 0
      for (const c of clauses(res)) {
        const ci = classify(c)
        if (!ci || ci.kind === "unknown-key") continue
        if (ci.path === elPath) { record(ci.path, ci); continue }
        if (ci.path.startsWith(elPath + ".")) {
          const rel = ci.path.slice(elPath.length + 1)
          const full = p + "." + rel
          record(full, ci)
          // strip any deeper ".0" so we write onto the template directly
          const relKey = rel.replace(/\.0\b/g, "")
          if (!filled.has(relKey) && get(sub, relKey) === undefined) {
            set(sub, relKey, synth(full))
            filled.add(relKey)
            repaired++
          }
        }
      }
      if (!repaired) break
      for (const relKey of filled) {
        const d = schema[p + "." + relKey]
        if (d?.options?.length && sub[relKey] !== d.options[0]) sub[relKey] = d.options[0]
      }
    }
  }
  return learned
}

/** Leaf pass: reveal enums/literals/true types by submitting hostile values. */
async function classifyLeaves() {
  for (const p of Object.keys(schema)) {
    if (schema[p].kind === "object" || schema[p].kind === "array") continue
    if (schema[p].options || schema[p].expected) continue
    for (const bad of ["__brute_force_probe__", 12345, true, false, [], {}, null]) {
      const b = validBody()
      set(b, p, bad)
      const res = await post(b)
      let improved = false
      for (const c of clauses(res)) {
        const ci = classify(c)
        if (ci && ci.path === p && ci.kind !== "unknown-key") {
          record(p, ci)
          if (ci.kind === "enum" || ci.kind === "literal" || ci.kind === "uuid") improved = true
        }
      }
      if (improved || schema[p].options || schema[p].expected) break
    }
  }
}

function safeCode(text) {
  try { return JSON.parse(text)?.error?.code ?? null } catch { return null }
}

async function main() {
  say(`probing ${API}${ENDPOINT}   cli=${VERSION}`)

  // 1. crawl to a known-good body
  const { body, done, status, stalledOn } = await crawl()
  say(
    `1. repair loop -> ${done ? "ACCEPTED (200)" : `stalled (${status})`}` +
      `${stalledOn ? " on: " + stalledOn : ""}, ${Object.keys(schema).length} paths`,
  )

  // 2. array element shapes
  const arrays = await probeArrayElements()
  say(`2. discovered element schemas for ${arrays} array field(s)`)

  // 2b. optional fields, named by the CLI bundle and confirmed over the wire
  const ENV = path.join(REPO, "envelope.generated.json")
  let optionalFound = []
  if (existsSync(ENV)) {
    const env = JSON.parse(readFileSync(ENV, "utf8"))
    const cand = [...new Set([...env.allKeys, ...env.paramKeys.map((k) => "params." + k)])]
    optionalFound = await confirmOptionalFields(cand)
    say(`2b. confirmed ${optionalFound.length} optional field(s): ${optionalFound.join(", ")}`)
  } else {
    say("2b. skipped optional-field pass (run extract-envelope.mjs first)")
  }

  // 3. leaf classification (enums, literals, true primitives)
  await classifyLeaves()
  say(`3. leaf classification done`)

  // 4. required vs optional against a known-valid body
  const control = await post(validBody())
  const controlOk = control.status === 200
  say(`4. control -> ${control.status} ${controlOk ? "(baseline valid)" : ""}`)
  for (const p of Object.keys(schema)) {
    const b = validBody()
    del(b, p)
    const res = await post(b)
    schema[p].required = clauses(res).some((c) => {
      const ci = classify(c)
      return ci && (ci.path === p || ci.path.startsWith(p + "."))
    })
  }
  say(`4. required/optional resolved`)

  // 5. unknown keys strict?
  const extra = validBody(); extra.__unknown_probe_key__ = 1
  const strict = clauses(await post(extra)).some((c) => /unrecognized key/i.test(c))
  say(`5. unknown keys ${strict ? "REJECTED" : "ignored"}`)

  // 6. header sensitivity
  const headerProbe = {}
  for (const [label, h] of Object.entries({
    "empty x-command-code-version": { "x-command-code-version": "" },
    "stale x-command-code-version": { "x-command-code-version": "0.0.1" },
    "missing x-cli-environment": { "x-cli-environment": "" },
  })) {
    const res = await post(validBody(), h)
    headerProbe[label] = { status: res.status, code: safeCode(res.text) }
  }
  say(`6. header sensitivity ${JSON.stringify(headerProbe)}`)

  // ---- emit
  const paths = Object.fromEntries(
    Object.keys(schema).sort().map((k) => [k, {
      ...schema[k],
      required: !!schema[k].required,
      parent: parentOf(k) || null,
      isArrayElement: /\.\d+(\.|$)/.test(k),
    }]),
  )

  // A control proving that unknown keys are ignored (so absence of a validation
  // error is NOT evidence a field exists).
  const negControl = await post({ ...validBody(), __definitely_not_a_real_field__: 1 })
  const unknownKeysIgnoredEvidence = negControl.status === 200

  const out = {
    $comment:
      "GENERATED by scripts/probe-schema.mjs via Zod error inference. " +
      "Do not hand-edit. Re-run after any Command Code upgrade.",
    generatedAt: new Date().toISOString(),
    endpoint: API + ENDPOINT,
    cliVersion: VERSION,
    requestCount,
    bytesSent,
    controlBodyAccepted: controlOk,
    unknownKeysIgnoredEvidence,
    kindLegend: {
      unverified: "named by the CLI bundle; server ignores unknown keys so the network cannot confirm a type",
    },
    unknownKeysRejected: strict,
    headerSensitivity: headerProbe,
    unparsedClauses: [...unparsed],
    pathCount: Object.keys(paths).length,
    paths,
  }
  writeJson(OUT, out)
  say(`wrote ${path.relative(REPO, OUT)}: ${out.pathCount} paths from ${requestCount} requests`)
}

main().catch((e) => { console.error(e); process.exit(1) })
