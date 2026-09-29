#!/usr/bin/env node
/**
 * test/run-all.mjs — the end-to-end test suite.
 *
 * Runs against a live bridge and a real Command Code account. It exercises the
 * five things that actually matter for this bridge:
 *
 *   1. text          — streaming and non-streaming completions
 *   2. multi-turn    — conversation memory survives translation
 *   3. tool calling  — arguments round-trip, and the agent loop runs to a result
 *   4. vision        — a real rendered PNG is actually *read*, not guessed
 *   5. usage         — token accounting is reported in both modes
 *
 * Model choice: the suite uses FLASH-tier models only. Pro/K3-class models are
 * an order of magnitude more expensive on the credit-metered Go plan and buy
 * nothing for transport testing.
 *
 * Flags:
 *   --offline     skip everything that costs a request (structure only)
 *   --model <id>  override the model under test
 *   --vision-model <id>  override the vision model under test
 *
 * Usage: node test/run-all.mjs [--offline] [--model <id>] [--vision-model <id>]
 */

import { spawn } from "node:child_process"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..")
// The bridge auto-selects a port, so the suite discovers it rather than
// assuming 8787 -- the same adaptation a user hits when 8787 is taken.
let PORT = process.env.CMD_BRIDGE_PORT || "8787"
const HOST = process.env.CMD_BRIDGE_HOST || "127.0.0.1"
let BASE = `http://${HOST}:${PORT}/v1`
async function syncPort() {
  const live = await discoverLivePort()
  if (live && live !== PORT) { PORT = live; BASE = `http://${HOST}:${PORT}/v1` }
  return PORT
}

const args = process.argv.slice(2)
const OFFLINE = args.includes("--offline")
const val = (n, d) => { const i = args.indexOf(n); return i > -1 && args[i + 1] ? args[i + 1] : d }

// Flash-tier by default: cheap, and sufficient to prove the transport.
const MODEL = val("--model", "deepseek/deepseek-v4.1-flash")
const VISION_MODEL = val("--vision-model", "deepseek/deepseek-v4.1-flash")

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
}

let passed = 0, failed = 0, skipped = 0
const ok = (name, cond, detail = "") => {
  if (cond) { passed++; console.log(`  ${C.green("PASS")}  ${name}${detail ? C.dim("  " + detail) : ""}`) }
  else { failed++; console.log(`  ${C.red("FAIL")}  ${name}${detail ? "  " + detail : ""}`) }
}
const skip = (name, why) => { skipped++; console.log(`  ${C.yellow("SKIP")}  ${name} ${C.dim(why)}`) }

// --------------------------------------------------------------- utilities

async function bridgeUp() {
  try {
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 2000)
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: ac.signal }); clearTimeout(t)
    return r.ok
  } catch { return false }
}

async function discoverLivePort() {
  try {
    const { discoverPort } = await import(new URL("../src/port.js", import.meta.url).href)
    const f = await discoverPort({ host: HOST })
    return f ? f.port : null
  } catch { return null }
}

async function ensureBridge() {
  // Discover BEFORE probing: the default port may be occupied by something
  // that accepts TCP but never speaks HTTP, which looks like a dead bridge.
  await syncPort()
  if (await bridgeUp()) return true
  console.log(C.dim("  starting bridge..."))
  const p = spawn(process.execPath, [path.join(REPO, "src", "bridge.js")], {
    detached: true, stdio: "ignore", env: { ...process.env, CMD_BRIDGE_PORT: String(PORT) },
  })
  p.unref()
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 300))
    if (await bridgeUp()) { await syncPort(); return true }
  }
  await syncPort()
  return false
}

/** Minimal OpenAI chat-completions caller (no SDK dependency). */
async function chat(body) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = null }
  return { status: r.status, json, text }
}

