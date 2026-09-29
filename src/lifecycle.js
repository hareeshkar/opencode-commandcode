/**
 * Bridge lifecycle: environment detection, start, stop, ownership.
 *
 * WHY THIS EXISTS
 * ---------------
 * The bridge is a local HTTP server on a loopback port. Three different
 * environments need three different answers to "should I run one, and who
 * cleans it up?":
 *
 *   local      A developer machine. A launchd agent may already own the bridge.
 *              If we did not start it, we must NOT stop it.
 *   cloud      A remote sandbox (OpenCode Cloud, CI, a container). Nothing
 *              persists, nothing is supervised, and a detached daemon would
 *              outlive the session and leak a port. The bridge must be a
 *              tracked child that dies with OpenCode.
 *   unknown    Anything we cannot classify. Behave like cloud: the safe failure
 *              mode is "no leaked process", not "a process nobody reaps".
 *
 * The rule that makes this safe: **we only ever stop a bridge we started.**
 * Anything else is somebody else's process and stays running.
 *
 * OWNERSHIP
 * ---------
 * `start()` records the child and the port. `stop()` kills exactly that child
 * and clears the state file. A second call is a no-op. This is what keeps the
 * plugin, the CLI and the launchd agent from fighting over one port.
 */

import { spawn, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export const DEFAULT_HOST = "127.0.0.1"

/** Cooldown between start attempts, so a slow start cannot become a respawn loop. */
export const RESTART_COOLDOWN_MS = 10_000

/** How long to wait for a freshly spawned bridge to answer /health. */
export const STARTUP_TIMEOUT_MS = 8_000

// ------------------------------------------------------------------ environment

/**
 * Classify the runtime by capability, not by guessing a product name.
 *
 * Every check is something we can actually test. `process.env` is used only as
 * corroboration, never as the sole basis for a decision, because a stale
 * variable in a shell profile must not be able to change our behaviour.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.home]      override os.homedir(), for tests
 * @param {boolean} [opts.configWritable] override the config writability probe
 * @param {boolean} [opts.hasCredentials]  override the credential probe
 */
export function detectEnvironment({
  env = process.env,
  home = os.homedir(),
  configWritable,
  hasCredentials,
  platform = process.platform,
} = {}) {
  const reasons = []

  // --- credentials -------------------------------------------------------
  // Without a key there is no bridge, in any environment. This is the single
  // most important gate: a cloud sandbox has no ~/.commandcode/auth.json.
  let creds = hasCredentials
  if (creds === undefined) {
    if (env.COMMAND_CODE_API_KEY) {
      creds = true
      reasons.push("credentials from COMMAND_CODE_API_KEY")
    } else {
      try {
        const raw = readFileSync(path.join(home, ".commandcode", "auth.json"), "utf8")
        creds = Boolean(JSON.parse(raw)?.apiKey || JSON.parse(raw)?.token)
        if (creds) reasons.push("credentials from ~/.commandcode/auth.json")
      } catch {
        creds = false
      }
    }
  }

  // --- persistent config -------------------------------------------------
  // A cloud sandbox usually has a writable $HOME that is thrown away at the
  // end of the run, so "writable" is not the question. "survives a reboot" is.
  let writable = configWritable
  if (writable === undefined) {
    try {
      // The directory has to be created first. An earlier version wrote into a
      // path that did not exist, so the probe always threw, every machine was
      // classified as an ephemeral sandbox, and a desktop lost its detach
      // behaviour and its config-drift repair. The failure was silent: nothing
      // errored, the answer was just always wrong.
      const dir = path.join(home, ".commandcode-go-probe")
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, "probe"), "x")
      unlinkSync(path.join(dir, "probe"))
      rmdirSync(dir)
      writable = true
    } catch {
      writable = false
    }
  }

  // --- launchd / systemd supervision -------------------------------------
  // A supervised bridge is the local happy path: someone else restarts it, so
  // we neither need to start one nor stop one.
  const supervised = Boolean(env.CMD_BRIDGE_SUPERVISED)

  // --- classification ----------------------------------------------------
  // A sandbox is identified by the absence of the things a desktop needs.
  // We treat "no writable persistent config" as the discriminator because
  // that is what actually breaks the installer path, and it is testable.
  let kind
  if (supervised) {
    kind = "local"
    reasons.push("bridge reported as externally supervised")
  } else if (!writable) {
    kind = "cloud"
    reasons.push("home directory is not writable (ephemeral sandbox)")
  } else if (env.OPENCODE_CLOUD === "1" || env.OPENCODE_CLOUD === "true") {
    kind = "cloud"
    reasons.push("OPENCODE_CLOUD is set")
  } else if (env.CI === "true" || env.GITHUB_ACTIONS === "true") {
    kind = "cloud"
    reasons.push("running in CI")
  } else if (!creds) {
    kind = "cloud"
    reasons.push("no credentials available")
  } else {
    kind = "local"
  }

  return {
    kind,
    isCloud: kind === "cloud",
    isLocal: kind === "local",
    hasCredentials: Boolean(creds),
    configWritable: Boolean(writable),
    supervised,
    host: env.CMD_BRIDGE_HOST || DEFAULT_HOST,
    // In a sandbox a detached daemon would outlive the session and hold a
    // port with nothing left to reap it. The bridge is a tracked child there.
    allowDetach: kind === "local",
    reasons,
  }
}

