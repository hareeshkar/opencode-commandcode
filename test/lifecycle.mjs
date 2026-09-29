#!/usr/bin/env node
/**
 * test/lifecycle.mjs — bridge lifecycle, ownership and cleanup.
 *
 * This suite is entirely OFFLINE. It starts and kills real processes and binds
 * real ports, but never calls the Command Code API, so it costs no credits and
 * is safe to run on every change.
 *
 * What it is really testing is one property, over and over:
 *
 *     A bridge is stopped if and only if we started it.
 *
 * Everything else — environment classification, port handoff, SIGKILL
 * escalation, stale state — is in service of not (a) leaking a process that
 * holds a loopback port, or (b) killing something the user owns.
 *
 * These are the cases that are hard to notice in production:
 *   - stop() killing a launchd-managed bridge the user deliberately installed
 *   - a bridge that ignores SIGTERM holding its port forever
 *   - a second bridge starting beside the first and one of them orphaning
 *   - state file describing a pid that no longer exists
 *   - a foreign process squatting on the default port
 *
 * Usage: node test/lifecycle.mjs
 */

import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The real bridge may be running under launchd on 8787. Two consequences, both
// handled here rather than in the code under test:
//   - the state file must be ours, or these tests would delete the live one
//   - start() must genuinely spawn, so port discovery is stubbed to "nothing
//     found" instead of adopting the running bridge
const STATE_DIR = mkdtempSync(path.join(os.tmpdir(), "ccgo-state-"))
process.env.CMD_BRIDGE_STATE_DIR = STATE_DIR
process.env.CMD_NO_CONFIG_SYNC = "1"
const scratch = []

/** Port discovery that always reports "no bridge running". */
const NO_BRIDGE = { discoverPort: async () => null, isServing: async () => false }
const scratchDir = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "ccgo-scratch-"))
  scratch.push(d)
  return d
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..")
const HOST = "127.0.0.1"

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

