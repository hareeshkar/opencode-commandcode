/**
 * opencode-commandcode — the bridge server
 *
 * A dependency-free Node HTTP server that presents an OpenAI-compatible
 * /v1/chat/completions + /v1/models surface and forwards to Command Code's
 * internal POST /alpha/generate, translating both directions.
 *
 * Design goals
 * ------------
 *  - ZERO dependencies. Node built-ins only, so it runs anywhere Node runs.
 *  - Schema-driven. Uses the generated schema/catalog artifacts, not a
 *    hand-maintained field list.
 *  - Streaming-correct. Emits OpenAI SSE from the wire's NDJSON event stream,
 *    including tool calls and reasoning content, and always reports usage.
 *  - Self-describing. /health, /__introspect expose what it knows.
 */

import { createServer } from "node:http"
import { readFileSync, existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { toWire, toWireTools, finishMap, toOpenAIUsage } from "./translate.js"
import { classifyPlan, fetchPlanId } from "./plan.js"
import { findAvailablePort, writeState, clearState, isServing, localAddresses, DEFAULT_PORT } from "./port.js"
import { syncBaseURL, checkDrift } from "./config-sync.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..")

// ------------------------------------------------------------------ config

// Resolved at startup: the preferred port if it is free, otherwise the next
// free port above it. Mutated by resolvePort() before the server listens.
let PORT = Number(process.env.CMD_BRIDGE_PORT || DEFAULT_PORT)
let PORT_STRATEGY = "preferred"
const HOST = process.env.CMD_BRIDGE_HOST || "127.0.0.1"
const API_BASE = process.env.CMD_API_BASE || "https://api.commandcode.ai"
const AUTH_PATH = process.env.CMD_AUTH_PATH || path.join(os.homedir(), ".commandcode", "auth.json")
const CLI_PKG = path.join(os.homedir(), ".local/lib/node_modules/command-code/package.json")

// -------------------------------------------------------------- artifacts

function loadArtifact(name, fallback) {
  const p = path.join(REPO, name)
  try {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"))
  } catch {}
  return fallback
}

const CATALOG = loadArtifact("catalog.json", { models: [], modalitiesSeen: [] })
const SCHEMA = loadArtifact("schema.generated.json", { paths: {} })
const PARTS = loadArtifact("parts.generated.json", { partTypes: [] })

/** Resolve a documented default from the generated schema, else the fallback. */
function schemaDefault(pathName, fallback) {
  const p = SCHEMA.paths?.[pathName]
  if (!p) return fallback
  if (p.kind === "enum" && p.options?.length) return p.options[0]
  if (p.kind === "literal" && p.expected !== undefined) {
    const m = String(p.expected).match(/^"([\s\S]*)"$/)
    return m ? m[1] : p.expected
  }
  return fallback
}

// The `mode` the bridge uses for ordinary chat turns. Taken from the schema's
// first enum option so a future rename of "agent" does not break us.
const DEFAULT_MODE = schemaDefault("mode", "agent")
const PERMISSION_MODES = SCHEMA.paths?.permissionMode?.options || ["default", "standard", "auto-accept", "plan", "bypass"]
const PROMPT_CACHE = schemaDefault("promptCache", "off")

// Fallback context window for catalog entries that declare none. 128k is the
// smallest window any reachable model actually supports, so budgeting against
// it is conservative and safe.
const DEFAULT_CONTEXT_WINDOW = Number(process.env.CMD_DEFAULT_CONTEXT || 128000)

// ------------------------------------------------------------ credentials

let cachedKey = null
let cachedKeyAt = 0
const KEY_TTL_MS = 60_000

function readApiKey() {
  if (process.env.COMMAND_CODE_API_KEY) return process.env.COMMAND_CODE_API_KEY.trim()
  const now = Date.now()
  if (cachedKey && now - cachedKeyAt < KEY_TTL_MS) return cachedKey
  try {
    const j = JSON.parse(readFileSync(AUTH_PATH, "utf8"))
    if (j.apiKey) {
      cachedKey = j.apiKey.trim()
      cachedKeyAt = now
      return cachedKey
    }
  } catch {}
  throw new Error("No Command Code API key. Run `cmd auth login` or set COMMAND_CODE_API_KEY.")
}