// ------------------------------------------------------------------- ownership

/** The single bridge this process is responsible for, if any. */
let owned = null
let lastStartAttempt = 0

/** Test seam: forget everything we think we own. */
export function _resetOwnership() {
  owned = null
  lastStartAttempt = 0
}

/**
 * Test seam: claim an arbitrary child as ours, so the escalation path in stop()
 * can be exercised against a process that deliberately ignores SIGTERM.
 *
 * Exported only for tests. Production code reaches ownership exclusively through
 * start(), which is the only thing allowed to set it.
 */
export function _adoptForTest(child, port, host = DEFAULT_HOST) {
  owned = { child, port, host, startedAt: Date.now() }
}

/** True when this process started the bridge and is therefore allowed to stop it. */
export function ownsBridge() {
  return owned !== null
}

/** The port we started, or null. */
export function ownedPort() {
  return owned?.port ?? null
}

// ---------------------------------------------------------------------- health

export async function probeBridge({ host = DEFAULT_HOST, port, timeoutMs = 1200, portModule } = {}) {
  const mod = portModule || (await import("./port.js"))
  const found = port ? { port } : await mod.discoverPort({ host })
  if (!found) return null
  return (await mod.isServing(found.port, host, timeoutMs)) ? found : null
}

// ----------------------------------------------------------------------- start

/**
 * Start the bridge unless something is already serving.
 *
 * @returns {Promise<{ok: true, port: number, started: boolean, baseURL: string}
 *                 | {ok: false, reason: string}>}
 */
export async function start({
  bridgeMain,
  host = DEFAULT_HOST,
  env = process.env,
  envInfo,
  allowDetach,
  timeoutMs = STARTUP_TIMEOUT_MS,
  now = Date.now,
  spawnImpl = spawn,
  // Only used for the "is something already serving?" pre-flight check. The
  // readiness check that follows a spawn always uses the real port module,
  // because the child has just been told which port to take and we need to
  // observe that it did. Keeping the two separate is what lets a test force a
  // genuine spawn without also blinding itself to the result.
  preflightPortModule,
} = {}) {
  if (!existsSync(bridgeMain)) {
    return { ok: false, reason: `bridge not found at ${bridgeMain}` }
  }

  const existing = await probeBridge({ host, portModule: preflightPortModule })
  if (existing) {
    // Someone else owns it — a launchd agent, or the user in another terminal.
    // Not ours to stop, and not a reason to start a second one.
    return { ok: true, port: existing.port, started: false, baseURL: `http://${host}:${existing.port}/v1` }
  }

  const t = now()
  if (t - lastStartAttempt < RESTART_COOLDOWN_MS) {
    return { ok: false, reason: "start rate-limited (another attempt is too recent)" }
  }
  lastStartAttempt = t

  const info = envInfo || detectEnvironment({ env })
  const detach = allowDetach ?? info.allowDetach

  let child
  try {
    child = spawnImpl(process.execPath, [bridgeMain], {
      // Detached only where something external supervises. In a sandbox the
      // child is deliberately NOT detached so it dies with this process.
      detached: detach,
      stdio: "ignore",
      env,
    })
  } catch (e) {
    return { ok: false, reason: `spawn failed: ${e.message}` }
  }

  // A detached child is unref'd so it cannot hold the event loop open. A
  // tracked (non-detached) child is deliberately NOT unref'd: it should keep
  // OpenCode alive until the bridge is genuinely up, and then be killed by
  // dispose() rather than by the runtime.
  if (detach) child.unref?.()

  const deadline = t + timeoutMs
  const wanted = Number(env?.CMD_BRIDGE_PORT)
  while (Date.now() < deadline) {
    await sleep(200)
    if (child.exitCode !== null || child.signalCode) {
      return { ok: false, reason: `bridge exited immediately (code ${child.exitCode ?? child.signalCode})` }
    }
    // Readiness must be observed on a port THIS child owns, never on whatever
    // else happens to be listening. A bare discoverPort() would happily report
    // a second, unrelated bridge as success and then hand us ownership of a
    // process we did not start.
    const found = await observeChild({ child, host, wanted })
    if (found) {
      owned = { child, port: found.port, host, startedAt: Date.now() }
      return { ok: true, port: found.port, started: true, baseURL: `http://${host}:${found.port}/v1` }
    }
  }
  // Timed out. Do not leave a half-started process behind.
  safeKill(child)
  return { ok: false, reason: `bridge did not become healthy within ${timeoutMs}ms` }
}