/** Stream an SSE completion and collect deltas. */
async function chatStream(body) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
  })
  if (!r.ok) return { status: r.status, error: await r.text() }
  let content = "", reasoning = "", finish = null, usage = null
  const toolArgs = new Map()
  const dec = new TextDecoder()
  let buf = ""
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true })
    let i
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line.startsWith("data: ")) continue
      if (line === "data: [DONE]") continue
      let d; try { d = JSON.parse(line.slice(6)) } catch { continue }
      if (d.usage) usage = d.usage
      for (const c of d.choices || []) {
        const dl = c.delta || {}
        if (dl.content) content += dl.content
        if (dl.reasoning_content) reasoning += dl.reasoning_content
        if (c.finish_reason) finish = c.finish_reason
        for (const tc of dl.tool_calls || []) {
          const e = toolArgs.get(tc.index) || { id: null, name: "", args: "" }
          if (tc.id) e.id = tc.id
          if (tc.function?.name) e.name = tc.function.name
          if (tc.function?.arguments) e.args += tc.function.arguments
          toolArgs.set(tc.index, e)
        }
      }
    }
  }
  return { status: r.status, content, reasoning, finish, usage, toolCalls: [...toolArgs.values()] }
}

const readCatalog = () => {
  try { return JSON.parse(readFileSync(path.join(REPO, "catalog.json"), "utf8")) } catch { return { models: [] } }
}
const readSchema = () => {
  try { return JSON.parse(readFileSync(path.join(REPO, "schema.generated.json"), "utf8")) } catch { return { paths: {} } }
}
const readParts = () => {
  try { return JSON.parse(readFileSync(path.join(REPO, "parts.generated.json"), "utf8")) } catch { return { partTypes: [] } }
}

// ------------------------------------------------------------------ tests