let cachedVersion = null
function cliVersion() {
  if (cachedVersion) return cachedVersion
  try {
    cachedVersion = JSON.parse(readFileSync(CLI_PKG, "utf8")).version || "1.69.0"
  } catch {
    cachedVersion = "1.69.0"
  }
  return cachedVersion
}

// ------------------------------------------------------------- project ctx

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim()
  } catch { return "" }
}

/**
 * The `config` block the CLI sends on every turn: a lightweight description of
 * the working project. Every field is REQUIRED by the discovered schema.
 */
function buildConfig(workingDir) {
  const dir = workingDir || process.cwd()
  const isGitRepo = git(["rev-parse", "--is-inside-work-tree"], dir) === "true"
  return {
    workingDir: dir,
    date: new Date().toISOString(),
    environment: `${os.platform()}-${os.arch()}`,
    structure: [],
    isGitRepo,
    currentBranch: isGitRepo ? git(["rev-parse", "--abbrev-ref", "HEAD"], dir) : "",
    mainBranch: isGitRepo ? git(["rev-parse", "--abbrev-ref", "main"], dir) || "main" : "",
    gitStatus: isGitRepo ? git(["status", "--porcelain"], dir) : "",
    recentCommits: isGitRepo ? git(["log", "-5", "--pretty=format:%h %s"], dir).split("\n").filter(Boolean) : [],
  }
}

// ------------------------------------------------------------- NDJSON read

async function* ndjson(res) {
  const dec = new TextDecoder()
  let buf = ""
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try { yield JSON.parse(line) } catch {}
    }
  }
  const tail = buf.trim()
  if (tail) { try { yield JSON.parse(tail) } catch {} }
}

// ------------------------------------------------------------------ errors

const err = (message, type = "server_error", code = null) => ({ error: { message, type, code, param: null } })

function httpErrorType(status) {
  if (status === 401) return "authentication_error"
  if (status === 403) return "permission_error"
  if (status === 429) return "rate_limit_error"
  if (status >= 500) return "server_error"
  return "invalid_request_error"
}

// ------------------------------------------------------------- the request

function buildEnvelope(body, workingDir) {
  const { messages, system } = toWire(body.messages || [])
  const params = {
    model: body.model,
    messages,
    tools: toWireTools(body.tools),
    system: system || "You are a helpful assistant.",
    max_tokens: body.max_completion_tokens ?? body.max_tokens ?? 32000,
    stream: true,
  }
  if (body.temperature !== undefined && body.temperature !== null) params.temperature = body.temperature
  if (body.reasoning_effort && body.reasoning_effort !== "none") {
    // only send an effort the schema actually declares
    const allowed = SCHEMA.paths?.["params.reasoning_effort"]?.options
    if (!allowed || allowed.includes(body.reasoning_effort)) params.reasoning_effort = body.reasoning_effort
  }

  const permissionMode = PERMISSION_MODES.includes(body.permission_mode) ? body.permission_mode : "standard"

  return {
    config: buildConfig(workingDir),
    memory: null,
    taste: null,
    skills: null,
    permissionMode,
    threadId: randomUUID(),
    mode: DEFAULT_MODE,
    promptCache: PROMPT_CACHE,
    params,
  }
}

function callUpstream(body, workingDir, signal) {
  return fetch(API_BASE + "/alpha/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${readApiKey()}`,
      "x-command-code-version": cliVersion(),
      "x-cli-environment": "production",
      "User-Agent": "cli",
    },
    body: JSON.stringify(buildEnvelope(body, workingDir)),
    signal,
  })
}

// ----------------------------------------------------------- completions

function chunker(model) {
  const id = "chatcmpl-" + randomUUID().replace(/-/g, "")
  const created = Math.floor(Date.now() / 1000)
  return { id, model, base: () => ({ id, object: "chat.completion.chunk", created, model }) }
}

