/**
 * port.js — resilient port selection and discovery.
 *
 * THE PROBLEM
 * -----------
 * The bridge defaults to 8787. That port is a hardcoded single point of
 * failure: if anything else on the machine already holds it, the bridge
 * cannot start, and the fix is manual (`lsof`, `kill`, edit a config file).
 * A user installing a package should never have to do that.
 *
 * WHAT THIS DOES
 * --------------
 *   1. The bridge scans upward from its preferred port until it finds one that
 *      binds, so a collision is a non-event.
 *   2. The chosen port is written to a small state file, so every other part of
 *      the system (installer, plugin, CLI) can discover where it actually
 *      landed instead of assuming 8787.
 *
 * The state file is the important part. Without it, an auto-selected port would
 * be discovered by the bridge and unknown to everyone else -- the classic way
 * "it works but I don't know why" happens.
 *
 * The state file also carries the owning pid, so a stale file left behind by a
 * crashed bridge can be recognised as stale instead of being trusted forever.
 */

import { createServer } from "node:net"
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"

export const DEFAULT_PORT = 8787
export const PORT_SCAN_ATTEMPTS = 20

const STATE_DIR =
  process.env.CMD_BRIDGE_STATE_DIR || path.join(os.homedir(), ".commandcode-bridge")
const STATE_FILE = path.join(STATE_DIR, "state.json")

/** Try to bind a TCP server on `port`; resolve true if it was free. */
function canBind(port, host) {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once("error", () => resolve(false))
    srv.once("listening", () => srv.close(() => resolve(true)))
    try {
      srv.listen(port, host)
    } catch {
      resolve(false)
    }
  })
}

/** Ask the OS for an ephemeral port that is currently free. */
function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Find a usable port, starting at `start` and scanning upward.
 *
 * Order of preference:
 *   1. the requested port (or the first free one at/above it)
 *   2. an OS-assigned ephemeral port
 *   3. throw, with every port we tried listed
 */
export async function findAvailablePort({
  start = DEFAULT_PORT,
  host = "127.0.0.1",
  attempts = PORT_SCAN_ATTEMPTS,
} = {}) {
  const tried = []
  for (let i = 0; i < attempts; i++) {
    const port = start + i
    if (port > 65535) break
    tried.push(port)
    if (await canBind(port, host)) return { port, tried, strategy: i === 0 ? "preferred" : "scanned" }
  }
  // Fall back to whatever the OS hands out.
  const fallback = await ephemeralPort()
  return { port: fallback, tried, strategy: "ephemeral" }
}

/** True when something is listening on `port` and answers an HTTP GET. */
export async function isServing(port, host = "127.0.0.1", timeoutMs = 1200) {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    const r = await fetch(`http://${host}:${port}/health`, { signal: ac.signal })
    clearTimeout(t)
    return r.ok
  } catch {
    return false
  }
}

/** True when a process with this pid is alive. */
function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === "EPERM"
  }
}

// ------------------------------------------------------------------ state

export function statePath() {
  return STATE_FILE
}

/** Persist the chosen port so other processes can find the bridge. */
export function writeState({ port, host, pid = process.pid, meta = {} }) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ port, host, pid, startedAt: new Date().toISOString(), ...meta }, null, 2) + "\n",
    )
    return STATE_FILE
  } catch {
    return null
  }
}

export function readState() {
  try {
    if (!existsSync(STATE_FILE)) return null
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"))
    if (typeof s?.port !== "number") return null
    return s
  } catch {
    return null
  }
}

export function clearState() {
  try {
    if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE)
  } catch {}
}

/**
 * Discover the port a live bridge is using.
 *
 * Order:
 *   1. explicit CMD_BRIDGE_PORT
 *   2. the state file, if the recorded pid is alive and the port answers
 *   3. a scan upward from the default
 *
 * Returns { port, how } or null.
 */
export async function discoverPort({
  start = DEFAULT_PORT,
  host = "127.0.0.1",
  attempts = PORT_SCAN_ATTEMPTS,
} = {}) {
  if (process.env.CMD_BRIDGE_PORT) {
    const p = Number(process.env.CMD_BRIDGE_PORT)
    if (Number.isFinite(p)) return { port: p, how: "env" }
  }

  const st = readState()
  if (st && (pidAlive(st.pid) || st.pid === process.pid)) {
    if (await isServing(st.port, st.host || host)) return { port: st.port, how: "state-file" }
  }
  if (st) clearState() // stale

  if (await isServing(start, host)) return { port: start, how: "default" }
  for (let i = 1; i < attempts; i++) {
    const p = start + i
    if (await isServing(p, host)) return { port: p, how: "scan" }
  }
  return null
}

/** Local IP addresses, for the "what address is this reachable on" hint. */
export function localAddresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

export { net }
