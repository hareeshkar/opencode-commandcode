#!/usr/bin/env node
/**
 * Union-aware content-part prober.
 *
 * The `params.messages[].content` field is a Zod UNION:
 *     content = string  |  content = Array<Part>
 * When you submit a malformed part, Zod prints EVERY failing branch of the
 * union on one line, separated by " or ". That single error is a complete,
 * machine-readable inventory of the multimodal part types and their required
 * fields:
 *
 *   content[0].type: "text" | "image" | "document" | "search_result" |
 *                   "thinking" | "redacted_thinking" | "reasoning" |
 *                   "tool_use" | "tool-call" | "tool_result" |
 *                   "server_tool_use" | "web_search_tool_result" |
 *                   "web_fetch_tool_result"
 *
 * plus the per-type required fields (e.g. image -> image:string + source:object).
 *
 * This script triggers that error with a single deliberately-bad element and
 * parses the whole union out of it. It is the definitive map of what Command
 * Code accepts as model INPUT.
 *
 * Usage: node scripts/probe-parts.mjs [--out parts.generated.json]
 */

import { readFileSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { argOut, writeJson } from "./safe-io.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, "..")
const JSON_ONLY = process.argv.includes("--json-only")
const OUT = argOut("--out", path.join(REPO, "parts.generated.json"))
const say = (...a) => { if (!JSON_ONLY) process.stderr.write(a.join(" ") + "\n") }

const API = process.env.CMD_API_BASE || "https://api.commandcode.ai"
function apiKey() {
  if (process.env.COMMAND_CODE_API_KEY) return process.env.COMMAND_CODE_API_KEY
  const p = path.join(os.homedir(), ".commandcode", "auth.json")
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")).apiKey
  throw new Error("no key")
}
function cliVersion() {
  try {
    return JSON.parse(readFileSync(path.join(os.homedir(), ".local/lib/node_modules/command-code/package.json"), "utf8")).version
  } catch { return "1.69.0" }
}
const KEY = apiKey()
const VERSION = cliVersion()

function base(msgs) {
  return {
    config: {
      workingDir: process.cwd(), date: new Date().toISOString(),
      environment: `${os.platform()}-${os.arch()}`,
      structure: [], isGitRepo: false, currentBranch: "", mainBranch: "", gitStatus: "", recentCommits: [],
    },
    memory: "", threadId: crypto.randomUUID(), mode: "agent",
    params: { model: "deepseek/deepseek-v4-flash", messages: msgs, tools: [], system: "s", max_tokens: 16, stream: true },
  }
}

async function post(body) {
  for (let a = 0; a < 5; a++) {
    const r = await fetch(API + "/alpha/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KEY}`,
        "x-command-code-version": VERSION,
        "x-cli-environment": "production",
        "User-Agent": "cli",
      },
      body: JSON.stringify(body),
    })
    const text = await r.text()
    if (![403, 429, 500, 502, 503].includes(r.status)) return { status: r.status, text }
    await new Promise((s) => setTimeout(s, 500 * 2 ** a))
  }
  return { status: 0, text: "retries exhausted" }
}

/** Pull the union text out of a validation message. */
function unionBranches(message) {
  const hint = message.includes("HINT:") ? message.split("HINT:")[1] : message
  // Each branch is either: ... at "path" or ... at "path";
  const parts = hint.split(" or ").map((s) => s.trim())
  const branches = []
  for (const p of parts) {
    const lit = p.match(/expected "([a-zA-Z_-]+)" at "([^"]+)\.type"/)
    const got = p.match(/at "([^"]+)"/)
    if (lit) {
      branches.push({ type: lit[1], path: lit[2] + ".type", clause: p })
    } else if (got) {
      const req = p.match(/expected ([^,]+?), received \w+ at "([^"]+)"/)
      if (req) branches.push({ required: req[1].trim(), path: req[2], clause: p })
    }
  }
  return branches
}

async function main() {
  say(`probing the content-part union on ${API}/alpha/generate`)
  // A part with no `type` makes every discriminated branch fail, so Zod lists
  // them all in one error.
  const res = await post(base([{ role: "user", content: [{ __trigger__: "union dump" }] }]))
  let message = ""
  try { message = JSON.parse(res.text)?.error?.message || "" } catch {}

  const branches = unionBranches(message)

  // Group: which part types exist, and which fields each requires.
  const partTypes = {}
  for (const b of branches) {
    if (b.type) {
      partTypes[b.type] ??= { type: b.type, requiredFields: [] }
    } else if (b.required && b.path.includes("content[0].")) {
      const field = b.path.split("content[0].")[1]
      // the type this field belongs to is the nearest preceding type literal
      partTypes.__last ??= { type: "unknown", requiredFields: [] }
      const owner = partTypes.__last
      if (owner && !owner.requiredFields.some((f) => f.name === field)) {
        owner.requiredFields.push({ name: field, type: b.required })
      }
    }
  }
  // attach required fields to the type literal that precedes them in the message
  const ordered = []
  for (const b of branches) {
    if (b.type) {
      const entry = partTypes[b.type]
      if (!ordered.includes(entry)) ordered.push(entry)
    } else if (b.required && b.path.includes("content[0].")) {
      const field = b.path.split("content[0].")[1]
      const owner = ordered[ordered.length - 1]
      if (owner && !owner.requiredFields.some((f) => f.name === field)) {
        owner.requiredFields.push({ name: field, type: b.required })
      }
    }
  }
  delete partTypes.__last
  for (const k of Object.keys(partTypes)) delete partTypes[k]

  const modalityOf = (t) => {
    if (t === "image") return ["image"]
    if (t === "document") return ["document", "pdf"]
    if (t === "text" || t === "thinking" || t === "redacted_thinking" || t === "reasoning" || t === "search_result") return ["text"]
    if (t.startsWith("tool") || t.startsWith("web_") || t === "server_tool_use") return ["text", "tool-output"]
    return ["text"]
  }

  const out = {
    $comment:
      "GENERATED by scripts/probe-parts.mjs from the Zod union error. " +
      "Authoritative map of the multimodal part types Command Code accepts as model INPUT.",
    generatedAt: new Date().toISOString(),
    cliVersion: VERSION,
    status: res.status,
    branchCount: branches.length,
    partTypes: ordered.map((p) => ({ ...p, modalities: modalityOf(p.type) })),
    inputModalitiesOverall: [...new Set(ordered.flatMap((p) => modalityOf(p.type)))]
      .filter((m) => m !== "tool-output")
      .sort(),
  }

  writeJson(OUT, out)
  say(`wrote ${path.relative(REPO, OUT)}: ${out.partTypes.length} part types`)
  for (const p of out.partTypes) {
    say(`  ${p.type.padEnd(26)} modalities=${p.modalities.join(",").padEnd(16)} required=${p.requiredFields.map((f) => f.name).join(",") || "-"}`)
  }
  say(`  overall input modalities: ${out.inputModalitiesOverall.join(", ")}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
