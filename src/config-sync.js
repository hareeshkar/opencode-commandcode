/**
 * config-sync.js — keep OpenCode's provider baseURL pointed at the live bridge.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * The bridge picks its port at runtime, but OpenCode reads its baseURL from a
 * static config file. Those two facts drift apart the moment the bridge
 * restarts onto a different port, and OpenCode then fails with a bare
 * "ConnectionRefused" against a URL nothing is listening on.
 *
 * Verified: with a foreign process holding 8787, the bridge moved to 8788 while
 * opencode.json still said 8787, and every request failed.
 *
 * WHY NOT JUST PICK A FIXED PORT
 * -----------------------------
 * Because a hardcoded port means a package someone installed with one command
 * cannot start if anything else on the machine already holds it. Auto-selection
 * is the right behaviour; the config just has to follow it.
 *
 * WHAT THIS DOES
 * --------------
 * The bridge calls `syncBaseURL()` immediately after it binds. If the port it
 * landed on differs from the one in the config, the config is rewritten. So
 * the drift is corrected at the moment it is created, and the *next* OpenCode
 * start is already correct.
 *
 * SAFETY
 * ------
 *  - atomic: write to a temp file, then rename, so a crash cannot truncate
 *    a user's config
 *  - surgical: only `provider.commandcode.options.baseURL` is touched; every
 *    other key is preserved byte-for-byte in structure
 *  - refuses to run against a config it cannot parse, rather than overwriting
 *    it with something guessed
 *  - backs up the previous file to `<name>.bak` before the first change
 *  - no-ops when the URL is already correct (the overwhelmingly common case)
 *
 * THE ONE THING THIS CANNOT FIX
 * -----------------------------
 * OpenCode reads its config once, at startup. If the bridge changes port while
 * OpenCode is already running, the running instance keeps the old URL until it
 * restarts. That is an OpenCode architecture constraint, not something this
 * package can engineer around — so the bridge says so loudly on stdout rather
 * than letting it surface as a mystery connection error.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, unlinkSync, mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export const PROVIDER_ID = "commandcode"

export function defaultConfigPath() {
  return (
    process.env.OPENCODE_CONFIG ||
    path.join(os.homedir(), ".config", "opencode", "opencode.json")
  )
}

function readConfig(file) {
  const raw = readFileSync(file, "utf8")
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    const err = new Error(
      `${file} is not valid JSON (${e.message}); refusing to rewrite it. ` +
        `Fix or remove the file, then re-run the installer.`,
    )
    err.code = "ECONFIG_PARSE"
    throw err
  }
  if (!parsed || typeof parsed !== "object") {
    const err = new Error(`${file} is not a JSON object; refusing to rewrite it.`)
    err.code = "CONFIG_PARSE"
    throw err
  }
  return { raw, parsed }
}

/** The baseURL currently configured for our provider, or null. */
export function currentBaseURL(file = defaultConfigPath()) {
  try {
    if (!existsSync(file)) return null
    const { parsed } = readConfig(file)
    return parsed?.provider?.[PROVIDER_ID]?.options?.baseURL ?? null
  } catch {
    return null
  }
}

/**
 * Point the provider at `port`. Returns a description of what happened.
 *
 * @returns {{changed: boolean, from: string|null, to: string, reason: string}}
 */
export function syncBaseURL({
  port,
  host = "127.0.0.1",
  file = defaultConfigPath(),
  dryRun = false,
} = {}) {
  const to = `http://${host}:${port}/v1`

  if (!existsSync(file)) {
    return { changed: false, from: null, to, reason: "config does not exist yet" }
  }

  let raw, parsed
  try {
    ;({ raw, parsed } = readConfig(file))
  } catch (e) {
    return { changed: false, from: null, to, reason: e.message }
  }

  // Nothing to do if our provider is absent or already correct.
  const provider = parsed?.provider?.[PROVIDER_ID]
  if (!provider) {
    return { changed: false, from: null, to, reason: `no '${PROVIDER_ID}' provider in config` }
  }
  const from = provider?.options?.baseURL ?? null
  if (from === to) {
    return { changed: false, from, to, reason: "already correct" }
  }

  if (dryRun) {
    return { changed: true, from, to, reason: "would update (dry run)" }
  }

  // Surgical, in-place mutation of exactly one string.
  provider.options = provider.options || {}
  provider.options.baseURL = to

  const next = JSON.stringify(parsed, null, 2) + "\n"
  if (next === raw) {
    return { changed: false, from, to, reason: "already correct" }
  }

  try {
    mkdirSync(path.dirname(file), { recursive: true })
    // Back up once, before the first mutation.
    const bak = `${file}.bak`
    if (!existsSync(bak)) {
      try { copyFileSync(file, bak) } catch {}
    }
    // Atomic replace: write beside the target, then rename over it.
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, next)
    renameSync(tmp, file)
    return { changed: true, from, to, reason: "updated" }
  } catch (e) {
    try { unlinkSync(`${file}.tmp-${process.pid}`) } catch {}
    return { changed: false, from, to, reason: `write failed: ${e.message}` }
  }
}

/**
 * Human-readable drift report for `doctor`.
 * @returns {{inSync: boolean, configured: string|null, live: string, note: string}}
 */
export function checkDrift({ port, host = "127.0.0.1", file = defaultConfigPath() } = {}) {
  const live = `http://${host}:${port}/v1`
  const configured = currentBaseURL(file)
  if (configured === null) {
    return { inSync: false, configured, live, note: `no '${PROVIDER_ID}' provider installed — run: opencode-cc-go install` }
  }
  if (configured === live) {
    return { inSync: true, configured, live, note: "config matches the running bridge" }
  }
  return {
    inSync: false,
    configured,
    live,
    note: `config points at ${configured} but the bridge is on ${live}`,
  }
}