async function handleChat(res, body, workingDir) {
  const model = body.model
  const c = chunker(model)
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`)

  const ac = new AbortController()
  // Abort on *response* close, not request close: `req` emits 'close' as soon
  // as the request body is consumed, which would kill the upstream call.
  res.on("close", () => { if (!res.writableFinished) ac.abort() })

  let upstream
  try {
    upstream = await callUpstream(body, workingDir, ac.signal)
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" })
    return res.end(JSON.stringify(err(`Upstream connection failed: ${e.message}`)))
  }

  if (!upstream.ok) {
    const raw = await upstream.text().catch(() => "")
    let parsed
    try { parsed = JSON.parse(raw) } catch {}
    const em = parsed?.error?.message || parsed?.message || raw || `HTTP ${upstream.status}`
    res.writeHead(upstream.status, { "content-type": "application/json" })
    return res.end(JSON.stringify(err(em, httpErrorType(upstream.status), parsed?.error?.code ?? null)))
  }

  // ---- non-streaming: accumulate the NDJSON stream into one response
  if (!body.stream) {
    let text = "", reasoning = ""
    const calls = []
    let finish = "stop", usage = null
    try {
      for await (const ev of ndjson(upstream)) {
        switch (ev.type) {
          case "text-delta": text += ev.text ?? ""; break
          case "reasoning-delta": reasoning += ev.text ?? ""; break
          case "tool-call":
            calls.push({ id: ev.toolCallId, type: "function",
              function: { name: ev.toolName, arguments: JSON.stringify(ev.input ?? {}) } })
            break
          case "finish": case "finish-step":
            if (ev.finishReason) finish = finishMap(ev.finishReason)
            usage = toOpenAIUsage(ev.totalUsage || ev.usage) || usage
            break
          case "error":
            res.writeHead(502, { "content-type": "application/json" })
            return res.end(JSON.stringify(err(ev.error || ev.message || "stream error")))
        }
      }
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" })
      return res.end(JSON.stringify(err(e.message)))
    }
    const msg = { role: "assistant", content: text || null }
    if (reasoning) msg.reasoning_content = reasoning
    if (calls.length) msg.tool_calls = calls
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify({
      id: c.id, object: "chat.completion", created: c.base().created, model: c.model,
      choices: [{ index: 0, message: msg, logprobs: null, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    }))
  }

  // ---- streaming SSE
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  send({ ...c.base(), choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })

  let toolIndex = 0, finish = "stop", usage = null
  try {
    for await (const ev of ndjson(upstream)) {
      switch (ev.type) {
        case "reasoning-delta":
          if (ev.text) send({ ...c.base(), choices: [{ index: 0, delta: { reasoning_content: ev.text }, finish_reason: null }] })
          break
        case "text-delta":
          if (ev.text) send({ ...c.base(), choices: [{ index: 0, delta: { content: ev.text }, finish_reason: null }] })
          break
        // tool-input-start / tool-input-delta are partial-JSON previews of the
        // same call that `tool-call` reports in full; emitting both duplicates
        // the arguments, so we only use the authoritative event.
        case "tool-call":
          send({ ...c.base(), choices: [{ index: 0, delta: { tool_calls: [{
            index: toolIndex++, id: ev.toolCallId, type: "function",
            function: { name: ev.toolName, arguments: JSON.stringify(ev.input ?? {}) },
          }] }, finish_reason: null }] })
          break
        case "finish": case "finish-step":
          if (ev.finishReason) finish = finishMap(ev.finishReason)
          usage = toOpenAIUsage(ev.totalUsage || ev.usage) || usage
          break
        case "error":
          send({ ...c.base(), choices: [{ index: 0, delta: {}, finish_reason: "error" }] })
          res.write(`data: ${JSON.stringify(err(ev.error || ev.message || "stream error"))}\n\n`)
          res.write("data: [DONE]\n\n")
          return res.end()
      }
    }
  } catch (e) {
    send({ ...c.base(), choices: [{ index: 0, delta: {}, finish_reason: "error" }] })
    res.write(`data: ${JSON.stringify(err(e.message))}\n\n`)
    res.write("data: [DONE]\n\n")
    return res.end()
  }

  send({ ...c.base(), choices: [{ index: 0, delta: {}, finish_reason: finish }] })
  // Always emit usage: many clients (incl. the Vercel AI SDK) never set
  // stream_options.include_usage yet still expect accounting.
  if (usage) send({ ...c.base(), choices: [], usage })
  res.write("data: [DONE]\n\n")
  res.end()
}

// ------------------------------------------------------------------ routes

function modelsPayload() {
  return {
    object: "list",
    data: (CATALOG.models || []).map((m) => ({
      id: m.id, object: "model", created: 0, owned_by: "commandcode",
      name: m.name || m.id,
      // A few catalog entries declare no window; fall back rather than emit null,
      // which makes downstream context budgeting NaN.
      context_length: m.contextWindow || DEFAULT_CONTEXT_WINDOW,
      // advertise vision so OpenCode can route image prompts correctly
      modalities: m.inputModalities || ["text"],
    })),
  }
}

// Upstream status is cached because it costs two network round-trips, and
// /health is polled by the CLI, the plugin and the installer. Doing that work
// inline made /health slow enough that callers with a short timeout reported
// a healthy bridge as "unreachable".
let upstreamCache = { at: 0, value: null }
const UPSTREAM_TTL_MS = 30_000

async function upstreamStatus({ force = false } = {}) {
  const now = Date.now()
  if (!force && upstreamCache.value && now - upstreamCache.at < UPSTREAM_TTL_MS) {
    return upstreamCache.value
  }
  let value
  try {
    const r = await fetch(API_BASE + "/alpha/whoami", {
      headers: { Authorization: `Bearer ${readApiKey()}`, "x-command-code-version": cliVersion() },
      signal: AbortSignal.timeout(4000),
    })
    const j = await r.json().catch(() => ({}))
    let plan = j?.org?.planId ?? null
    if (j?.success && !plan) {
      plan = await fetchPlanId({ apiBase: API_BASE, apiKey: readApiKey(), cliVersion: cliVersion() })
    }
    value = { reachable: !!j?.success, user: j?.user?.userName ?? null, plan }
  } catch (e) {
    value = { reachable: false, user: null, plan: null, error: e.message }
  }
  upstreamCache = { at: now, value }
  return value
}

/**
 * /health is deliberately fast and dependency-free: it answers from local
 * state immediately and never blocks on the network. Pass ?deep=1 to force a
 * fresh upstream check when you actually want one.
 */
async function health(url) {
  const deep = url?.searchParams?.get("deep") === "1"
  // A cold cache must not make /health slow: start the fetch, answer from
  // whatever we know, and let the next poll see the result. Otherwise every
  // caller with a short timeout reports a perfectly healthy bridge as dead.
  if (!deep && !upstreamCache.value) upstreamStatus().catch(() => {})
  const up = deep
    ? await upstreamStatus({ force: true })
    : upstreamCache.value || { reachable: null, user: null, plan: null, pending: true }
  return {
    ok: true,
    bridge: "opencode-commandcode-go",
    port: PORT,
    host: HOST,
    baseURL: `http://${HOST}:${PORT}/v1`,
    cliVersion: cliVersion(),
    catalog: { models: (CATALOG.models || []).length, generatedAt: CATALOG.generatedAt },
    schema: { paths: Object.keys(SCHEMA.paths || {}).length, generatedAt: SCHEMA.generatedAt },
    plan: { id: up.plan, ...classifyPlan(up.plan) },
    upstream: {
      base: API_BASE,
      reachable: up.reachable,
      user: up.user,
      ...(up.pending ? { pending: true } : {}),
      ...(up.error ? { error: up.error } : {}),
    },
    upstreamCheckedAt: upstreamCache.value ? new Date(upstreamCache.at).toISOString() : null,
    upstreamFresh: Date.now() - upstreamCache.at < UPSTREAM_TTL_MS,
    config: { ...checkDrift({ port: PORT, host: HOST }) },
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  const p = url.pathname

  try {
    if (req.method === "GET" && (p === "/v1/models" || p === "/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify(modelsPayload()))
    }
    if (req.method === "GET" && (p === "/health" || p === "/v1/health")) {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify(await health(url)))
    }
    if (req.method === "GET" && p === "/__introspect") {
      res.writeHead(200, { "content-type": "application/json" })
      return res.end(JSON.stringify({ catalog: CATALOG, schema: SCHEMA, parts: PARTS }))
    }
    if (req.method === "POST" && (p === "/v1/chat/completions" || p === "/chat/completions")) {
      const chunks = []
      req.on("data", (c) => chunks.push(c))
      req.on("end", async () => {
        let body
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") }
        catch (e) {
          res.writeHead(400, { "content-type": "application/json" })
          return res.end(JSON.stringify(err(`Invalid JSON: ${e.message}`, "invalid_request_error")))
        }
        if (!body.model || !Array.isArray(body.messages)) {
          res.writeHead(400, { "content-type": "application/json" })
          return res.end(JSON.stringify(err("`model` and `messages` are required", "invalid_request_error")))
        }
        try {
          await handleChat(res, body, process.env.CMD_WORKING_DIR || undefined)
        } catch (e) {
          if (!res.headersSent) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify(err(e.message))) }
          else try { res.end() } catch {}
        }
      })
      return
    }
    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify(err(`No route for ${req.method} ${p}`, "invalid_request_error")))
  } catch (e) {
    if (!res.headersSent) { res.writeHead(500, { "content-type": "application/json" }) }
    try { res.end(JSON.stringify(err(e.message))) } catch {}
  }
})