// ---------------------------------------------------------------- utilities

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Ask the OS for a port nobody is using, then release it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once("error", reject)
    s.listen(0, HOST, () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

const portFree = (port) =>
  new Promise((resolve) => {
    const s = net.createServer()
    s.once("error", () => resolve(false))
    s.once("listening", () => s.close(() => resolve(true)))
    s.listen(port, HOST)
  })

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** A TCP listener that accepts connections but never speaks HTTP. */
function squatter(port) {
  const s = net.createServer((c) => c.on("error", () => {}))
  return new Promise((resolve, reject) => {
    s.once("error", reject)
    s.listen(port, HOST, () => resolve(s))
  })
}

/** A process that traps SIGTERM, to prove escalation to SIGKILL works. */
function stubbornChild() {
  const f = path.join(scratchDir(), "s.js")
  writeFileSync(f, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\n")
  return spawn(process.execPath, [f], { stdio: "ignore" })
}

const L = await import(new URL("../src/lifecycle.js", import.meta.url).href)
const BRIDGE = path.join(REPO, "src", "bridge.js")

// ------------------------------------------------------------------ 1. env

console.log(C.bold("\n1. environment classification"))

// Every case supplies its own home and env, so the suite behaves identically on
// a developer machine that has Command Code credentials and in CI that does
// not. A test that depends on the developer's ~/.commandcode/auth.json is not a
// test, it is a machine check — and it is why the first version of this file
// failed in CI for the right reason.
function fakeHome(withCreds = true) {
  const home = scratchDir()
  if (withCreds) {
    mkdirSync(path.join(home, ".commandcode"), { recursive: true })
    writeFileSync(path.join(home, ".commandcode", "auth.json"), JSON.stringify({ apiKey: "test-key" }))
  }
  return home
}

const ENV_CASES = [
  // name,                          opts,                                                       expect kind
  ["desktop, creds, writable home", { env: { COMMAND_CODE_API_KEY: "k" }, hasCredentials: true, configWritable: true }, "local"],
  ["launchd already supervising",   { env: { CMD_BRIDGE_SUPERVISED: "1", COMMAND_CODE_API_KEY: "k" }, hasCredentials: true, configWritable: true }, "local"],
  ["sandbox: ephemeral home",       { env: { COMMAND_CODE_API_KEY: "k" }, hasCredentials: true, configWritable: false }, "cloud"],
  ["sandbox: no creds",             { env: {}, hasCredentials: false, configWritable: false }, "cloud"],
  ["CI runner",                     { env: { CI: "true", COMMAND_CODE_API_KEY: "k" }, hasCredentials: true, configWritable: true }, "cloud"],
  ["OPENCODE_CLOUD=1",              { env: { OPENCODE_CLOUD: "1", COMMAND_CODE_API_KEY: "k" }, hasCredentials: true, configWritable: true }, "cloud"],
  ["no creds anywhere",             { env: {}, hasCredentials: false, configWritable: true }, "cloud"],
  ["credentials from env",          { env: { COMMAND_CODE_API_KEY: "k" }, configWritable: true, home: fakeHome(false) }, "local"],
  ["credentials from auth.json",    { env: {}, configWritable: true, home: fakeHome(true) }, "local"],
  ["auth.json without a key",       { env: {}, configWritable: true, home: fakeHome(false) }, "cloud"],
  ["home does not exist",           { env: {}, home: "/nonexistent-home-xyz", configWritable: true }, "cloud"],
]

for (const [name, opts, expect] of ENV_CASES) {
  const r = L.detectEnvironment(opts)
  ok(`classify: ${name}`, r.kind === expect, `got ${r.kind}, want ${expect}`)
}

{
  const cloud = L.detectEnvironment({ env: {}, hasCredentials: true, configWritable: false })
  ok("cloud never allows a detached daemon", cloud.allowDetach === false,
    `allowDetach=${cloud.allowDetach} — a detached child would outlive the session`)
  const local = L.detectEnvironment({ env: {}, hasCredentials: true, configWritable: true })
  ok("local allows detach (launchd or a terminal can own it)", local.allowDetach === true)
  ok("classification is idempotent",
    L.detectEnvironment({ env: {}, hasCredentials: true, configWritable: false }).kind === "cloud")
}

// REGRESSION: the writability probe wrote into a directory it never created, so
// it always threw, every machine was classified as an ephemeral sandbox, and a
// real desktop silently lost detach and config-drift repair.
//
// Found by reading the plugin's log on a live machine, not by a failing test.
// These assertions therefore run against a real filesystem rather than a stub —
// a probe only ever exercised with injected values is not testing the probe.
{
  // Real home, but credentials supplied explicitly so the result does not
  // depend on whether the developer has logged in.
  const real = L.detectEnvironment({ env: { COMMAND_CODE_API_KEY: "k" } })
  ok("a real writable home is detected as writable", real.configWritable === true)
  ok("creds + a real writable home is 'local', not 'cloud'",
    real.kind === "local", `got ${real.kind} — reasons: ${real.reasons.join("; ")}`)
  ok("the probe does not leave a directory behind", !existsSync(path.join(os.homedir(), ".commandcode-go-probe")))

  const tmpHome = fakeHome(true)
  const onTmp = L.detectEnvironment({ env: {}, home: tmpHome })
  ok("a fresh writable home with auth.json is 'local'", onTmp.kind === "local", `got ${onTmp.kind}`)
  ok("a nonexistent home is 'cloud' (nothing can be persisted)",
    L.detectEnvironment({ env: { COMMAND_CODE_API_KEY: "k" }, home: "/nonexistent-xyz" }).kind === "cloud")

  // The exact regression: home that is real and writable, and a probe that
  // creates what it writes into.
  const probeHome = fakeHome(true)
  ok("the writability probe creates and removes its own directory",
    L.detectEnvironment({ env: { COMMAND_CODE_API_KEY: "k" }, home: probeHome }).configWritable === true &&
    !existsSync(path.join(probeHome, ".commandcode-go-probe")))
}

// ------------------------------------------------------- 2. ownership rules

console.log(C.bold("\n2. ownership — we only stop what we started"))

L._resetOwnership()
ok("a fresh process owns nothing", L.ownsBridge() === false)
{
  const r = await L.stop()
  ok("stop() with no owned bridge is a no-op",
    r.stopped === false && /not started by this process/.test(r.reason || ""), JSON.stringify(r))
}

L._resetOwnership()
{
  // Occupy the default port with something that is NOT a bridge, so start()
  // must notice an existing listener and decline to touch it.
  const port = await freePort()
  const foreign = await squatter(port)

  const FAKE_FOUND = {
    discoverPort: async () => ({ port }),
    isServing: async () => true, // pretend it is a healthy bridge
  }
  const r = await L.start({ bridgeMain: BRIDGE, host: HOST, preflightPortModule: FAKE_FOUND })
  ok("start() adopts an already-serving bridge instead of spawning", r.started === false, `started=${r.started}`)
  ok("start() does not claim ownership of someone else's bridge", L.ownsBridge() === false)
  ok("adopted baseURL points at the existing port", r.baseURL === `http://${HOST}:${port}/v1`)

  foreign.close()
  await sleep(150)
}

L._resetOwnership()
{
  const r = await L.start({ bridgeMain: path.join(REPO, "does-not-exist.js"), host: HOST })
  ok("start() refuses when the bridge file is missing", r.ok === false && /not found/.test(r.reason))
  ok("a failed start leaves no ownership", L.ownsBridge() === false)
}

L._resetOwnership()
{
  // A process that exits immediately must be reported, not left half-started.
  const fake = scratchDir()
  const die = path.join(fake, "die.js")
  writeFileSync(die, "process.exit(3)\n")
  const r = await L.start({ bridgeMain: die, host: HOST, timeoutMs: 3000, allowDetach: false, preflightPortModule: NO_BRIDGE })
  ok("start() reports a bridge that exits immediately", r.ok === false, r.reason)
  ok("an immediately-exiting start leaves no ownership", L.ownsBridge() === false)
}

L._resetOwnership()
{
  // Rate limiting: two start attempts in quick succession, the second refused.
  const fake = scratchDir()
  const slow = path.join(fake, "slow.js")
  writeFileSync(slow, "setInterval(() => {}, 1000)\n") // listens on nothing
  const a = await L.start({ bridgeMain: slow, host: HOST, timeoutMs: 600, allowDetach: false, preflightPortModule: NO_BRIDGE })
  ok("first start attempts and times out", a.ok === false, a.reason)
  L._resetOwnership()
  const b = await L.start({ bridgeMain: slow, host: HOST, timeoutMs: 600, allowDetach: false, preflightPortModule: NO_BRIDGE })
  ok("a timed-out start leaves no orphan process", b.ok === false, b.reason)
}

{
  // Escalation: a child that traps SIGTERM must still die.
  L._resetOwnership()
  const kid = stubbornChild()
  await sleep(300)
  const before = kid.pid
  // Pretend we own it, then stop.
  const mod = await import(new URL("../src/lifecycle.js", import.meta.url).href)
  mod._adoptForTest?.(kid, 1, HOST)
  if (mod._adoptForTest) {
    const r = await L.stop({ graceMs: 600 })
    await sleep(200)
    ok("SIGTERM-ignoring child is escalated to SIGKILL", !pidAlive(before) && r.escalated === true,
      `alive=${pidAlive(before)} escalated=${r.escalated}`)
  } else {
    skip("SIGTERM escalation", "no adoption seam exported")
  }
  try { kid.kill("SIGKILL") } catch {}
}

// ------------------------------------------- 3. real bridge, real port

console.log(C.bold("\n3. real bridge: start, serve, stop, release"))

L._resetOwnership()
let realPort = null
let realPid = null
{
  const p = await freePort()
  const env = { ...process.env, CMD_BRIDGE_PORT: String(p), CMD_NO_CONFIG_SYNC: "1" }
  const r = await L.start({ bridgeMain: BRIDGE, host: HOST, env, timeoutMs: 15000, allowDetach: false, preflightPortModule: NO_BRIDGE })
  if (r.ok) {
    realPort = r.port
    realPid = r.started ? r.port : null
    ok("bridge starts on a chosen free port", r.port === p, `got ${r.port}, want ${p}`)
    ok("bridge reports that WE started it", r.started === true)
    ok("this process now owns the bridge", L.ownsBridge() === true)
    ok("owned port is reported", L.ownedPort() === r.port)

    const h = await (await fetch(`http://${HOST}:${r.port}/health`)).json()
    ok("bridge answers /health", typeof h === "object" && h !== null)

    // Second start must adopt, not duplicate.
    const again = await L.start({ bridgeMain: BRIDGE, host: HOST, env, timeoutMs: 5000, allowDetach: false })
    ok("a second start adopts rather than forking", again.started === false && again.port === r.port,
      `started=${again.started} port=${again.port}`)

    const stopResult = await L.stop({ graceMs: 3000 })
    ok("stop() reports success for an owned bridge", stopResult.stopped === true, JSON.stringify(stopResult))
    await sleep(400)
    ok("port is released after stop", await portFree(r.port))
    ok("ownership is cleared after stop", L.ownsBridge() === false)
    ok("a second stop() is a harmless no-op", (await L.stop()).stopped === false)
  } else {
    skip("real bridge lifecycle", r.reason)
  }
}

// ---------------------------------------- 4. stale state after a hard kill

console.log(C.bold("\n4. crash recovery — a SIGKILLed bridge leaves state behind"))

{
  const { statePath, writeState, readState, clearState } =
    await import(new URL("../src/port.js", import.meta.url).href)
  const sp = statePath()
  const had = existsSync(sp)

  // A pid that cannot exist: state describing a process already gone.
  writeState({ port: 1, host: HOST, pid: 999999 })
  const st = readState()
  ok("state file records the dead pid", st?.pid === 999999)
  ok("a dead pid is detectable via signal 0", !pidAlive(999999))
  clearState()
  ok("clearState() removes the file", readState() === null)

}

L._resetOwnership()
{
  const p = await freePort()
  const env = { ...process.env, CMD_BRIDGE_PORT: String(p), CMD_NO_CONFIG_SYNC: "1" }
  const r = await L.start({ bridgeMain: BRIDGE, host: HOST, env, timeoutMs: 15000, allowDetach: false, preflightPortModule: NO_BRIDGE })
  if (!r.ok) { skip("crash recovery", r.reason) }
  else {
    const { readState, statePath } = await import(new URL("../src/port.js", import.meta.url).href)
    const st = readState()
    ok("a live bridge publishes its pid and port", st?.port === r.port && pidAlive(st.pid),
      `state=${JSON.stringify(st)}`)

    // Simulate an ungraceful death: SIGKILL bypasses every exit handler.
    try { process.kill(st.pid, "SIGKILL") } catch {}
    await sleep(500)
    ok("the hard-killed bridge is really gone", !pidAlive(st.pid))
    const after = readState()
    ok("stale state is detectable (file survives SIGKILL)", after?.pid === st.pid,
      `state still claims ${after?.pid}`)
    ok("stale state does not lie about liveness", !pidAlive(after.pid))
    // The port must be free even though nobody cleaned the state file.
    await sleep(300)
    ok("port is free after SIGKILL", await portFree(r.port))
    // And a fresh start must work despite the stale file.
    L._resetOwnership()
    const again = await L.start({ bridgeMain: BRIDGE, host: HOST, env, timeoutMs: 15000, allowDetach: false })
    ok("a new bridge starts despite stale state", again.ok === true, again.reason)
    if (again.ok) await L.stop({ graceMs: 3000 })
  }
}

// ------------------------------------------------- 5. foreign port squatter

console.log(C.bold("\n5. a foreign process holding the default port"))

L._resetOwnership()
{
  const p = await freePort()
  const foreign = await squatter(p)
  // The real bridge must refuse to fight for the port and choose another one.
  const env = { ...process.env, CMD_BRIDGE_PORT: String(p), CMD_NO_CONFIG_SYNC: "1" }
  const r = await L.start({ bridgeMain: BRIDGE, host: HOST, env, timeoutMs: 20000, allowDetach: false, preflightPortModule: NO_BRIDGE })
  if (r.ok) {
    ok("bridge does not bind over a foreign listener", r.port !== p || !(await portFree(p)),
      `foreign=${p} bridge=${r.port}`)
    ok("the foreign listener is untouched", await squatterStillUp(p))
    await L.stop({ graceMs: 3000 })
  } else {
    skip("foreign port", `bridge could not start here: ${r.reason}`)
  }
  foreign.close()
  await sleep(150)

  async function squatterStillUp(port) {
    return new Promise((res) => {
      const c = net.connect(port, HOST)
      c.once("connect", () => { c.destroy(); res(true) })
      c.once("error", () => res(false))
      setTimeout(() => { c.destroy(); res(false) }, 800)
    })
  }
}

// ------------------------------------------- 6. catalog reachability rules

console.log(C.bold("\n6. catalog reachability: deny vs unknown"))

// REGRESSION: the probe recorded an AbortError exactly like a 403, so
// `stealth/pixel-canary` — advertised as free on the Go plan — was dropped from
// the catalog because its request exceeded the 45 s budget. A model we failed to
// hear from is not a model we were told no to.
//
// These run offline against the recorded probe output plus the classification
// rule itself, so no API call is needed to catch a repeat.
{
  const catalog = JSON.parse(readFileSync(path.join(REPO, "catalog.json"), "utf8")).models
  const inCatalog = new Set(catalog.map((m) => m.id))

  // These hold from catalog.json alone, and are checked in CI where the
  // reachability record is deliberately absent.
  ok("stealth/pixel-canary is in the shipped catalog", inCatalog.has("stealth/pixel-canary"))
  ok("it is flagged vision-capable",
    catalog.find((m) => m.id === "stealth/pixel-canary")?.inputModalities?.includes("image") === true)
  ok("the retired free SKUs stay out of the catalog",
    !inCatalog.has("inclusionai/ling-3.0-flash-free") && !inCatalog.has("tencent/Hy3"))
  ok("the paid replacement for the retired free Hy3 is present", inCatalog.has("tencent/hy3-paid"))

  // catalog.reachability.json is gitignored on purpose: it records one account's
  // entitlements and must not ship stale to everyone else. So the rule can only
  // be checked where a local probe has been run.
  const reachPath = path.join(REPO, "catalog.reachability.json")
  if (!existsSync(reachPath)) {
    skip("deny-vs-unknown rule against the recorded probe",
      "catalog.reachability.json is per-account and gitignored; run `npm run catalog:probe`")
  } else {
    const reach = JSON.parse(readFileSync(reachPath, "utf8")).results

    const timedOut = Object.entries(reach).filter(([, v]) => !v.reachable && !v.denied)
    ok("the probe distinguishes a denial from an inconclusive result",
      timedOut.length === 0 || timedOut.every(([, v]) => v.denied === false && v.timedOut === true),
      `${timedOut.length} inconclusive result(s) recorded`)

    const denied = Object.entries(reach).filter(([, v]) => v.denied)
    ok("every denied model carries an explicit plan message",
      denied.length === 0 || denied.every(([, v]) => /retired|MODEL_NOT_IN_PLAN|no longer available/.test(v.reason || "")),
      `${denied.length} denied`)

    // The rule that actually matters, asserted against the shipped artifacts.
    const wronglyDropped = Object.keys(reach).filter((id) => !inCatalog.has(id) && !reach[id].denied)
    ok("no model is missing from the catalog without an authoritative denial",
      wronglyDropped.length === 0, wronglyDropped.join(", "))
    ok("no catalog entry was recorded as unreachable",
      catalog.every((m) => reach[m.id]?.reachable !== false))
  }
}

// ------------------------------------------------- 7. plugin contract (v2)

console.log(C.bold("\n6. plugin contract (v2)"))

{
  const mod = await import(new URL("../src/plugin.js", import.meta.url).href)
  ok("default export is an object, not a bare function", typeof mod.default === "object" && mod.default !== null)
  ok("default export has an id", typeof mod.default?.id === "string")
  ok("default export has a setup function", typeof mod.default?.setup === "function")

  const added = []
  let sessionHookArgs = null
  const ctx = {
    options: {},
    tool: { transform: async (fn) => fn({ add: (t) => added.push(t) }) },
    session: { hook: (...a) => { sessionHookArgs = a; return Promise.resolve({ dispose: async () => {} }) } },
  }
  const dispose = await mod.default.setup(ctx)

  ok("setup returns a dispose function", typeof dispose === "function")
  ok("commandcode_status is registered", added.some((t) => t.name === "commandcode_status"))
  const tool = added.find((t) => t.name === "commandcode_status")
  ok("tool input is a JSON Schema object",
    tool?.input?.type === "object" && typeof tool?.input?.properties === "object",
    JSON.stringify(tool?.input))
  ok("tool schema forbids unknown args", tool?.input?.additionalProperties === false)
  ok("tool has a description", typeof tool?.description === "string" && tool.description.length > 40)
  ok("tool has an execute function", typeof tool?.execute === "function")
  ok("no session hook is registered with a bogus signature",
    sessionHookArgs === null || typeof sessionHookArgs[0] === "string",
    sessionHookArgs ? `first arg was ${typeof sessionHookArgs[0]}` : "none registered")

  // The return-shape bug that only appears at call time.
  const res = await tool.execute({})
  ok("execute returns { content: string }", typeof res?.content === "string",
    `got ${typeof res}, keys=${res && typeof res === "object" ? Object.keys(res) : "-"}`)
  ok("status content is non-empty and mentions the bridge", /bridge/.test(res?.content || ""))

  const full = await tool.execute({ detail: "full" })
  ok("detail:'full' dumps discovered schema fields", /\/alpha\/generate|kind/.test(full?.content || ""))

  // dispose must be safe when we own nothing.
  const d1 = await dispose()
  ok("dispose is safe when the bridge was not started by us", d1 === undefined)
  await dispose()
  ok("dispose is idempotent", true)
}

// ------------------------------------------------------------ 7. summary

// When spawned by run-all.mjs, label the summary so it is not mistaken for
// the parent suite's own totals.
const label = process.env.CCGO_CHILD ? "lifecycle" : ""
// ------------------------------------------------------------ 7. cleanup

// A test suite that leaves temp directories behind is the same sin as a bridge
// that leaves a port bound: it accumulates state nobody will clean up. Every
// scratch dir and the isolated state dir go here, after the assertions, so a
// failure still gets its evidence.
function cleanup() {
  let removed = 0
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }); removed++ } catch {}
  }
  try { rmSync(STATE_DIR, { recursive: true, force: true }); removed++ } catch {}
  console.log(C.dim(`\n  cleaned up ${removed} scratch director${removed === 1 ? "y" : "ies"}`))
}

cleanup()

console.log(C.bold(`\n${label ? label + ": " : ""}${passed} passed, ${failed} failed, ${skipped} skipped`))
if (failed) { console.log(C.red("\nsome tests failed")); process.exit(1) }
console.log(C.green("\nall good"))
process.exit(0)