async function main() {
  console.log(C.bold("\nopencode-commandcode test suite"))
  console.log(C.dim(`  model=${MODEL}  vision=${VISION_MODEL}  offline=${OFFLINE}\n`))

  // ---- 0a. port resilience (local only, no API cost)
  console.log(C.bold("\n0a. port selection"))
  {
    const { findAvailablePort, isServing, readState } =
      await import(new URL("../src/port.js", import.meta.url).href)
    const { classifyPlan } =
      await import(new URL("../src/plan.js", import.meta.url).href)

    const free = await findAvailablePort({ start: 45000 + Math.floor(Math.random() * 500) })
    ok("findAvailablePort returns a bindable port", typeof free.port === "number" && free.port > 0,
      `port ${free.port} (${free.strategy})`)

    const net = await import("node:net")
    const squatter = net.createServer()
    await new Promise((r) => squatter.listen(0, "127.0.0.1", r))
    const blocked = squatter.address().port
    const after = await findAvailablePort({ start: blocked, attempts: 5 })
    ok("an occupied port is skipped, next one used", after.port !== blocked && after.strategy === "scanned",
      `${blocked} occupied -> chose ${after.port}`)
    await new Promise((r) => squatter.close(r))

    const live = await discoverLivePort()
    if (live) {
      ok("isServing() finds the live bridge", await isServing(live))
      ok("isServing() rejects a dead port", !(await isServing(1)))
    } else skip("isServing() probes", "no live bridge")

    const st = readState()
    ok("state file records the bound port", !st || (typeof st.port === "number" && st.pid > 0),
      st ? `port ${st.port} pid ${st.pid}` : "no state file (bridge not running)")

    ok("Go plan is identified as needing the bridge",
      classifyPlan("individual-go-v1").needsBridge === true)
    ok("Provider/Pro/Max/GOAT are told they do NOT need it",
      ["individual-provider", "individual-pro-v1", "individual-max", "individual-goat", "teams-pro"]
        .every((x) => classifyPlan(x).needsBridge === false))
    ok("an unknown plan is not guessed", classifyPlan("mystery-tier").needsBridge === null)
  }

  // ---- 0b. static artifact integrity (always runs, costs nothing)
  console.log(C.bold("\n0b. generated artifacts"))
  const cat = readCatalog(), sch = readSchema(), parts = readParts()
  ok("catalog.json has models", (cat.models || []).length > 0, `${(cat.models || []).length} models`)
  ok("schema.generated.json has paths", Object.keys(sch.paths || {}).length > 0, `${Object.keys(sch.paths || {}).length} paths`)
  ok("parts.generated.json has part types", (parts.partTypes || []).length > 0, `${(parts.partTypes || []).length} types`)
  const ctx = sch.paths?.config
  ok("schema contains the 9 required config fields",
    ctx && ["workingDir", "date", "environment", "structure", "isGitRepo", "currentBranch", "mainBranch", "gitStatus", "recentCommits"]
      .every((f) => sch.paths["config." + f]),
    "config.*")
  const ctxWin = (cat.models || []).find((m) => m.id === MODEL)?.contextWindow
  const missingCtx = (cat.models || []).filter((m) => typeof m.contextWindow !== "number").map((m) => m.id)
  ok("every model has a usable context window",
    (cat.models || []).every((m) => typeof m.contextWindow === "number" && m.contextWindow > 0),
    missingCtx.length ? `missing for ${missingCtx.join(", ")}` : `e.g. ${MODEL}=${ctxWin}`)
  const imgCount = (cat.models || []).filter((m) => m.inputModalities?.includes("image")).length
  ok("catalog distinguishes vision vs text-only models", imgCount > 0 && imgCount < (cat.models || []).length,
    `${imgCount} vision / ${(cat.models || []).length - imgCount} text-only`)

  if (OFFLINE) {
    console.log(C.dim("\n  --offline: skipping all network tests\n"))
    return summary()
  }

  // ---- 1. bridge reachable
  console.log(C.bold("\n1. bridge"))
  const up = await ensureBridge()
  ok("bridge is healthy", up, `port ${PORT}`)
  if (!up) return summary()
  // ?deep=1 forces a fresh upstream check; the default is deliberately
  // non-blocking so /health stays fast for pollers.
  const h = await (await fetch(`http://${HOST}:${PORT}/health?deep=1`)).json()
  ok("upstream reachable", h.upstream?.reachable, h.upstream?.user ? `as ${h.upstream.user}` : "")
  ok("plan is identified", !!h.plan?.id, h.plan ? `${h.plan.id} (needsBridge=${h.plan.needsBridge})` : "")
  ok("health reports its own baseURL", h.baseURL === BASE, h.baseURL)
  // fast health: the default path must not block on the network
  const t0 = Date.now()
  await fetch(`http://${HOST}:${PORT}/health`)
  const ms = Date.now() - t0
  ok("default /health is fast (non-blocking)", ms < 1000, `${ms}ms`)

  // ---- 2. /v1/models
  console.log(C.bold("\n2. models endpoint"))
  const mj = await (await fetch(`${BASE}/models`)).json()
  ok("GET /v1/models returns a list", Array.isArray(mj.data) && mj.data.length > 0, `${mj.data?.length} models`)
  ok("test model is advertised", mj.data?.some((m) => m.id === MODEL))
  ok("models carry a numeric context_length", mj.data?.every((m) => typeof m.context_length === "number"),
    mj.data?.find((m) => typeof m.context_length !== "number")?.id || "all numeric")

  // ---- 3. text
  console.log(C.bold("\n3. text completion"))
  const ns = await chat({ model: MODEL, messages: [{ role: "user", content: "Reply with only: BRIDGE_OK" }] })
  ok("non-streaming 200", ns.status === 200, `status ${ns.status}`)
  ok("non-streaming content", /BRIDGE/i.test(ns.json?.choices?.[0]?.message?.content || ""),
    JSON.stringify((ns.json?.choices?.[0]?.message?.content || "").slice(0, 40)))
  ok("non-streaming reports usage", typeof ns.json?.usage?.total_tokens === "number",
    JSON.stringify(ns.json?.usage))
  // Model output is nondeterministic: it may answer "STREAM_OK", "STREAM", or
  // add punctuation. Assert on a distinctive prefix rather than an exact
  // string, so the test measures the transport instead of the model's mood.
  const st = await chatStream({ model: MODEL, messages: [{ role: "user", content: "Reply with only the word STREAMING" }] })
  ok("streaming content", /STREAM/i.test(st.content), JSON.stringify(st.content.slice(0, 40)))
  ok("streaming finish_reason=stop", st.finish === "stop", String(st.finish))
  ok("streaming reports usage", typeof st.usage?.total_tokens === "number", JSON.stringify(st.usage))

  // ---- 4. multi-turn memory
  console.log(C.bold("\n4. multi-turn"))
  const mt = await chat({
    model: MODEL,
    messages: [
      { role: "user", content: "Remember this number exactly: 7391. Reply OK." },
      { role: "assistant", content: "OK" },
      { role: "user", content: "What number did I ask you to remember? Digits only." },
    ],
  })
  ok("conversation memory survives translation", /7391/.test(mt.json?.choices?.[0]?.message?.content || ""),
    JSON.stringify((mt.json?.choices?.[0]?.message?.content || "").slice(0, 40)))

  // ---- 5. tools
  console.log(C.bold("\n5. tool calling"))
  const tools = [{
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    },
  }]
  const tc = await chatStream({
    model: MODEL,
    messages: [{ role: "user", content: "What is the weather in Paris? Use the get_weather tool." }],
    tools,
  })
  const call = tc.toolCalls[0]
  ok("model emits a tool call", !!call, call ? call.name : "none")
  ok("tool arguments round-trip exactly", call && JSON.parse(call.args || "{}").city === "Paris",
    call?.args)
  ok("finish_reason is tool_calls", tc.finish === "tool_calls", String(tc.finish))

  if (call) {
    const second = await chatStream({
      model: MODEL,
      messages: [
        { role: "user", content: "What is the weather in Paris? Use the get_weather tool." },
        { role: "assistant", content: null, tool_calls: [{ id: call.id, type: "function", function: { name: call.name, arguments: call.args } }] },
        { role: "tool", tool_call_id: call.id, content: "18C and sunny" },
      ],
      tools,
    })
    ok("agent loop consumes the tool result", /18/.test(second.content),
      JSON.stringify(second.content.slice(0, 70)))
  }

  // ---- 6. vision
  console.log(C.bold("\n6. vision"))
  const imgPath = path.join(HERE, "fixtures", "test-image.png")
  if (!existsSync(imgPath)) {
    skip("vision", "fixture missing — run `npm run fixture`")
  } else {
    const dataUrl = `data:image/png;base64,${readFileSync(imgPath).toString("base64")}`
    const vr = await chat({
      model: VISION_MODEL,
      max_tokens: 1200,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Three facts: the two-digit number, the outer background colour, and the right-side colour." },
          { type: "image", image: dataUrl },
        ],
      }],
    })
    const t = (vr.json?.choices?.[0]?.message?.content || "").toLowerCase()
    const isVision = (readCatalog().models || []).find((m) => m.id === VISION_MODEL)?.inputModalities?.includes("image")
    if (isVision) {
      ok("vision model reads the number 42", /\b42\b/.test(t), JSON.stringify(t.slice(0, 80)))
      ok("vision model reads the green background", /green/.test(t))
      ok("vision model reads the red square", /red/.test(t))
    } else {
      skip("vision assertions", `${VISION_MODEL} is text-only in the catalog`)
    }
  }

  // ---- 7. error handling
  console.log(C.bold("\n7. error handling"))
  const bad = await chat({ messages: [] })
  ok("missing model -> 400 invalid_request_error",
    bad.status === 400 && bad.json?.error?.type === "invalid_request_error", `status ${bad.status}`)
  const nf = await fetch(`${BASE}/nope`)
  ok("unknown route -> 404", nf.status === 404, `status ${nf.status}`)

  return summary()
}

function summary() {
  console.log(C.bold(`\n${passed} passed, ${failed} failed, ${skipped} skipped`))
  if (failed) console.log(C.red("\nsome tests failed"))
  else console.log(C.green("\nall good"))
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(C.red("\n" + e.stack)); process.exit(1) })
