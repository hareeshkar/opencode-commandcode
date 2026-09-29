/**
 * safe-io.mjs — defensive output helpers.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * An earlier revision of scripts/probe-schema.mjs parsed its --out flag as:
 *
 *     process.argv[process.argv.indexOf("--out") + 1] || "schema.generated.json"
 *
 * When --out is absent, `indexOf` returns -1, so the index becomes 0, and
 * `process.argv[0]` is the path to the running Node executable. The script then
 * wrote its JSON output over the Node.js binary and broke the user's Node
 * installation.
 *
 * Every script in this repo now resolves output paths through `argOut()` and
 * writes through `writeJson()`, both of which refuse to touch anything that
 * does not look like a project artifact.
 */

import { writeFileSync, existsSync, statSync } from "node:fs"
import path from "node:path"
import os from "node:os"

/** Files/directories we refuse to write to, ever. */
function isForbidden(p) {
  const abs = path.resolve(p)
  if (!path.isAbsolute(abs)) return false
  const home = os.homedir()
  const forbiddenExact = [
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/opt/homebrew/bin",
    "/usr/sbin",
    "/sbin",
    path.join(home, ".local/bin"),
    path.join(home, ".local/lib"),
    path.join(home, ".commandcode/auth.json"),
  ]
  // A bare executable path is the dangerous case: reject any path whose
  // basename has no extension and lives outside the project.
  const inProject = abs.startsWith(path.resolve(process.env.CMD_PROJECT_ROOT || process.cwd()))
  if (!inProject) {
    const base = path.basename(abs)
    const hasExt = path.extname(base) !== ""
    if (!hasExt) return `refusing to write to extensionless path outside the project: ${abs}`
  }
  for (const f of forbiddenExact) {
    if (abs === f || abs.startsWith(f + path.sep)) return `refusing to write inside protected location: ${abs}`
  }
  return null
}

/**
 * Resolve a --out style flag safely.
 * Returns `fallback` unless the flag is present AND followed by a plausible value.
 */
export function argOut(flag, fallback) {
  const i = process.argv.indexOf(flag)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  if (!v || v.startsWith("-")) return fallback
  if (v === process.argv[0] || v === process.execPath) {
    throw new Error(`refusing to use the running executable as an output path (${v})`)
  }
  const bad = isForbidden(v)
  if (bad) throw new Error(bad)
  return path.resolve(v)
}

/** Write JSON, refusing protected locations. */
export function writeJson(file, data) {
  const bad = isForbidden(file)
  if (bad) throw new Error(bad)
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n")
  return file
}

/** True when the path exists and is a regular file. */
export function isFile(p) {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}