// Exported for tests and for offline envelope inspection.
export { buildEnvelope, buildConfig, modelsPayload }

// CMD_BRIDGE_NO_LISTEN=1 imports the module as a library (tests, tooling)
// without binding a port.
if (process.env.CMD_BRIDGE_NO_LISTEN !== "1") {
  // Port collisions are the single most common way a local proxy fails to
  // start, and the fix should never be "go find a free port yourself". Scan
  // upward, then persist the choice so the installer, plugin and CLI all find
  // the bridge where it actually is.
  const chosen = await findAvailablePort({ start: Number(process.env.CMD_BRIDGE_PORT || DEFAULT_PORT), host: HOST })
  PORT = chosen.port
  PORT_STRATEGY = chosen.strategy

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      process.stderr.write(
        `port ${PORT} was taken between the scan and the bind.\n` +
          `  retry:  opencode-cc-go start\n` +
          `  or pin a port:  CMD_BRIDGE_PORT=8788 opencode-cc-go start\n`,
      )
      process.exit(1)
    }
    if (err.code === "EACCES") {
      process.stderr.write(`not permitted to bind ${HOST}:${PORT} (use a port above 1024)\n`)
      process.exit(1)
    }
    process.stderr.write(`bridge server error: ${err.message}\n`)
    process.exit(1)
  })

  process.on("unhandledRejection", (e) => {
    process.stderr.write(`bridge: unhandled rejection: ${e?.message || e}\n`)
  })

  const shutdown = (sig) => {
    process.stderr.write(`\nbridge stopping (${sig})\n`)
    clearState()
    try { server.close() } catch {}
    process.exit(0)
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
  process.on("exit", () => clearState())

  server.listen(PORT, HOST, () => {
    writeState({ port: PORT, host: HOST, pid: process.pid, cliVersion: cliVersion() })
    const extra = PORT_STRATEGY === "preferred" ? "" : `  [port ${PORT} chosen: ${PORT_STRATEGY}]`
    process.stderr.write(
      `opencode-commandcode-go bridge on http://${HOST}:${PORT}  ` +
        `(${(CATALOG.models || []).length} models, cli ${cliVersion()})${extra}\n`,
    )

    // Keep OpenCode's config pointed at wherever we actually landed. Without
    // this, an auto-selected port is a silent breakage: opencode.json keeps the
    // old baseURL and every request fails with a bare ConnectionRefused.
    // Set CMD_NO_CONFIG_SYNC=1 to opt out (e.g. when OpenCode config is
    // managed declaratively by a dotfile repo you do not want touched).
    if (process.env.CMD_NO_CONFIG_SYNC === "1") {
      process.stderr.write("  config sync disabled (CMD_NO_CONFIG_SYNC=1)\n")
      return
    }
    const r = syncBaseURL({ port: PORT, host: HOST })
    if (r.changed) {
      process.stderr.write(
        `  opencode.json baseURL updated: ${r.from} -> ${r.to}\n` +
          `  restart OpenCode to pick up the new port.\n`,
      )
    } else if (r.reason.startsWith("already correct") || r.reason.includes("no 'commandcode' provider")) {
      // nothing to say
    } else {
      process.stderr.write(`  config sync skipped: ${r.reason}\n`)
    }
  })
}
