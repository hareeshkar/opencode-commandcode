#!/usr/bin/env node
// Extract the model catalog from an installed command-code CLI bundle.
//
// The CLI ships a minified ESM bundle (dist/cli.mjs) that embeds a literal
// model table. We parse it with brace matching (regex cannot handle nested
// objects) and pull out id / display name / contextWindow / inputModalities /
// reasoningEfforts. Output is a JSON catalog.
//
// Usage: node scripts/extract-catalog.mjs [path/to/cli.mjs] > catalog.json

import { readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const input =
  process.argv[2] ||
  path.join(os.homedir(), ".local/lib/node_modules/command-code/dist/cli.mjs")

const src = readFileSync(input, "utf8")

// Find every object literal that contains an `id:"..."` key, then walk balanced
// braces from the opening brace of that literal.
function* objectLiterals(text) {
  const re = /\bid:\s*"/g
  let m
  while ((m = re.exec(text))) {
    // walk backwards to the nearest '{'
    let i = m.index - 1
    while (i >= 0 && text[i] !== "{") i--
    if (i < 0) continue

    let depth = 0
    let inStr = null
    let esc = false
    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (inStr) {
        if (esc) esc = false
        else if (c === "\\") esc = true
        else if (c === inStr) inStr = null
        continue
      }
      if (c === '"' || c === "'" || c === "`") { inStr = c; continue }
      if (c === "{") depth++
      else if (c === "}") {
        depth--
        if (depth === 0) {
          yield text.slice(i, j + 1)
          break
        }
      }
    }
  }
}

const str = (o, k) => {
  const m = o.match(new RegExp(`\\b${k}:\\s*"([^"]*)"`))
  return m ? m[1] : undefined
}
// Numbers may be written in scientific notation by the minifier, e.g.
// `contextWindow:1e6` or `contextWindow:262144`. A bare \d+ would capture "1".
const num = (o, k) => {
  const m = o.match(
    new RegExp(`\\b${k}:\\s*(\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)`, "i"),
  )
  if (!m) return undefined
  const v = Number(m[1])
  return Number.isFinite(v) ? v : undefined
}
const bool = (o, k) => {
  const m = o.match(new RegExp(`\\b${k}:\\s*(!0|!1|true|false)`))
  if (!m) return undefined
  return m[1] === "!0" || m[1] === "true"
}
const arr = (o, k) => {
  const m = o.match(new RegExp(`\\b${k}:\\s*\\[([^\\]]*)\\]`))
  if (!m) return undefined
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
}

const catalog = new Map()
for (const lit of objectLiterals(src)) {
  const id = str(lit, "id")
  if (!id || !/^[a-zA-Z][\w.-]*\/[\w.-]+$/.test(id)) continue
  const inputModalities = arr(lit, "inputModalities")
  const contextWindow = num(lit, "contextWindow")
  const reasoningEfforts = arr(lit, "reasoningEfforts")
  const name = str(lit, "name")
  const reasoning = bool(lit, "reasoning")
  const description = str(lit, "description")
  if (!inputModalities && contextWindow === undefined && !reasoningEfforts) continue
  if (!catalog.has(id)) {
    catalog.set(id, {
      id,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(inputModalities ? { inputModalities } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
    })
  }
}

const out = {
  extractedFrom: input,
  extractedAt: new Date().toISOString(),
  modelCount: catalog.size,
  models: [...catalog.values()].sort((a, b) => a.id.localeCompare(b.id)),
}
process.stdout.write(JSON.stringify(out, null, 2) + "\n")
process.stderr.write(`extracted ${catalog.size} models from ${input}\n`)
