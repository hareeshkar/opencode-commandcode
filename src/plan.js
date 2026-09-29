/**
 * plan.js — Command Code plan identification.
 *
 * WHY THIS EXISTS
 * ---------------
 * This package exists for exactly one situation: you are on the $1/month
 * **Go** plan, which Command Code documents as having *no* Provider API. Every
 * other plan — Provider, Pro, Max, Ultra, GOAT, Team — already has full
 * OpenAI- and Anthropic-compatible API access, and those users should just
 * point OpenCode at the API directly.
 *
 * So the plan is identified explicitly, and users who do not need the bridge
 * are told so instead of quietly inheriting a moving part.
 *
 * This lives in its own module, with no side effects and no dependencies,
 * because two very different entry points need it:
 *
 *   - src/bridge.js    (a long-running HTTP server)
 *   - scripts/install.js (a short-lived CLI that must NOT bind a port)
 *
 * Importing the server module from the installer would start a listener and
 * then exit the process on EADDRINUSE. Hence: no side effects here.
 */

// planIds that identify the $1 Go plan.
const GO_PLAN_IDS = new Set(["individual-go-v1", "individual-go", "go", "individual-goat-free"])

// Substrings that identify a plan which already includes API access. The API
// returns planIds like "individual-pro-v1", "teams-pro", "individual-goat", so
// substring matching is the honest way to stay forward compatible with tiers we
// have not seen yet. An unrecognised plan deliberately returns
// needsBridge: null rather than guessing.
const API_ENABLED_HINTS = ["provider", "pro", "max", "ultra", "goat", "team"]

/** The config a user on an API-enabled plan actually needs. */
export const DIRECT_API_CONFIG = {
  provider: {
    commandcode: {
      npm: "@ai-sdk/openai-compatible",
      name: "Command Code",
      options: {
        baseURL: "https://api.commandcode.ai/v1",
        apiKey: "{env:COMMAND_CODE_API_KEY}",
      },
    },
  },
}

export const DIRECT_API_INSTRUCTIONS = [
  '  You already have a real, supported API. This package is only for the $1 Go',
  '  plan, which has no Provider API. You do not need this bridge.',
  '',
  '  Point OpenCode at the API directly in opencode.json:',
  '',
  '    "provider": {',
  '      "commandcode": {',
  '        "npm": "@ai-sdk/openai-compatible",',
  '        "name": "Command Code",',
  '        "options": {',
  '          "baseURL": "https://api.commandcode.ai/v1",',
  '          "apiKey": "{env:COMMAND_CODE_API_KEY}"',
  '        }',
  '      }',
  '    }',
  '',
  '  Then create a key at https://commandcode.ai/studio and:',
  '',
  '    export COMMAND_CODE_API_KEY="cmd_..."',
  '',
  '  Install this package anyway with --force if you specifically want the bridge.',
].join("\n")

/**
 * Classify a Command Code planId.
 *
 * @param {string|null|undefined} planId
 * @returns {{known: boolean, needsBridge: boolean|null, label?: string, note: string}}
 *   needsBridge === true   -> Go plan, install this
 *   needsBridge === false  -> plan already has API access, do NOT install
 *   needsBridge === null   -> unknown, let the user decide
 */
export function classifyPlan(planId) {
  if (!planId) {
    return {
      known: false,
      needsBridge: null,
      note: "plan could not be determined; proceeding because this may be the Go plan",
    }
  }
  const id = String(planId).toLowerCase()

  if (GO_PLAN_IDS.has(id)) {
    return {
      known: true,
      needsBridge: true,
      label: "Go ($1)",
      note: "Go plan has no Provider API - this bridge is the supported way to use it externally.",
    }
  }

  if (API_ENABLED_HINTS.some((h) => id.includes(h))) {
    return {
      known: true,
      needsBridge: false,
      label: planId,
      note: "This plan already includes Provider API access; the bridge is unnecessary.",
    }
  }

  return {
    known: false,
    needsBridge: null,
    note: `unrecognised plan '${planId}'; proceeding because this may be the Go plan`,
  }
}

/** Read the current planId from the live API. Returns null if undeterminable. */
export async function fetchPlanId({ apiBase, apiKey, cliVersion, fetchImpl = fetch }) {
  if (!apiKey) return null
  const base = apiBase || "https://api.commandcode.ai"
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    ...(cliVersion ? { "x-command-code-version": cliVersion } : {}),
  }
  for (const route of ["/alpha/billing/subscriptions", "/alpha/whoami"]) {
    try {
      const r = await fetchImpl(base + route, { headers })
      const j = await r.json().catch(() => null)
      const id = j?.data?.planId ?? j?.org?.planId ?? null
      if (id) return id
    } catch {}
  }
  return null
}