/**
 * Observe a just-spawned bridge on a port it demonstrably owns.
 *
 * If we named an exact port, that is the only acceptable answer. Otherwise the
 * state file has to name a live process AND that process has to be the child we
 * spawned (or a descendant of it). A foreign bridge elsewhere on the machine
 * satisfies neither, so it can never be mistaken for ours.
 */
async function observeChild({ child, host, wanted }) {
  const { readState, isServing } = await import("./port.js")

  // Fast path: the port we asked for is free and the child took it.
  if (Number.isInteger(wanted) && wanted > 0) {
    if (await isServing(wanted, host, 800)) return { port: wanted }
  }

  // Otherwise the bridge may have scanned past a taken port, or picked one
  // itself. Trust it only when the state file names a live process that is our
  // child (or a descendant). A foreign bridge elsewhere satisfies neither.
  const st = readState()
  if (!st || typeof st.port !== "number" || !st.pid) return null
  try { process.kill(st.pid, 0) } catch { return null }
  if (st.pid !== child.pid && !isDescendant(st.pid, child.pid)) return null
  if (st.port === wanted) return null // already handled above, and not serving
  return (await isServing(st.port, host, 800)) ? { port: st.port } : null
}

/** Walk parent pids; portable across macOS and Linux without /proc. */
function isDescendant(pid, ancestorPid) {
  if (!pid || !ancestorPid || pid === ancestorPid) return false
  try {
    const ppid = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim())
    if (!Number.isFinite(ppid) || ppid <= 1) return false
    return ppid === ancestorPid || isDescendant(ppid, ancestorPid)
  } catch {
    return false
  }
}

// ------------------------------------------------------------------------ stop

/**
 * Stop the bridge **if and only if this process started it**.
 *
 * Async on purpose. An earlier version polled `child.exitCode` behind
 * `Atomics.wait`, which blocks the event loop — so Node never delivered the
 * 'exit' event, the check always looked "still running", and every stop escalated
 * to SIGKILL. SIGKILL cannot be trapped, so the bridge never ran its own exit
 * handler and its state file was left behind describing a dead pid. Real bug,
 * found by a test asserting `escalated === false` on a clean shutdown.
 *
 * @returns {Promise<{stopped: boolean, port?: number, escalated?: boolean, reason?: string}>}
 */
export async function stop({ signal = "SIGTERM", graceMs = 3000 } = {}) {
  if (!owned) return { stopped: false, reason: "not started by this process" }
  const { child, port } = owned
  owned = null

  if (child.exitCode !== null || child.signalCode !== null) {
    return { stopped: true, alreadyExited: true, port, escalated: false }
  }

  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true)
    child.once("exit", () => resolve(true))
    child.once("error", () => resolve(true))
  })

  try {
    child.kill(signal)
  } catch (e) {
    return { stopped: false, reason: `kill failed: ${e.message}`, port }
  }

  const raced = await Promise.race([exited, sleep(graceMs).then(() => false)])
  if (raced) return { stopped: true, port, escalated: false }

  // Genuinely wedged. Escalate, or it keeps the port forever.
  try { child.kill("SIGKILL") } catch { /* already gone */ }
  await Promise.race([exited, sleep(1000).then(() => false)])
  return { stopped: true, port, escalated: true }
}

/** Register process-exit handlers so a crash or Ctrl-C never leaks the child. */
export function installExitHandlers({ target = process, onStop = stop } = {}) {
  const handler = () => {
    try {
      onStop()
    } catch {
      /* never let cleanup throw during exit */
    }
  }
  target.once("exit", handler)
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    target.on(sig, () => {
      handler()
      // Re-raise with default disposition so our own exit status is honest.
      if (sig !== "SIGHUP") target.kill(process.pid, sig)
    })
  }
  return () => {
    target.off("exit", handler)
  }
}

// ----------------------------------------------------------------------- utils

function safeKill(child) {
  try {
    child.kill("SIGKILL")
  } catch {
    /* already gone */
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
