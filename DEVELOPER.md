# DEVELOPER.md

Complete technical record for `opencode-commandcode`.

This document is the answer to "how does this work, why is it built this way,
how do I verify it, and what happens when Command Code changes something."

It is written to be read end to end by a maintainer who has never seen the
project, and to be *searchable* by someone debugging at 2am.

---

## Table of contents

1. [What the package is](#1-what-the-package-is)
2. [Why a bridge exists at all](#2-why-a-bridge-exists-at-all)
3. [How the $1 plan was unlocked](#3-how-the-1-plan-was-unlocked)
4. [The wire protocol](#4-the-wire-protocol)
5. [Discovery system](#5-discovery-system)
   - [5.1 Catalog extraction](#51-catalog-extraction-static)
   - [5.2 Reachability probing](#52-reachability-probing-live)
   - [5.3 Envelope extraction](#53-envelope-extraction-static)
   - [5.4 Schema brute-forcing](#54-schema-brute-forcing-network)
   - [5.5 Content-part union extraction](#55-content-part-union-extraction-network)
6. [The full discovered contract](#6-the-full-discovered-contract)
7. [Input modalities and dimensionality](#7-input-modalities-and-dimensionality)
8. [Runtime architecture](#8-runtime-architecture)
9. [The translation layer](#9-the-translation-layer)
10. [Error handling and self-healing](#10-error-handling-and-self-healing)
11. [OpenCode integration](#11-opencode-integration)
12. [Testing](#12-testing)
13. [Every script, every parameter](#13-every-script-every-parameter)
14. [Operational runbook](#14-operational-runbook)
15. [Research log and sources](#15-research-log-and-sources)
16. [Failure modes we hit](#16-failure-modes-we-hit)
17. [Design decisions and their trade-offs](#17-design-decisions-and-their-trade-offs)
18. [What would break this](#18-what-would-break-this)

---

## 1. What the package is

Four things in one zero-dependency Node package:

| Component | File | Role |
|---|---|---|
| **Bridge server** | `src/bridge.js` | Local OpenAI-compatible HTTP server; translates to Command Code's private format |
| **Translation layer** | `src/translate.js` | Pure functions: OpenAI ⇄ wire, no I/O, fully unit-testable |
| **Plan classifier** | `src/plan.js` | Side-effect-free: "is this user on the $1 Go plan, or do they already have an API?" |
| **Port manager** | `src/port.js` | Auto-selects a free port, publishes it via a state file, discovers it again |
| **Config sync** | `src/config-sync.js` | Rewrites OpenCode's `baseURL` when the port changes, atomically and surgically |
| **Plugin** | `src/plugin.js` | OpenCode hook package: injects the provider, supervises the bridge |
| **Installer** | `scripts/install.js` | Writes the provider into `opencode.json` (the reliable path) |

Plus the discovery system that generates the data all of them read:

| Script | Output | Method |
|---|---|---|
| `scripts/extract-catalog.mjs` | `catalog.extracted.json` | static parse of the CLI bundle |
| `scripts/build-catalog.mjs` | `catalog.json` | merge static + live reachability |
| `scripts/extract-envelope.mjs` | `envelope.generated.json` | static parse of the CLI's request literal |
| `scripts/probe-schema.mjs` | `schema.generated.json` | network brute-force via Zod error inference |
| `scripts/probe-parts.mjs` | `parts.generated.json` | network, via union-type error dump |
| `scripts/safe-io.mjs` | — | output-path guard (see §16.6) |
| `scripts/install.js` | writes `opencode.json` | plan gate + auto port resolution (see §11.3) |

**Zero runtime dependencies.** Node built-ins only. The whole point is
portability: it must run on a machine with a bare `node` and nothing else.

---

## 2. Why a bridge exists at all

Command Code sells subscriptions. Only some of them include API access.

Checked directly against the docs and the live account during this build:

- `https://commandcode.ai/docs/provider` — *"Every plan except the Go plan has
  API access. GOAT, Pro, Max, and Team have API access."*
- `https://commandcode.ai/provider` — Provider plan, `$15/month + $1.01`.
- `https://commandcode.ai/pricing` — Go plan, `$1/mo`.

Our account's own subscription, read from the API:

```bash
curl -s https://api.commandcode.ai/alpha/billing/subscriptions \
  -H "Authorization: Bearer $KEY" | jq .data.planId
# "individual-go-v1"
```

`individual-go-v1` is the $1 Go plan. It has **no** Provider API.

But — and this is the whole trick — the `cmd` terminal application has to talk
to *something*. It is not running inference locally. It POSTs to
`api.commandcode.ai`. That endpoint is what the CLI uses on every turn, it is
not plan-gated, and it speaks a **custom envelope** rather than OpenAI or
Anthropic shape.

So the $1 plan is not "no models". It is "no *open* models". The models are
reachable; only the public door is locked.

**The bridge opens the door by re-implementing the client, not by bypassing
anything.** It authenticates with the same key the CLI uses, sends the same
headers, and is metered against the same credits. A full test run costs about
0.02 credits.

---

## 3. How the $1 plan was unlocked

This is the reconstruction, in the order it actually happened. It is written
out because the reasoning is the interesting part, not the result.

### 3.1 Start from the installed CLI, not the internet

The most reliable specification of a private API is the client that already
speaks it. The CLI is a single minified ESM bundle:

```
~/.local/lib/node_modules/command-code/dist/cli.mjs   (2.67 MB)
```

Two facts fell out of a first pass over it:

1. The API host is `https://api.commandcode.ai` (three envs: `prod`, `staging`,
   `local`).
2. There is a route constant `Hk="/alpha/generate"` and exactly one call site
   that uses it.

Everything after this point is reverse-engineering from behaviour, not
guesswork.

### 3.2 Find the headers

Grepping the bundle for the header table produced the complete identity block:

```js
tS = {
  OAUTH_TOKEN: "x-oauth-token",
  OAUTH_PROVIDER: "x-oauth-provider",
  PROJECT_SLUG: "x-project-slug",
  TASTE_LEARNING: "x-taste-learning",
  CLI_ENVIRONMENT: "x-cli-environment",
  CLI_VERSION: "x-command-code-version",     // <-- the important one
  OSS_PRIMARY_PROVIDER: "x-oss-primary-provider",
  SESSION_ID: "x-session-id",
  CMD_ZDR: "x-cmd-zdr",
  PROVIDER_DEEPSEEK_INTERNAL: "x-cmd-provider-deepseek-internal",
}
nS = "cli"                                     // User-Agent
```

### 3.3 The first real failure

The first `/alpha/generate` call, built from the bundle's own body literal,
came back:

```json
{"error":{"code":"upgrade_required",
  "message":"Your Command Code CLI is out of date. Run `cmd update` ...",
  "minVersion":"0.18.10"}}
```

The server is **version-gated**. It refuses any request whose
`x-command-code-version` is too old, and it treats a missing header the same
way. The installed CLI was 1.69.0, so the header must carry the *installed*
version verbatim. The bridge reads it from
`~/.local/lib/node_modules/command-code/package.json` on every request rather
than hardcoding a number, so upgrading the CLI can't strand it.

This is worth emphasising: **the version header is read at runtime from the
installed CLI.** That single decision is what makes the bridge survive
upgrades.

### 3.4 The schema fight

With the header fixed, the server started rejecting the *body* — and, helpfully,
told us precisely how. The error text is the specification (§4, §5.4).

### 3.5 The discovery that unblocked everything

A long tail of confusing `403`s turned out to be one sentence:

```
MODEL_NOT_IN_PLAN: Claude Sonnet 4.6 available in Pro and above plans
```

`params.model` is **optional**. When you omit it, the server substitutes its
own default — `claude-sonnet-4-6` — which the Go plan cannot access. So a
request that validates *perfectly* still fails, with a 403 that looks nothing
like a validation error.

The schema crawler had been treating any non-400 as "discovery complete" and
silently reporting a truncated schema. Two fixes were needed:

1. The crawler must treat only `200` as success and retry transient statuses.
2. It must *seed* a plan-accessible model, or it can never close the loop.

That is why `crawl()` in `scripts/probe-schema.mjs` has a `SEED` constant. It
is the only piece of vendor-specific knowledge in the crawler, and it is a
*value*, not a schema fact. Every field name, type, enum and optionality is
still discovered.

---

## 4. The wire protocol

Recovered by combining §5.3 (what the CLI sends) and §5.4 (what the server
accepts).

### 4.1 Transport

```
POST https://api.commandcode.ai/alpha/generate
Content-Type:  application/json
Accept:        application/json, text/event-stream
Authorization: Bearer user_<...>            # same key as `cmd auth login`
x-command-code-version: <installed CLI version>
x-cli-environment: production
User-Agent: cli
```

### 4.2 Request envelope

```jsonc
{
  "config": {                     // REQUIRED, all 9 fields REQUIRED
    "workingDir":   "/abs/path",
    "date":         "2026-09-29T14:00:00.000Z",
    "environment":  "darwin-arm64",
    "structure":    [],           // array; element type is string
    "isGitRepo":    false,
    "currentBranch":"",
    "mainBranch":   "",
    "gitStatus":    "",
    "recentCommits":[]            // array; element type is string
  },

  "memory":  "",                 // REQUIRED (string). null is rejected.
  "taste":   null,               // optional string|null
  "skills":  null,               // optional string|null

  "permissionMode": "standard",  // optional enum
  "threadId":  "<uuid v4>",      // optional, but a bad UUID is a hard 400
  "mode":       "agent",         // optional enum
  "promptCache": "off",          // optional, ONLY the literal "off"

  "params": {                    // REQUIRED
    "model":     "deepseek/deepseek-v4.1-flash",  // optional! server defaults
    "messages":  [ /* see §6.3 */ ],              // REQUIRED
    "tools":     [],                              // optional
    "system":    "…",                             // optional string
    "max_tokens": 32000,                          // optional number
    "stream":     true,                           // optional, ONLY true
    "temperature": 0.7,                           // optional number
    "reasoning_effort": "high"                    // optional enum
  }
}
```

### 4.3 Response: NDJSON, not SSE

This is the second thing that trips people up. The response is
**newline-delimited JSON** — not `text/event-stream` — even though the `Accept`
header advertises SSE. Each line is a Vercel-AI-SDK-style stream event.

| Event | Meaning | Bridge action |
|---|---|---|
| `start` | stream opened | ignore |
| `start-step` | echoes the resolved upstream body (note: the **routed** model, which may differ from the requested one) | ignore |
| `reasoning-start` / `-delta` / `-end` | model thinking | → `delta.reasoning_content` |
| `text-start` / `-delta` / `-end` | assistant text | → `delta.content` |
| `tool-input-start` / `-delta` / `-end` | **partial** JSON preview of a tool call | **ignored — see below** |
| `tool-call` | the authoritative, complete tool call | → `delta.tool_calls[]` |
| `tool-result` | provider-executed tool result | ignore (we execute locally) |
| `finish-step` | per-step finish + usage | capture |
| `finish` | final finish reason + **total** usage | capture |
| `provider-metadata` | upstream vendor hints (e.g. Novita) | ignore |
| `error` | mid-stream error | → error frame, then `[DONE]` |

Observed verbatim from a real call:

```json
{"type":"start"}
{"type":"start-step","request":{"body":{"model":"deepseek/deepseek-v4.1-flash",…}}}
{"type":"reasoning-start","id":"reasoning-0"}
{"type":"reasoning-delta","id":"reasoning-0","text":"The"}
{"type":"reasoning-end","id":"reasoning-0"}
{"type":"text-start","id":"txt-0"}
{"type":"text-delta","id":"txt-0","text":"OK"}
{"type":"text-end","id":"txt-0"}
{"type":"finish-step","finishReason":"stop","rawFinishReason":"stop","usage":{…}}
{"type":"finish","finishReason":"stop","rawFinishReason":"stop","totalUsage":{…}}
{"type":"provider-metadata","providerMetadata":{"novita":{…}}}
```

**On the `tool-input-*` events.** The stream emits the tool call's arguments
twice: once incrementally as `tool-input-delta` string fragments, then again in
full as a single `tool-call` event with a parsed `input` object. Emitting both
to an OpenAI client makes it concatenate the arguments twice and produce
invalid JSON. The bridge emits **only** `tool-call`. The trade-off: tool
arguments don't stream progressively. Correctness beat prettiness.

---

## 5. Discovery system

The design rule: **hardcode nothing that the vendor could change.**

Four probes, two static and two live, each covering what the others cannot.

```
  CLI bundle ──┬─> catalog.extracted.json  (67 models: ctx + modalities)
               └─> envelope.generated.json (field names, incl. optional)
                                    │
 live API ─────┬─> catalog.reachability.json (49/67 reachable)
               ├─> schema.generated.json   (38 paths, types, enums)
               └─> parts.generated.json    (14 input part types)
                                    │
                                    v
                              catalog.json  →  bridge + installer
```

### 5.1 Catalog extraction (static)

`scripts/extract-catalog.mjs` parses the minified bundle.

The model table is a plain object literal, so the approach is **balanced-brace
matching** — regex cannot handle nested objects:

```js
for (const lit of objectLiterals(src)) {
  const id = str(lit, "id")
  if (!id || !/^[a-zA-Z][\w.-]*\/[\w.-]+$/.test(id)) continue
  catalog.set(id, {
    id,
    contextWindow:    num(lit, "contextWindow"),
    inputModalities:  arr(lit, "inputModalities"),
    reasoningEfforts: arr(lit, "reasoningEfforts"),
    reasoning:        bool(lit, "reasoning"),
  })
}
```

**Bug worth documenting.** The minifier writes numbers in scientific notation:

```js
{id:"deepseek/deepseek-v4.1-flash", …, contextWindow:1e6}
```

A naive `contextWindow:\s*(\d+)` captures `1`, producing a 1,000,000× context
window and quietly destroying OpenCode's context budgeting. The number parser
must accept `1e6`:

```js
new RegExp(`\\b${k}:\\s*(\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)`, "i")
```

This is exactly the kind of bug that never throws — it just makes the tool
think every model has a 1-token window.

Static extraction yields **67 models** from a 2.67 MB bundle in ~200 ms.

### 5.2 Reachability probing (live)

The catalog says which models *exist*. It cannot say which ones *your plan* can
call. That requires asking.

`scripts/build-catalog.mjs --probe` sends one minimal request per model and
records the verdict:

```js
{ params: { model: id, messages: [{role:"user",content:[{type:"text",text:"Reply with the single word OK"}]}],
            tools: [], system: "You are terse.", max_tokens: 16, stream: true } }
```

Deliberately tiny: 16 output tokens, one-word prompt. Probes run **sequentially**
— parallel requests trip the rolling window limiter.

Result: **49 of 67 reachable.** The 18 blocked ones fall into two clean groups:

*Plan-gated (premium tiers)*
```
google/gemini-3.1-flash-lite   MODEL_NOT_IN_PLAN: … Pro and above plans
google/gemini-3.5-flash(-lite) MODEL_NOT_IN_PLAN: … Pro and above plans
google/gemini-3.6-flash        MODEL_NOT_IN_PLAN: … Pro and above plans
google/gemini-3.7/3.8-flash    MODEL_NOT_IN_PLAN: … GOAT and above plans
meta/muse-spark-1.1/1.2/1.3   MODEL_NOT_IN_PLAN: … Pro/GOAT and above
xai/grok-4.6/4.7               MODEL_NOT_IN_PLAN: … GOAT and above plans
sakana/fugu-ultra              MODEL_NOT_IN_PLAN: … Provider and above plans
xiaomi/mimo-v2.6-pro-ultraspeed MODEL_NOT_IN_PLAN: … GOAT and above plans
```

*Retired (not plan-gated, just gone)*
```
inclusionai/ling-3.0-flash-free  "no longer available. Free model deal ended by August 3rd."
minimax/minimax-m2.7-free        "The free MiniMax M3 and M2.7 models have been retired."
minimax/minimax-m3-free          "…have been retired. Run /model and pick MiniMax…"
tencent/Hy3                      "The free Tencent Hy3 tier was retired on July 21, 2026."
```

That distinction matters: a retired model will *never* come back, while a
plan-gated one becomes available on upgrade. `catalog.reachability.json`
records the raw reason string so the difference survives.

The reachability file is **gitignored** — it describes one account's plan and
would leak which tier you are on.

### 5.3 Envelope extraction (static)

The network probe has a blind spot, and it is worth being precise about why.

Zod reports *required* fields by rejecting requests that omit them. It reports
nothing for fields you are allowed to omit. And the server **ignores unknown
keys** (proved: §5.4, negative control). So an optional field is, from the
network's point of view, indistinguishable from a field that doesn't exist.

You cannot discover optional fields by poking. You have to read them off the
client.

`scripts/extract-envelope.mjs` locates the route constant, finds the call site
that uses it, slices the `body:` object literal, and harvests its keys —
including computed keys like `mode: t.mode`, which still prove the field
exists:

```
top-level: config, memory, taste, skills, permissionMode, threadId, mode,
           promptCache, params{max_tokens, messages, model, reasoning_effort,
           stream, system, temperature, tools}
```

The `params` sub-object is harvested separately, so the bridge gets clean
dotted paths instead of a flattened mess.

### 5.4 Schema brute-forcing (network)

`scripts/probe-schema.mjs` reconstructs the contract from the server's own
validation errors. The server is unusually forthcoming:

```json
{"error":{"code":"BAD_REQUEST","status":400,
  "message":"… HINT: Validation error: Invalid input: expected string, received undefined at \"config.workingDir\"; Invalid input: expected array, received undefined at \"config.structure\"; …"}}
```

Every clause names a path *and* the expected shape. Five patterns cover
everything encountered:

| Clause | Meaning |
|---|---|
| `Invalid input: expected string, received undefined at "config.workingDir"` | typed field |
| `Invalid option: expected one of "agent"\|"learning"\|… at "mode"` | enum — **and the full option list** |
| `Invalid input: expected "off" at "promptCache"` | literal |
| `Invalid UUID at "threadId"` | uuid |
| `Invalid input: expected true at "params.stream"` | boolean literal |

**Algorithm: a repair loop.**

```
body = SEED                       # only params.model, so we can reach 200
repeat:
    res = POST(body)
    if res.status == 200: done
    for each validation clause in res:
        synthesise a valid value for that path
    # each iteration strictly increases satisfied constraints ⇒ terminates
```

This walks the entire tree with **no hardcoded field names**. A missing object
short-circuits the checks nested inside it, so satisfying it is what reveals
its children — the loop discovers siblings that were hidden on the previous
pass.

**A subtlety that cost real time.** Zod prints `"expected string, received
undefined"`. A non-greedy `expected (.+?) at "` matches `string, received
undefined` as the expected type and misreads the field as a literal. Order
matters:

```js
// the ", received X" form MUST be tested first
/^Invalid input: expected (\w+), received [^,]+ at "([^"]+)"/
// then the bare form
/^Invalid input: expected (.+?) at "([^"]+)"/
```

**A second subtlety.** Some clauses are prefixed `Validation error: ` and some
are not. Since the classifier anchors on `^`, the preamble must be stripped in
`clauses()`, not worked around per-pattern.

**Path notation.** Zod reports array elements in brackets —
`params.messages[0].role` — while the rest of the tooling uses dots. Everything
is canonicalised through `canonPath()`, which collapses every index to `.0`, so
an array's element schema is described once regardless of how many elements
were probed.

**Optional fields.** After the repair loop converges, candidates named by
§5.3 are each submitted with a hostile value; a complaint naming that path
confirms it exists and reveals its type or enum. The emitted `source` field
records which evidence each path has:

- `network` — required, found by rejection
- `network+cli-bundle` — optional, confirmed on the wire
- `cli-bundle` — named by the client, permissive over the network
- `unverified` — named by the client, but the server accepts anything

That last case is honest rather than convenient. §5.4's negative control proves
why: a *totally fictional* key returns `200`, so "no error" is not evidence of
existence. The prober records that control in the output
(`unknownKeysIgnoredEvidence: true`) rather than pretending silence means yes.

**Required vs optional** is settled empirically: submit a body that is
otherwise valid, delete one path, and see whether the server complains.

**Cost.** 304 requests, ~170 KB. Validation failures are rejected before
inference, so a full run costs **zero credits** — verified by snapshotting
`/alpha/billing/credits` before and after (identical to full float precision).

**Transient failures.** A 403/429/5xx mid-crawl is rate limiting, not a schema
fact. The first version treated any non-400 as "done" and silently truncated
discovery from 34 paths to 2. The crawler now retries with exponential backoff
plus jitter and treats only `200` as success.

### 5.5 Content-part union extraction (network)

`params.messages[].content` is a **union**: either a bare string, or an array of
typed parts. Send one malformed element and Zod prints *every failing branch of
the union* on a single line, separated by ` or `. That one error is a complete
inventory of the multimodal input format:

```
Invalid input: expected string, received array at "…content"
  or Invalid input: expected "text" at "…content[0].type"
  or Invalid input: expected "image" at "…content[0].type"
  or Invalid input: expected "document" at "…content[0].type"
  or Invalid input: expected "search_result" at "…content[0].type"
  or Invalid input: expected "thinking" at "…content[0].type"
  or Invalid input: expected "redacted_thinking" at "…content[0].type"
  or Invalid input: expected "reasoning" at "…content[0].type"
  or Invalid input: expected "tool_use" at "…content[0].type"
  or Invalid input: expected "tool-call" at "…content[0].type"
  or Invalid input: expected "tool_result" at "…content[0].type"
  or Invalid input: expected "server_tool_use" at "…content[0].type"
  or Invalid input: expected "web_search_tool_result" at "…content[0].type"
  or Invalid input: expected "web_fetch_tool_result" at "…content[0].type"
```

**14 part types**, recovered from one request. `scripts/probe-parts.mjs`
parses this into `parts.generated.json`. See §7 for the full breakdown.

---

## 6. The full discovered contract

Everything below was produced by the scripts. It is reproduced here so it can
be read without running anything.

### 6.1 Top-level fields (38 paths total)

| Path | Type | Required | Notes |
|---|---|---|---|
| `config` | object | **yes** | 9 required children |
| `config.workingDir` | string | **yes** | absolute path |
| `config.date` | string | **yes** | ISO 8601 |
| `config.environment` | string | **yes** | e.g. `darwin-arm64` |
| `config.structure` | array\<string\> | **yes** | |
| `config.isGitRepo` | boolean | **yes** | |
| `config.currentBranch` | string | **yes** | |
| `config.mainBranch` | string | **yes** | |
| `config.gitStatus` | string | **yes** | |
| `config.recentCommits` | array\<string\> | **yes** | |
| `memory` | string | **yes** | `null` is **rejected** |
| `taste` | string | no | nullable |
| `skills` | string | no | nullable |
| `permissionMode` | enum | no | see below |
| `threadId` | uuid | no | malformed UUID ⇒ hard 400 |
| `mode` | enum | no | see below |
| `promptCache` | literal | no | only `"off"` is valid |
| `params` | object | **yes** | |
| `params.model` | string | no | **omitting it triggers a 403** |
| `params.messages` | array | **yes** | union content, see §6.3 |
| `params.tools` | array | no | `{name, description, input_schema}` |
| `params.system` | string | no | |
| `params.max_tokens` | number | no | |
| `params.stream` | literal | no | only `true` is valid |
| `params.temperature` | number | no | |
| `params.reasoning_effort` | enum | no | see below |
| `params.messages.0` | object | — | message element |
| `params.messages.0.role` | enum | — | `user` \| `assistant` |
| `params.messages.0.content` | union | — | string \| array\<Part\> |
| `params.tools.0` | object | — | tool element |
| `config.structure.0` | string | — | |
| `config.recentCommits.0` | string | — | |

**Enums, in full:**

```
permissionMode        default | standard | auto-accept | plan | bypass
mode                  agent | learning | custom-agent | custom-agent-create
                      | title-gen | tool-desc | compact | vision
params.reasoning_effort   low | medium | high | xhigh | max
messages[].role       user | assistant
promptCache           "off"          (literal)
params.stream         true           (literal)
```

Two of these are the CLI's own internal values leaking into the wire format
(`mode: "title-gen"`, `mode: "compact"`), which is good evidence that this
endpoint is the CLI's private channel rather than a designed public API.

### 6.2 Header sensitivity

Discovered empirically, not assumed:

| Header condition | Result |
|---|---|
| `x-command-code-version` empty | `403 upgrade_required` |
| `x-command-code-version: 0.0.1` (stale) | `403 upgrade_required` |
| `x-cli-environment` empty | `200` (optional) |
| `User-Agent: cli` | accepted; not load-bearing |

So exactly one header is genuinely required beyond `Authorization`, and it must
match a minimum supported version.

### 6.3 Message content union

`content` is `string | Part[]`. Probing the array branch, the error for a
malformed part names `type` as a literal per branch. Per-type required fields
(recovered by drilling into each branch):

| Part type | Required fields | Modality |
|---|---|---|
| `text` | — | text |
| `image` | `image` (string), `source` (object) | **image** |
| `document` | `source` | **document / PDF** |
| `search_result` | `search_result` (object) | text |
| `thinking` | `thinking` (string) | text |
| `redacted_thinking` | `redacted_thinking` (string) | text |
| `reasoning` | — | text |
| `tool_use` | `id`, `name` | text + tool output |
| `tool-call` | `toolCallId`, `toolName` | text + tool output |
| `tool_result` | `content` | text + tool output |
| `server_tool_use` | `id`, `name` | text + tool output |
| `web_search_tool_result` | `content`, `tool_use_id` | text + tool output |
| `web_fetch_tool_result` | `content`, `tool_use_id` | text + tool output |
| `tool-result` | `toolCallId`, `toolName` | text + tool output |

Empirically, all four plausible image encodings are accepted and all four
deliver the pixels:

```
200  {type:image, image:"data:image/png;base64,…"}          → reads "42"
200  {type:image, image:"<raw base64>"}                     → reads "42"
200  {type:image, source:{type:"base64",media_type,data}}  → reads "42"
200  {type:image, image:"<raw base64>", source:{…}}         → reads "42"
```

The bridge uses the first form (data URL in `image`) — simplest, and matches
what the CLI's own `toWireMessages` emits.

---

## 7. Input modalities and dimensionality

The question "what can these models actually take as input?" has two distinct
answers, and conflating them is a common mistake.

### 7.1 What the *protocol* supports

From `parts.generated.json` — the union is fixed by the endpoint:

```
text · image · document (PDF)
```

There is **no** audio, video, or native spreadsheet part type. Anything else
(`search_result`, `thinking`, `tool_*`, `web_*`) is text-shaped plumbing.

If you need audio into a Command Code model, the honest answer is: the wire
format has no door for it.

### 7.2 What each *model* supports

From `catalog.json` — 30 of 49 reachable models accept images; 19 are
text-only:

| Model | Input | Context |
|---|---|---|
| `deepseek/deepseek-v4.1-flash` | text + image | 1,000,000 |
| `deepseek/deepseek-v4.1-flash-fast` | text + image | 1,000,000 |
| `deepseek/deepseek-v4-flash-vision-exp` | text + image | 1,000,000 |
| `deepseek/deepseek-v4-pro` | text | 1,000,000 |
| `deepseek/deepseek-v4-flash` | text | 1,000,000 |
| `deepseek/deepseek-v4-flash-fast` | text | 1,000,000 |
| `moonshotai/Kimi-K3` | text + image | 1,000,000 |
| `moonshotai/Kimi-K2.5` | text + image | 256,000 |
| `moonshotai/Kimi-K2.6` | text + image | 256,000 |
| `moonshotai/Kimi-K2.7-Code` | text + image | 256,000 |
| `moonshotai/Kimi-K2.7-Code-Highspeed` | text + image | 262,000 |
| `zai-org/GLM-5.3` | text | 1,000,000 |
| `zai-org/GLM-5.2` | text | 1,000,000 |
| `z-ai/glm-5.3-flash` | text + image | 1,048,576 |
| `z-ai/glm-5.3-flashx` | text + image | 1,000,000 |
| `xiaomi/mimo-v2.5` | text + image | 1,000,000 |
| `MiniMaxAI/MiniMax-M3` | text + image | 1,000,000 |
| `MiniMaxAI/MiniMax-M2.5` | text | 200,000 |
| `Qwen/Qwen3.8-Omni-Flash` | text + image | 1,000,000 |
| `Qwen/Qwen3.8-Max` | text + image | 1,000,000 |
| `Qwen/Qwen3.8-Flash` | text + image | 1,000,000 |
| `Qwen/Qwen3.8-27B` | text + image | 262,144 |
| `xai/grok-4.5` | text + image | 500,000 |
| `stepfun/Step-5-Preview` | text + image | 1,000,000 |
| `thinkingmachines/inkling` | text + image | 256,000 |
| `tencent/hy4-preview` | text | 1,048,576 |
| `stealth/space-bunny-alpha` | text + image | 1,000,000 |
| `sakana/fugu-ultra` | text + image | 1,000,000 |
| `poolside/laguna-s-2.1-free` | text + image | — |
| `meituan/LongCat-2.0` | text | 1,048,576 |
| `nvidia/nemotron-3-ultra-550b-a55b` | text | 1,000,000 |

**The naming heuristic is a trap.** `deepseek-v4-flash-vision-exp` is vision;
`deepseek-v4.1-flash` is *also* vision; `deepseek-v4-pro` is *not*. The version
number has nothing to do with capability. This is exactly why the package reads
`inputModalities` from the catalog instead of pattern-matching names — the
heuristic gets `deepseek-v4-pro` wrong, and would get
`MiniMax-M3` wrong too (vision, despite no "vision" in the name).

**Context windows are not round.** `262,144` and `262,000` and `256,000` are
three genuinely different numbers, and `200,000` for `MiniMax-M2.5` is real.
Guessing "everything is 128k or 1M" would be wrong for most of the list.

### 7.3 Four models with no declared window

```
MiniMaxAI/MiniMax-M2.7    Qwen/Qwen3.6-Max-Preview
Qwen/Qwen3.6-Plus         zai-org/GLM-5.1
```

The bundle genuinely omits `contextWindow` for these. Shipping `null` makes
OpenCode's context arithmetic `NaN`, so `build-catalog.mjs` substitutes a
conservative **128,000** — the smallest window any reachable model truly
supports — and records which entries were defaulted in
`catalog.contextWindowDefaulted` so the behaviour stays auditable.

### 7.4 What this means for routing

OpenCode reads `modalities.input` and will not send an image to a text-only
model. Because the installer and plugin both populate `modalities` from the
discovered catalog, image prompts route correctly **without any hand
configuration**. A model that says "I can't see any image" is a misconfigured
provider, not a provider limitation.

---

## 8. Runtime architecture

```
                    ┌──────────────────────────────────────┐
  OpenCode          │  src/bridge.js   (Node, no deps)     │
  (AI SDK ─────────▶│    GET  /health                      │
   openai-          │    GET  /v1/models                   │
   compatible)      │    GET  /__introspect                │
                    │    POST /v1/chat/completions         │
                    └───────────────┬──────────────────────┘
                                    │ NDJSON ⇄ SSE
                    ┌───────────────▼──────────────────────┐
                    │  api.commandcode.ai/alpha/generate   │
                    │  Authorization: Bearer user_…        │
                    │  x-command-code-version: <from CLI>   │
                    └──────────────────────────────────────┘
```

### 8.1 Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CMD_BRIDGE_PORT` | `8787` | listen port |
| `CMD_BRIDGE_HOST` | `127.0.0.1` | bind address — loopback by default, deliberately |
| `CMD_API_BASE` | `https://api.commandcode.ai` | upstream |
| `CMD_AUTH_PATH` | `~/.commandcode/auth.json` | credential file |
| `COMMAND_CODE_API_KEY` | — | credential override; wins over the file |
| `CMD_DEFAULT_CONTEXT` | `128000` | fallback context window |
| `CMD_DEBUG` | unset | verbose plugin logging |
| `CMD_LOG_FILE` | `/tmp/opencode-commandcode.log` | plugin log sink |
| `CMD_BRIDGE_NO_LISTEN` | unset | import as a library without binding a port |
| `CMD_WORKING_DIR` | `process.cwd()` | value for `config.workingDir` |

### 8.2 Credentials

Resolution order, cached for 60 s so a long agent session does not re-read the
file per request:

1. `COMMAND_CODE_API_KEY`
2. `~/.commandcode/auth.json` → `.apiKey`
3. throw with an actionable message

The key **never** appears in OpenCode's config. OpenCode is pointed at
`http://127.0.0.1:8787/v1` with a dummy `apiKey: "local-bridge"`, because that
token is a formality to the AI SDK — the real credential stays on the bridge,
bound to loopback. If a config file leaks, the Command Code key is not in it.

### 8.3 The `config` block

`config` is required and its nine children are all required, so the bridge
builds a genuine project description from the working directory using `git`:

```js
workingDir: dir,
date: new Date().toISOString(),
environment: `${os.platform()}-${os.arch()}`,
structure: [],                       // extensible; empty is valid
isGitRepo: <git rev-parse --is-inside-work-tree>,
currentBranch: <git rev-parse --abbrev-ref HEAD>,
mainBranch: <git rev-parse --abbrev-ref main>,
gitStatus: <git status --porcelain>,
recentCommits: <git log -5 --pretty="%h %s">,
```

Every `git` call is wrapped with a 2 s timeout and a silent failure fallback, so
a slow or absent git can never stall a chat turn. Emitting real project context
is also what makes the upstream behave like the CLI rather than a bare API
client.

---

## 9. The translation layer

`src/translate.js` is pure — no I/O, no globals, no process state. Everything
is directly unit-testable, and the bridge is a thin I/O shell over it.

### 9.1 OpenAI → wire

| OpenAI | wire |
|---|---|
| `role: "system"` / `"developer"` | hoisted into `params.system`, joined with `\n\n` |
| `role: "user"`, string content | `{role:"user",content:[{type:"text",text}]}` |
| `role:"user"`, `{type:"image_url",image_url:{url}}` | `{type:"image",image:<url>}` |
| `role:"user"`, `{type:"image",image}` (AI SDK) | `{type:"image",image:<url>}` |
| `role:"user"`, `{type:"file",mediaType,data}` | `{type:"document",source:{…}}` |
| `role:"assistant"`, text | `{type:"text",text}` |
| `role:"assistant"`, `reasoning_content` | `{type:"reasoning",text}` (preserved) |
| `role:"assistant"`, `tool_calls[]` | `{type:"tool-call",toolCallId,toolName,input}` |
| `role:"tool"` | `{role:"tool",content:[{type:"tool-result",toolCallId,toolName,output}]}` |

Both image spellings are accepted because clients genuinely differ: the
OpenAI chat-completions spec uses `image_url`, the Vercel AI SDK uses
`image`. Supporting only one is how a bridge silently loses images — a bug
caught here, see §16.4.

A `tool_call_id → tool name` map is built while scanning assistant messages so
that a following `role:"tool"` message can name the tool it answers, which the
wire's `tool-result` part requires.

Tools map `[{type:"function",function:{name,description,parameters}}]` →
`[{name, description, input_schema}]`, matching the CLI's own `toWireTools`.

### 9.2 wire → OpenAI

| wire event | OpenAI delta |
|---|---|
| `reasoning-delta` | `delta.reasoning_content` |
| `text-delta` | `delta.content` |
| `tool-call` | `delta.tool_calls[{index,id,type:"function",function:{name,arguments}}]` |
| `finish` | `choices[0].finish_reason` + a final `usage` chunk |
| `error` | error frame, then `[DONE]` |

Finish-reason mapping: `stop→stop`, `tool_calls`/`tool-calls`/`tool_use`
→`tool_calls`, `length`/`max_tokens`→`length`.

Usage mapping: `inputTokens/outputTokens/totalTokens` →
`prompt_tokens/completion_tokens/total_tokens`, with
`outputTokenDetails.reasoningTokens` → `completion_tokens_details.reasoning_tokens`.

**Usage is always emitted for streams.** An early version honoured
`stream_options.include_usage`, and the Vercel AI SDK — which OpenCode uses —
never sets that flag. Result: every streaming call reported `{}` for usage and
OpenCode's cost display silently read zero. The flag is now ignored and the
chunk is always sent; an extra usage-only chunk is harmless to clients that
don't want it.

---

## 10. Error handling and self-healing

### 10.1 Status mapping

| Upstream | Mapped `error.type` |
|---|---|
| 401 | `authentication_error` |
| 403 | `permission_error` |
| 429 | `rate_limit_error` |
| 4xx other | `invalid_request_error` |
| 5xx | `server_error` |

The upstream's own `error.code` (`MODEL_NOT_IN_PLAN`, `upgrade_required`,
`FORBIDDEN`) is preserved in `error.code`, so a caller can distinguish
"not in my plan" from "your CLI is too old" from "rate limited".

### 10.2 Abort handling

```js
res.on("close", () => { if (!res.writableFinished) ac.abort() })
```

**This must be on the response, not the request.** `req` emits `close` as soon
as the request body is fully consumed — which is immediately, because the body
is read in full before the upstream call. Binding to `req` aborts the upstream
request instantly and every single request fails with
`"Upstream connection failed: This operation was aborted"`. See §16.1.

### 10.3 Mid-stream errors

A `{"type":"error"}` event after headers are sent cannot become an HTTP error
status. The bridge emits a `finish_reason:"error"` chunk, then an OpenAI error
frame, then `[DONE]` — so a client sees a clean stream termination with a
readable reason rather than a truncated body.

### 10.4 Startup failures

A bind failure must be legible, not an unhandled `'error'` event. The bridge
handles the three cases that actually occur:

| Condition | Behaviour | Exit |
|---|---|---|
| Port held by a *healthy* bridge | "already running", stand down | `0` |
| Port held by a hung / foreign process | print `lsof` recovery commands and a `CMD_BRIDGE_PORT` alternative | `1` |
| `EACCES` (privileged port) | suggest a port above 1024 | `1` |
| Anything else | print the message | `1` |

Exiting `0` on the duplicate case matters: the supervisor's health poll will
find the live instance, and a non-zero exit there would look like a crash.

A hung instance is the case that motivated this. A previous bridge held 8787
without answering `/health`, and a duplicate start produced a bare
`EADDRINUSE` stack trace with no recovery path.

`process.on("unhandledRejection")` also logs instead of terminating, so one bad
request cannot silently kill a long-running bridge.

### 10.5 Self-healing

The bridge is a child process the plugin owns:

- Started eagerly on plugin init, and lazily again if `/health` stops
  answering.
- Restart cooldown of **10 s**, so a slow start cannot become a respawn loop.
- Health check has a 1.5 s timeout; the wait loop allows ~6 s to bind.
- If `src/bridge.js` is missing, the plugin logs once and disables itself
  rather than throwing on every event.

`doctor` reports the specific broken link: no key, no Node, port occupied,
stale catalog, or upstream unreachable.

---

## 10.6 Port resilience

A hardcoded port is a single point of failure. If anything else on the machine
holds 8787, the bridge simply cannot start, and the "fix" is a manual
`lsof` / `kill` / edit-config ritual. That is not acceptable for a package
someone installs with one command.

### Selection

`src/port.js` scans upward from the preferred port and binds the first free
one:

```
8787 free          -> 8787   strategy: "preferred"
8787 taken         -> 8788   strategy: "scanned"
8787-8786 taken    -> ephemeral from the OS   strategy: "ephemeral"
```

Free-ness is proven by actually attempting a bind, not by reading `/proc` or
trusting a heuristic.

### Discovery — the part that actually matters

An auto-selected port is useless if nothing else knows about it. The bridge
writes it to `~/.commandcode-bridge/state.json`:

```json
{ "port": 8789, "host": "127.0.0.1", "pid": 97975, "startedAt": "…" }
```

and everything else asks rather than assumes:

| Consumer | How it finds the port |
|---|---|
| CLI (`status`, `doctor`, `models`) | `discoverPort()` |
| Installer (writes `baseURL` into `opencode.json`) | `discoverPort()` |
| Plugin (builds `baseURL`) | `discoverPort()` |
| Test suite | `discoverPort()` + `syncPort()` |

`discoverPort()` resolution order:

1. `CMD_BRIDGE_PORT`, if the user pinned one
2. the state file, **if the recorded pid is alive and the port answers**
3. a scan upward from the default

A state file left by a crashed bridge is detected as stale (dead pid, or a port
that does not answer) and deleted rather than trusted. Otherwise a stale file
would send every client to a port nobody is listening on — a failure that
looks exactly like "the bridge died".

`SIGINT`/`SIGTERM`/`exit` all clear the state file, so a normal stop never
leaves a trap behind.

### The port must not drift — and for a while it did

Auto-selecting a port introduces a second source of truth. The port lives in a
runtime decision; the `baseURL` OpenCode reads lives in a static file. Those
drift apart the moment the bridge restarts elsewhere.

This was a real defect, found by testing rather than reasoning:

```
$ lsof -ti:8787 | xargs kill -9     # a foreign process takes 8787
$ opencode-cc-go start
opencode-commandcode-go bridge on http://127.0.0.1:8788  [port 8788 chosen: scanned]
                                          # …and nothing else happened

$ opencode run -m commandcode/deepseek/deepseek-v4.1-flash "say OK"
Error: ConnectionRefused: Unable to connect.
```

`opencode.json` still said `8787`. The installer had written that once, at
install time, and nothing ever revisited it. The bridge had moved; nothing
else had.

#### The fix: correct the drift where it is created

The bridge knows its own port the instant it binds, so it is the only component
positioned to fix this. `src/config-sync.js` runs immediately after `listen()`
and rewrites the config if — and only if — the URL actually changed.

```
opencode-commandcode-go bridge on http://127.0.0.1:8788  (49 models, cli 1.69.0)
  opencode.json baseURL updated: http://127.0.0.1:8787/v1 -> http://127.0.0.1:8788/v1
  restart OpenCode to pick up the new port.
```

`opencode run` then works immediately, with no manual step.

#### Safety properties

Writing to a user's editor config deserves more care than a `fs.writeFile`:

| Property | How |
|---|---|
| Atomic | write a temp file beside the target, then `rename()` over it — a crash mid-write cannot truncate a config |
| Surgical | only `provider.commandcode.options.baseURL` is assigned; every other provider, model and key is preserved |
| Refuses to guess | a config that is not valid JSON is reported and left byte-for-byte alone |
| Backs up first | `<config>.bak`, written once, before the first mutation |
| Idempotent | already-correct is a no-op, so the common path touches nothing |
| Opt-out | `CMD_NO_CONFIG_SYNC=1` for users who manage `opencode.json` from a dotfile repo |
| Non-creating | if no config exists, none is written |

Verified with an automated test that corrupts a config by hand:

```
$ opencode-cc-go status
  opencode.json OUT OF SYNC  config points at http://127.0.0.1:9999/v1 but the bridge is on http://127.0.0.1:8788/v1

$ opencode-cc-go doctor ; echo $?
config points at http://127.0.0.1:9999/v1 but the bridge is on http://127.0.0.1:8788/v1
Fix it with:  opencode-cc-go sync
1

$ opencode-cc-go sync
updated /Users/hareeshkarravi/.config/opencode/opencode.json
  http://127.0.0.1:9999/v1 -> http://127.0.0.1:8788/v1

$ opencode-cc-go doctor ; echo $?
all good
0
```

After the repair, the 4 other providers, 49 models and 39 agent definitions in
the user's config were all still present.

#### Defence in depth

Self-healing covers the common case. Two more layers catch the rest:

- **`/health` reports drift** (`config.inSync`, `config.note`), so any client
  can ask.
- **`doctor` fails loudly** with a non-zero exit and the exact fix command,
  rather than letting a connection error be the first symptom.
- **`opencode-cc-go sync`** is the one-shot repair, for cases the bridge cannot
  self-heal: a hand-edited config, or a dotfile manager that reverted it.

#### The one limit, stated plainly

**OpenCode reads its config once, at startup.** If the bridge changes port
while OpenCode is already running, the running instance keeps the old URL until
it restarts. The bridge says so explicitly rather than letting it surface as a
mystery:

```
  opencode.json baseURL updated: ... -> ...
  restart OpenCode to pick up the new port.
```

This is an OpenCode architecture constraint, not something this package can
engineer around. The plugin path has no such window — it resolves the live port
during OpenCode's own startup, so the URL is correct before any request is made —
but it is the *secondary* path (§11.1.5). Provider registration lives in
`opencode.json`, which is why the installer-plus-self-heal design exists and why
a port change heals without a plugin being involved at all.

#### A model entry's `reasoning` key is not top-level on v2

The installer originally wrote reasoning models as:

```json
{ "reasoning": true, "options": { "reasoningEffort": "high" } }
```

v2 treats a top-level `reasoning` as a v1 leftover and **silently drops it**:

```
configuration normalization diagnostic
  path=$.provider.commandcode.models.deepseek/deepseek-v4.1-flash.reasoning
  kind=unsupported action="omitted unsupported legacy setting"
```

The correct shape puts it inside `options`:

```json
{ "options": { "reasoning": true, "reasoningEffort": "high" } }
```

This produced 75 warnings on a 49-model catalog and zero functional change —
reasoning was never actually enabled. It is the same class of bug as the missing
`parameters` in §14: the config parses, the request succeeds, and only a log
line reveals that a setting was discarded. The check that catches it is to grep
the server log for `normalization diagnostic` after installing; `opencode-cc-go
doctor` now does this. (Three pre-existing warnings on the `meta` provider were
found the same way and are not this package's to fix.)

#### Why not just pin the port?

Because a pinned port means a package installed with one command cannot start
if anything else on the machine already holds it, and the "fix" becomes a manual
`lsof`/`kill` ritual. Auto-selection is the right behaviour; the config simply
has to follow it. Note the asymmetry that makes this cheap in practice: the
port only changes when the bridge *restarts*, and the common case — nothing
else on 8787 — never changes at all, so the sync path is a no-op.

#### Verified

With a foreign process squatting on 8787 for the whole run:

```
$ opencode-cc-go start
opencode-commandcode-go bridge on http://127.0.0.1:8789  (49 models, cli 1.69.0)
                                                       [port 8789 chosen: scanned]

$ opencode-cc-go install
installed provider 'commandcode' … 49 models registered
  → opencode.json baseURL: http://127.0.0.1:8789/v1

$ npm test
38 passed, 0 failed, 0 skipped
```

Everything followed the port. No manual step, no config edit.

### A trap worth naming

A squatter that accepts TCP but never speaks HTTP looks exactly like a dead
bridge to any client. The first version of the test harness probed the
*default* port before resolving the real one, so it "found" the squatter,
concluded the bridge was down, and tried to spawn a second one. The symptom was
an opaque `setTypeOfService EINVAL` from undici.

Order matters: **discover, then probe.** Any component that checks liveness
must resolve the port first, or it will cheerfully talk to whatever else the
machine is running.

## 10.7 Health must not block on the network

`/health` is polled by the CLI, the plugin, the installer and the test suite.
The first implementation did two upstream round-trips inline, which took ~3.2 s
on a cold cache. Every caller with a short timeout concluded the bridge was
dead — while `curl` against the same endpoint succeeded.

Measured directly:

```
cold /health   3.197s     -> callers time out, report "unreachable"
warm /health   0.017s
```

Now:

- upstream status is fetched at most once per 30 s and cached
- a cold cache answers **immediately** from local state and kicks the fetch off
  in the background
- `?deep=1` forces a synchronous fresh check for callers that genuinely want one

```
cold /health   0.041s
warm /health   0.017s
```

`/health` now also reports `baseURL` and `port`, so a client can confirm it is
talking to the bridge it thinks it is.

## 10.8 Running the bridge as a service

A bridge that dies with the terminal is not finished. On macOS the package
ships a launchd agent:

```
npm run service          # install + start
npm run service:status   # is it loaded, what pid
npm run service:remove   # unload + delete
```

`scripts/launchd.plist.template` is the agent, parameterised with the repo path
and `HOME`. Two details in it are deliberate:

- **`KeepAlive` uses `SuccessfulExit: false`.** The bridge exits `0` when it
  discovers a healthy instance already holding the port. Restarting on that
  would be a respawn loop: A notices B, B is killed, A restarts, and so on.
  Restarting only on a *crash* keeps the supervisor honest.
- **`HOME` is set explicitly.** launchd hands agents a nearly empty
  environment. The bridge reads `~/.commandcode/auth.json`, so relying on
  `os.homedir()` falling back to the password database is a needless risk.

Verified: `kill -9` on the supervised pid produced a new pid within ~8 s and a
healthy `/health` immediately after.

## 11. OpenCode integration

### 11.1 Plugin loading: what actually happens (corrected)

**This section previously claimed that plugins "do not initialise" on v2.0.19.
That was wrong, and the reasoning behind it was the mistake.**

The earlier version concluded the plugin loader never ran, because a probe
plugin exported a bare `async function` and nothing appeared to happen. The
correct conclusion was available at the time: the probe *was* loaded and *was*
rejected. Nothing surfaces that rejection unless you read the server log.

The log is at `~/.local/share/opencode/log/opencode.log` and every failure is
recorded with a reference id:

```
$ grep "failed to load plugin" ~/.local/share/opencode/log/opencode.log | tail -1
... message="failed to load plugin" target=opencode-commandcode-go ref=err_268d84de \
    cause="Cause([Fail(NpmInstallFailedError (cause: q_: 404 Not Found -
    GET https://registry.npmjs.org/opencode-commandcode-go - Not found))])"
```

That reference is what a UI `Reference: err_...` points at. It is always
resolvable — do not infer a cause from the reference alone.

#### 11.1.1 The v2 module shape

OpenCode v2 requires the default export to be an **object** with an `id` and a
`setup` (or `effect`) function:

```js
export default { id: "...", async setup(ctx) { ... } }
```

Exporting a bare function — the shape of the v1 `Plugin` type — fails with:

```
PluginModule.LoadError: Plugin must export a default definition with an id and
an effect or setup function. (cause: SchemaError(Expected object at ["default"]))
```

The three plugins already working in a stock config (`rtk`, `skillful`,
`subagent-delegate`) are the reference implementation. Match them.

#### 11.1.2 How a plugin gets referenced — and why a bare name 404s

Two distinct mechanisms; mixing them up is easy:

| Form | Mechanism | Notes |
|---|---|---|
| File in `~/.config/opencode/plugins/*.js` | auto-discovery | Simplest, most reliable |
| Directory path in the `plugins` config array | file spec | resolves `package.json` `main` |
| Bare npm name in the `plugins` array | **registry lookup** | 404s while unpublished |
| File path in the `plugins` array | rejected | `configured plugin path must be a directory` |

A `node_modules` symlink does **not** satisfy a bare name: the loader goes to
`registry.npmjs.org` regardless of local presence. Until the package is
published, use auto-discovery from `plugins/`.

#### 11.1.3 Module caching — why a correct fix appears not to work

Plugin modules are imported **once per server process** and cached by resolved
path. Editing `plugin.js` while a server is running changes nothing: the old
module stays in memory, the identical error is logged, and the fix looks wrong.

This cost the most time here. Two symptoms, one cause:

- the fix verified correct by importing the module in a fresh Node process,
- and the error persisted verbatim, same `SchemaError`.

A symlink makes it worse: the cache key is the *realpath*, so a stale entry
survives edits and reinstalls. **Restart the OpenCode server after any plugin
edit.** The desktop app respawns it, so changes land on the next respawn.

#### 11.1.4 Registering a tool — four mistakes that all log "success"

Each registered without error while being wrong. None is detectable except by
asserting on the observable result.

1. **There is no `ctx.tool.register`.** Assigning onto `ctx.tool` does nothing.
   The v2 API registers through a draft editor:

   ```js
   await ctx.tool.transform((editor) => {
     editor.add({ name, description, input, execute })
   })
   ```

2. **`input` is a JSON Schema**, not the v1 `args` shorthand
   (`{ detail: { type: "string", optional: true } }`).

3. **Registration must happen before the first `await` in `setup`.** The tool
   catalog is built from registrations made while `setup` still runs
   synchronously. A transform registered *after* a multi-second bridge probe
   resolved fine, logged `registered commandcode_status tool`, and the tool was
   absent from a catalog of 60. Register first; do slow work after.

4. **`execute` must return `{ content: string }`.** A bare string registers the
   tool, then fails at call time:

   ```
   a is not an Object. (evaluating '"output"in a')
   ```

All four passed a "setup did not throw" check. The only reliable test is that
the tool appears in an agent's tool list *and* that calling it returns content.

#### 11.1.5 Teardown: the dispose contract

The v2 loader runs whatever `setup` returns as its dispose callback. From the
decompiled loader:

```js
// PluginModule.load -> the promise adapter
yield*Mt(
  ie(() => Promise.resolve(e.setup(de))),        // run setup
  (re) => re ? ie(() => Promise.resolve(re())) : D  // run the returned fn on teardown
)
```

So `setup` returning a function is not a convention, it is the contract. It is
invoked when the plugin scope closes — on server shutdown, and on reload, where
the old scope is closed before the new one is built:

```ts
Plugin.disable("x") -> close plugin scope -> ... -> Reload.all()
```

This is the only supported way to release something a plugin started. Without
it, a bridge started in a sandbox outlives the session and holds a loopback
port with nothing left to reap it.

The rule that makes it safe to use:

> A bridge is stopped **if and only if** this process started it.

`stop()` refuses to touch a bridge whose pid was never recorded as ours, so a
launchd agent or a bridge the user started in a terminal is never killed by
plugin teardown. Ownership lives in `src/lifecycle.js` and is set in exactly one
place — `start()`.

#### 11.1.6 Cloud, containers, CI

These differ from a desktop in three ways that all break naive assumptions:

| | desktop | sandbox |
|---|---|---|
| `~/.commandcode/auth.json` | present | **absent** |
| `~/.config/opencode` | persistent | thrown away |
| supervision | launchd / systemd | **none** |

`detectEnvironment()` in `src/lifecycle.js` classifies by *capability*, not by
product name — every check is something testable:

- credentials: `COMMAND_CODE_API_KEY`, else `~/.commandcode/auth.json`
- persistent config: can `$HOME` be written to
- supervision: `CMD_BRIDGE_SUPERVISED`

`process.env` is corroboration only, never the sole basis for a decision, so a
stale variable in a shell profile cannot change behaviour. `CI`,
`OPENCODE_CLOUD`, and a missing/unwritable home are additional signals.

Consequences in the plugin:

1. **No credentials → register nothing.** The Go plan has no public API, so a
   provider entry with no key can never answer. The plugin logs why and leaves
   the catalog alone, instead of offering a `commandcode/...` model that always
   fails.
2. **Never detach in a sandbox.** A detached child outlives its parent. In
   cloud the bridge is a tracked, non-detached child so plugin teardown can reap
   it.
3. **Do not repair config that is about to be deleted.** Drift is reported and
   left alone when the config is not writable.

**One credential can never be the whole story.** Because the plan has no
provider API, the sandbox needs the user's key. That is a genuine constraint of
this package, not an oversight, and it is why the plugin degrades to "explains
itself" rather than pretending to work.

#### 11.1.7 What the plugin is actually for

Provider registration stays in `opencode.json`. It is deterministic,
inspectable, version-independent, and survives any loader change. The plugin
handles what config cannot: noticing the bridge is down, reporting
plan/credits/schema/drift on demand, and keeping the provider `baseURL` pointed
at the live port.

#### 11.1.8 Three bugs the lifecycle tests found in our own code

Recorded because all three were invisible in normal use, and two were found
only by asserting on an observable property rather than on a return value.

**Every machine was classified as an ephemeral sandbox.** The writability probe
wrote into `~/.commandcode-go-probe/probe` without ever creating that directory,
so the write always threw, `configWritable` was always `false`, and therefore
`kind` was always `"cloud"`. Nothing errored — the answer was just always wrong.
On a real desktop it silently cost us the ability to detach and the config-drift
repair.

This one is worth dwelling on, because it was found by *reading the plugin's
log on a live machine* ("environment: cloud" on a Mac that was plainly not a
sandbox) and not by any test. The test that would have caught it asserts against
the real filesystem rather than a stub, precisely so this class of bug cannot
hide behind a mock again. A probe that is only ever run against injected values
is not testing the probe.

**`stop()` escalated to `SIGKILL` every time.** It polled `child.exitCode`
behind `Atomics.wait`, which blocks the event loop — so Node never delivered the
`'exit'` event, the "still running?" check always said yes, and every stop ended
in `SIGKILL`. The visible symptom was `escalated: true` on a clean shutdown. The
consequence was worse than a noisy log: `SIGKILL` cannot be trapped, so the
bridge never ran its own exit handler, `clearState()` never ran, and the state
file was left behind describing a dead pid — manufacturing the exact stale-state
condition the code exists to prevent. Fixed by making `stop()` async and racing
the `'exit'` event against a grace timer.

**Readiness could adopt a stranger's bridge.** After spawning, the code polled
`discoverPort()`, which returns *any* healthy bridge on the machine. With a
second bridge already running — the normal case on a supervised machine — a
freshly spawned child was declared healthy because of the *other* one, and the
caller took ownership of a process it never started, later killing a bridge it
had no business touching. `observeChild()` now requires the state file to name a
live process that is the spawned child or a descendant of it.

That last one is the more interesting class: a liveness check that answers a
different question than the one being asked. "Is a bridge healthy?" and "is *my*
bridge healthy?" are not the same question, and the code was silently asking the
first while meaning the second.

### 11.2 The plan gate — who this is for

Command Code's own words: *"Every plan except the Go plan has API access."*

That means this package is **only** useful to one tier. Everyone else already
has a supported API, and installing a bridge would add a moving part for no
benefit. So the plan is detected and users who do not need this are stopped
before anything is written.

`src/plan.js` is deliberately a standalone, side-effect-free module. Two very
different entry points need it — a long-running server and a short-lived CLI —
and importing the server from the CLI would bind a port and then `process.exit`
on `EADDRINUSE`. (That actually happened during development.)

| planId | `needsBridge` | Behaviour |
|---|---|---|
| `individual-go-v1` | `true` | proceed |
| `individual-provider` | `false` | refuse, print the direct-config snippet |
| `individual-pro-v1` | `false` | refuse |
| `individual-max` | `false` | refuse |
| `individual-ultra` | `false` | refuse |
| `individual-goat` | `false` | refuse |
| `teams-pro` | `false` | refuse |
| anything unrecognised | `null` | **proceed** — an unknown new tier might be the Go plan |

An unrecognised plan deliberately does *not* block. Guessing "this must be a Pro
user, refuse" would lock out a legitimately new Go tier on launch day.

`opencode-cc-go install` on an API-enabled plan:

```
  You are on the 'individual-provider' plan, which already includes API access.

  This package is only for the $1 Go plan, which has no Provider API.
  You do not need it. Point OpenCode at the API directly instead:

    "provider": { "commandcode": { "npm": "@ai-sdk/openai-compatible", … } }
  …
  Install this package anyway with --force if you specifically want the bridge.
```

`--force` overrides. `opencode-cc-go status` always shows the plan line, so the
answer is visible without reading the docs.

### 11.3 Auth is required

OpenCode will not consider a custom provider usable without a credential —
either inline in `options.apiKey` or in `opencode auth`. The installer writes
`apiKey: "local-bridge"`, which satisfies that check. The real Command Code key
is never given to OpenCode. Without any value here, models appear in
`opencode models` but fail at call time with *"Model unavailable"*.

### 11.4 `commandcode_status` tool

Registered by the plugin, callable by the agent. Reports bridge health,
upstream reachability, account, CLI version, catalog size, discovered schema
path count, vision-model count, and the supported input modalities. With
`detail: "full"` it dumps every discovered field with type, enum values and
required/optional status — which is the fastest way to answer "why won't this
model work".

---

## 12. Testing

```bash
npm test                    # 51 live checks + 68 lifecycle checks
npm test -- --offline       # 27 structural + all 61 lifecycle, zero requests, zero credit
npm test -- --model <id>    # override the model under test
node test/lifecycle.mjs     # the lifecycle suite alone; also free
```

**Current status: 51 live + 68 lifecycle passed, 0 failed.**

The suite is split in two on purpose.

**`test/run-all.mjs` — the live half.** Needs a real account and makes real
requests, so it is where transport fidelity is proven: streaming, non-streaming,
multi-turn memory, tool-argument round-tripping, the full agent loop, real
vision on a real generated PNG, and token accounting.

**`test/lifecycle.mjs` — the offline half.** Starts and kills *real processes* on
*real ports* but never calls the API, so it costs nothing and is safe on every
change. It is a separate file because it binds ports and manipulates process
state; interleaving that with in-flight requests makes any failure ambiguous.

Two isolation details make the offline half safe to run against a live desktop
setup, which is the situation it was actually written in:

- `CMD_BRIDGE_STATE_DIR` points at a temp dir, so state assertions cannot delete
  the real bridge's state file.
- `start()` takes a `preflightPortModule` seam. A stub reporting "nothing
  running" forces a genuine spawn instead of adopting the launchd-managed bridge
  on 8787, while the post-spawn readiness check still uses the real port module.

The lesson from writing it: **a test that runs on the same machine as the thing
under test must be explicit about which world it is in.** The first version
silently adopted the user's own bridge and "passed" while testing nothing.

### 12.1 What the live half covers

| Group | Checks |
|---|---|
| 0a. ports | a free port is found; **an occupied port is skipped**; `isServing()` finds live and rejects dead; the state file records the bound port |
| 0a. plans | Go ⇒ needs the bridge; Provider/Pro/Max/GOAT/Teams ⇒ told they do not; unknown ⇒ not guessed |
| 0b. artifacts | catalog/schema/parts present; 9 required `config` fields present; every context window numeric; vision/text-only split is non-trivial; health reports its own `baseURL`; default `/health` responds in <1 s |
| 1. bridge | healthy; upstream reachable |
| 2. models | `/v1/models` list; test model advertised; every `context_length` numeric |
| 3. text | non-streaming 200 + content + usage; streaming content + `finish_reason` + usage |
| 4. multi-turn | memory survives translation (plant `7391`, ask for it back) |
| 5. tools | tool call emitted; **arguments round-trip exactly**; `finish_reason=tool_calls`; full agent loop consumes the tool result |
| 6. vision | reads `42`, reads `green`, reads `red` from a real PNG |
| 8. lifecycle | the 68 checks in §12.3, run in both live and `--offline` modes |
| 7. errors | missing model → 400 `invalid_request_error`; unknown route → 404 |

### 12.2 The vision fixture

`test/fixtures/test-image.png` is **generated from scratch**, not a stock photo,
by `test/make-fixture-image.mjs` — a dependency-free PNG encoder (zlib +
hand-rolled CRC32) drawing a white card on a green field, the number **42** in
blocky seven-segment digits, and a red square.

```
ground truth:  number = 42   background = green   right shape = red
```

Generated content matters here. A stock photo would pass or fail for reasons
unrelated to the bridge. A synthetic image with three independently checkable
facts turns vision into a real assertion — and it caught a genuine bug: the
first glyph rendering produced `12`, and **every vision model correctly read
`12`**. The models were right; the fixture was wrong. That is exactly the
signal you want from a test with known ground truth.

Regenerate with `npm run fixture`.

### 12.3 What the lifecycle half covers

68 checks over six groups. The organising question is one property: **a bridge
is stopped if and only if we started it.** Everything else serves that, or
serves "never leak a process or a port".

| Group | Checks |
|---|---|
| 1. environment | 10-way classification matrix (desktop / launchd-supervised / ephemeral home / CI / `OPENCODE_CLOUD` / no creds / missing home); cloud never allows a detached daemon; classification is idempotent |
| 2. ownership | `stop()` with nothing owned is a no-op; `start()` **adopts** an already-serving bridge and does not claim it; missing bridge file refused; a child that exits immediately is reported, not half-registered; a timed-out start leaves no orphan; a `SIGTERM`-ignoring child is escalated to `SIGKILL` |
| 3. real bridge | starts on a chosen free port; reports `started: true`; ownership recorded; `/health` answers; a **second start adopts rather than forks**; `stop()` succeeds; **port is released**; ownership cleared; a second `stop()` is a no-op |
| 4. crash recovery | state records a dead pid; liveness is detectable via signal 0; `clearState()` removes the file; a live bridge publishes pid **and** port; a `SIGKILL`ed bridge is really gone; **stale state survives `SIGKILL`** and does not lie about liveness; the port is free anyway; a new bridge starts despite the stale file |
| 5. foreign port | a squatter on the requested port makes the bridge scan to the next one; **the squatter is left untouched** |
| 6. plugin contract | default export is an object with `id` + `setup`; **`setup` returns a dispose function**; tool registered; `input` is a JSON Schema with `additionalProperties: false`; `execute` returns `{ content: string }`; `detail:"full"` dumps the schema; no session hook registered with a bogus signature; **`dispose` is safe with nothing owned and is idempotent** |

Group 4 deserves a note. `SIGKILL` cannot be trapped, so a hard-killed bridge
cannot clear its own state file. That is precisely why the state file records a
**pid**, and why every consumer checks liveness rather than trusting the file's
existence. It is a real, reproducible failure mode — not a hypothetical.

Group 5 uses a TCP listener that accepts connections and never speaks HTTP. The
bridge's own `canBind` must treat it as occupied, and the test then verifies the
squatter is still reachable afterwards, i.e. nothing bound over it.

The suite removes every process, port, state directory, and temp directory it
creates — including after a failure, so a red run still leaves the machine as it
found it.

### 12.4 Model choice

Tests use **flash-tier** models (`deepseek-v4.1-flash` by default). Pro and
K3-class models cost materially more on a credit-metered plan and buy nothing
for transport testing — the bridge's job is to move bytes faithfully, not to be
smart. Override with `--model` if you want to verify a specific model.

### 12.5 Test-harness pitfalls worth knowing

**The AI SDK can strip tool schemas.** In `@ai-sdk/openai-compatible@2.0.80`
with `ai@6.0.296`, a tool's `parameters` can arrive at the bridge as
`{type:"object",properties:{},additionalProperties:false}` — the properties are
gone, so the model correctly calls with `{}`. This is an SDK-side conversion
quirk, **not** a bridge bug. Proof: the same request issued directly over `curl`
returns `{"city":"Paris"}` intact. The suite therefore tests tool arguments
over raw HTTP rather than through the SDK.

Consequence for debugging: if a model "ignores" a tool argument, check what the
bridge actually received (`CMD_DEBUG=1`, or the `commandcode_status` tool)
before suspecting the model.

**Reasoning models can exhaust the budget before answering.** `deepseek-v4.1-flash`
spends most of its output budget thinking. With `max_tokens: 200` a vision
question returns `content: null`, `finish_reason: "length"`, and 200 reasoning
tokens — which looks exactly like "the image did not arrive". The vision test
uses **1200** tokens. When debugging an apparently-empty reply, check
`finish_reason` and `usage.completion_tokens_details.reasoning_tokens` first.

**A stale bridge process lies.** Several confusing failures were traced to an
old `node src/bridge.js` still holding port 8787 while a patched version was
edited on disk. After any change to `src/`, restart the process:

```bash
pkill -f "opencode-commandcode/src/bridge"; lsof -ti:8787 | xargs kill -9
```

---

## 13. Every script, every parameter

### 13.1 `scripts/extract-catalog.mjs`

```
node scripts/extract-catalog.mjs [path/to/cli.mjs]
```

- Positional `[path]` — CLI bundle to parse. Default:
  `~/.local/lib/node_modules/command-code/dist/cli.mjs`
- Writes JSON to **stdout**; a one-line count goes to stderr.
- No network, no key, ~200 ms.

### 13.2 `scripts/build-catalog.mjs`

```
node scripts/build-catalog.mjs [--probe]
```

| Flag | Effect |
|---|---|
| `--probe` | Re-probe all models live before merging. Sequential; spends a small amount of credit. |

- Reads `catalog.extracted.json`, optionally writes `catalog.reachability.json`,
  always writes `catalog.json`.
- Without `--probe`, uses the cached reachability file.
- With **no** reachability file at all, falls back to shipping the full static
  list so the bridge still works offline — clearly labelled in the output as
  `reachabilitySource: "none (offline fallback: full static list)"`.

### 13.3 `scripts/extract-envelope.mjs`

```
node scripts/extract-envelope.mjs [--out <path>] [--json-only] [path/to/cli.mjs]
```

| Flag | Default | Effect |
|---|---|---|
| `--out <path>` | `envelope.generated.json` | Output file, guarded by `safe-io.mjs` |
| `--json-only` | off | Suppress progress on stderr |
| positional `[path]` | installed `cli.mjs` | Bundle to parse |

Exits 2 if the bundle is missing, 3 if the route constant cannot be found —
which is the signal that Command Code restructured their client.

### 13.4 `scripts/probe-schema.mjs`

```
node scripts/probe-schema.mjs [--out <path>] [--json-only]
```

| Flag | Default | Effect |
|---|---|---|
| `--out <path>` | `schema.generated.json` | Output file (guarded) |
| `--json-only` | off | JSON on stdout only |

Environment: `CMD_API_BASE`, `COMMAND_CODE_API_KEY`, `CMD_AUTH_PATH`.

Phases: repair loop → array-element drilling → optional-field confirmation →
leaf classification → required/optional resolution → unknown-key negative
control → header-sensitivity probe. ~300 requests, **0 credits**, ~2 min with
backoff.

### 13.5 `scripts/probe-parts.mjs`

```
node scripts/probe-parts.mjs [--out <path>] [--json-only]
```

One request. Triggers the union dump and parses it into
`parts.generated.json`. Reports 14 part types and the overall modality set.

### 13.6 `scripts/install.js`

```
node scripts/install.js [--config <path>] [--remove] [--dry-run] [--print]
```

| Flag | Effect |
|---|---|
| `--config <path>` | Target config. Default `OPENCODE_CONFIG` or `~/.config/opencode/opencode.json` |
| `--remove` | Delete the `commandcode` provider |
| `--dry-run` | Report the change, write nothing |
| `--print` | Print the provider block as JSON and exit |

Idempotent: re-running updates the model list in place. Refuses to write if the
file is not valid JSON rather than clobbering it.

### 13.7 `bin/opencode-commandcode.js`

| Command | Effect |
|---|---|
| `status` | Bridge health, upstream, account, CLI version, catalog/schema size, credits, modalities, vision count |
| `doctor` | `status` + non-zero exit and a hint when the bridge is down |
| `start [port]` | Run the bridge in the foreground |
| `models [--vision]` | List models; `--vision` filters to image-capable |
| `schema [--json]` | Print the discovered contract |
| `discover` | Re-run the full discovery chain, aborting on first failure |

Environment: `CMD_BRIDGE_PORT`, `CMD_BRIDGE_HOST`, `COMMAND_CODE_API_KEY`.

### 13.8 `test/run-all.mjs`

```
node test/run-all.mjs [--offline] [--model <id>] [--vision-model <id>]
```

| Flag | Effect |
|---|---|
| `--offline` | Structural checks only — no requests, no credit |
| `--model <id>` | Model under test (default `deepseek/deepseek-v4.1-flash`) |
| `--vision-model <id>` | Vision model (same default) |

Starts the bridge if it is not already running. Exits 1 on any failure.

### 13.9 `scripts/safe-io.mjs`

Not user-facing. Every script that writes a file routes through it, because of
the incident in §16.6.

- `argOut(flag, fallback)` — resolves `--out` and **rejects** a value equal to
  `process.argv[0]` or `process.execPath`.
- `writeJson(file, data)` — refuses extensionless paths outside the project,
  and refuses anything under `/usr/local/bin`, `/usr/bin`, `/bin`,
  `/sbin`, `/usr/sbin`, `/opt/homebrew/bin`, `~/.local/bin`, `~/.local/lib`,
  and `~/.commandcode/auth.json`.

---

## 14. Operational runbook

### 14.1 Daily use

```bash
npm run bridge            # terminal 1
opencode                  # terminal 2 — pick any commandcode/… model
```

### 14.2 After a Command Code CLI upgrade

```bash
npm run discover          # re-learn catalog, schema, and parts
npm run install           # push the refreshed model list into opencode.json
npm test                  # confirm nothing regressed
```

The bridge picks up the new CLI version automatically on the next request,
because it reads `package.json` every time.

### 14.3 Triage

| Symptom | Likely cause | Action |
|---|---|---|
| `Model unavailable: commandcode/…` | Provider not installed | `npm run install` |
| `ECONNREFUSED` / `fetch failed` | Bridge not running | `npm run bridge` |
| `MODEL_NOT_IN_PLAN` | Model not on this plan | `opencode-cc-go models` |
| `upgrade_required` | Bridge sending a stale version | `cmd --version`; re-run `discover` |
| "I can't see any image" | Text-only model, or image dropped | check `modalities` in config; see §12.4 |
| Empty reply, `finish_reason: length` | Reasoning ate the budget | raise `max_tokens` |
| Tool args arrive as `{}` | SDK stripped the schema | see §12.4 |
| `opencode models` misses a model | Stale install | `npm run install` |

### 14.4 Cost discipline

A full 38-check test run costs roughly **0.02 credits** of a 10-credit monthly
allowance. Discovery costs **zero** — validation failures never reach a model.
The 5-hour rolling window (cap 3) and weekly window (cap 6) are the real
constraint; `opencode-cc-go status` prints current usage.

---

## 15. Research log and sources

### 15.1 Command Code

| Source | What it established |
|---|---|
| `https://commandcode.ai/pricing` | Go plan is $1/mo |
| `https://commandcode.ai/docs/provider` | *"Every plan except the Go plan has API access"* — the core constraint |
| `https://commandcode.ai/provider` | Provider plan $15/mo + $1.01 |
| `https://commandcode.ai/blog/command-code-provider-api` | Public API shape, for contrast |
| `https://commandcode.ai/docs/studio` | API key mechanics; `COMMAND_CODE_API_KEY` env var |
| `https://api.commandcode.ai/alpha/whoami` | Account identity |
| `…/alpha/billing/subscriptions` | `planId: individual-go-v1` |
| `…/alpha/billing/credits` | 10 monthly credits; 5 h cap 3; weekly cap 6 |
| `…/alpha/models`, `/v1/models`, `/models` | All 404 on the Go plan — no model-list endpoint exists |
| Installed `dist/cli.mjs` | Endpoint, headers, envelope, model table |

### 15.2 OpenCode

| Source | What it established |
|---|---|
| `https://opencode.ai/docs/plugins/` | Plugin directories, npm plugins, hooks, `Plugins loaded after config` |
| `https://opencode.ai/docs/providers/` | `npm: "@ai-sdk/openai-compatible"`, `options.baseURL`, `models`, `modalities` |
| `packages/plugin/src/index.ts` (GitHub) | The authoritative `Hooks` interface — `config`, `provider`, `tool`, `event`, `auth` |
| `packages/opencode/src/provider/provider.ts` | `// load plugins first so config() hook runs before reading cfg.provider`; model resolution; bundled SDK map |
| `packages/opencode/src/plugin/index.ts` | `getLegacyPlugins` — every export must be a function |
| `packages/opencode/src/plugin/shared.ts` | `isPathPluginSpec` — `./x`, `file://`, absolute ⇒ file plugin |
| `packages/opencode/src/plugin/loader.ts` | Resolution pipeline, `index.{ts,tsx,js,mjs,cjs}` |
| Installed `opencode` v2.0.19 | Empirical loader behaviour (§11.1) |

### 15.3 Client libraries

| Source | What it established |
|---|---|
| `@ai-sdk/openai-compatible@2.0.80` | The wire format OpenCode speaks |
| `ai@6.0.296` | `streamText`/`generateText` behaviour; the tool-schema stripping quirk (§12.4) |
| Vercel AI SDK stream events | The NDJSON event vocabulary on the wire is AI-SDK v5+ shaped |
| Node `zlib`, `crypto` | Dependency-free PNG encoding for the vision fixture |

### 15.4 Community

| Source | Note |
|---|---|
| `safzanpirani/pi-commandcode-provider` | An independent OpenAI→envelope translator for the same endpoint; confirmed the approach was known to others before it was implemented here |
| `router-for-me/CLIProxyAPI` discussion #4007 | Independently documents `/alpha/generate` as the CLI's own endpoint and notes the envelope is not OpenAI-shaped |

Both were found **after** the protocol was already reverse-engineered and
working. They corroborated the design; they were not used as a source.

---

## 16. Failure modes we hit

Recorded because each one cost real time and none produced an obvious error.

### 16.1 Aborting every request instantly

**Symptom:** every call failed with `Upstream connection failed: This
operation was aborted`.

**Cause:** `req.on("close", () => ac.abort())`. The `IncomingMessage` emits
`close` as soon as the request body is fully consumed — which is immediately,
since the body is read before the upstream call. Every upstream request was
being cancelled microseconds after it started.

**Fix:** listen on `res` and only abort if the response never finished:

```js
res.on("close", () => { if (!res.writableFinished) ac.abort() })
```

### 16.2 Overwriting the Node.js binary

**Symptom:** `node` began emitting shell errors (`line 3: generatedAt: command
not found`) and exiting 137.

**Cause — our bug, and a bad one.** `probe-schema.mjs` parsed its output flag as:

```js
process.argv[process.argv.indexOf("--out") + 1] || "schema.generated.json"
```

With `--out` absent, `indexOf` returns `-1`, the index becomes `0`, and
`process.argv[0]` is the path to the running Node executable. The script wrote
its JSON over `/usr/local/lib/nodejs/node-v24.21.0-darwin-arm64/bin/node`,
destroying the Node installation.

**Fix:** restored the official binary (downloaded from nodejs.org, verified
against the official `SHASUMS256.txt`, and confirmed as a valid signed arm64
Mach-O reporting `v24.21.0`), then made the failure structurally impossible:
all output paths now go through `scripts/safe-io.mjs`, which rejects
`process.argv[0]`, `process.execPath`, extensionless paths outside the project,
and a list of protected system directories.

The general lesson: never derive a filesystem path from an argv index without
validating it.

### 16.3 Regex capturing `1` from `1e6`

**Symptom:** every model reported a context window of `1`.

**Cause:** `contextWindow:\s*(\d+)` against `contextWindow:1e6`.

No error, no warning — just catastrophically wrong context budgeting. Fixed by
accepting scientific notation. Documented in §5.1 because it is the kind of bug
that ships silently.

### 16.4 Images silently dropped

**Symptom:** vision worked over `curl`, failed through the bridge.

**Cause:** the translator only handled OpenAI's `{type:"image_url",image_url:{url}}`.
The client in use sent the AI SDK's `{type:"image",image}`. The image was
dropped with no error, and the model helpfully replied "I can't see any image".

**Fix:** accept both spellings. Also hardened the *diagnostic*: a missing image
and an exhausted reasoning budget produce near-identical output, so the test
now asserts on `finish_reason` and reasoning-token counts, and uses a
sufficient `max_tokens`.

### 16.5 Treating rate limits as schema facts

**Symptom:** discovery "completed" having found 2 of 34 paths.

**Cause:** the crawl loop accepted any non-400 as done. A mid-run 403 (rolling
window) ended discovery early and reported success.

**Fix:** retry transient statuses with exponential backoff and jitter; treat
only `200` as completion; report the stall reason honestly instead of claiming
success.

### 16.6 Two mis-parses of Zod error text

- Non-greedy `expected (.+?) at "` swallowing `string, received undefined`,
  turning a typed field into a phantom literal. Fixed by ordering the patterns.
- Some clauses prefixed `Validation error: ` and others not, defeating `^`
  anchors. Fixed by stripping the preamble centrally in `clauses()`.

Both produced *plausible but wrong* schema output rather than errors.

### 16.7 Reading "no error" as "field exists"

**Symptom:** optional-field detection reported garbage.

**Cause:** the server ignores unknown keys, so a field that does not exist and
a field that accepts anything look identical.

**Fix:** an explicit negative control (`__definitely_not_a_real_field__`) is
submitted and its result recorded in the artifact, and unconfirmable fields are
marked `unverified` rather than being reported as confirmed.

### 16.8 Probing a port occupied by a non-HTTP listener

**Symptom:** `setTypeOfService EINVAL` from undici; the suite reported a dead
bridge and tried to spawn a second one.

**Cause:** the harness probed the *default* port before resolving the real one.
A foreign process that accepts TCP but never speaks HTTP is indistinguishable
from a healthy bridge on the same port.

**Fix:** discover the port, then probe. See §10.6. This is a general hazard for
any code that health-checks a loopback service.

### 16.9 `/health` too slow to be a health check

**Symptom:** the CLI reported `unreachable` while `curl /health` on the same URL
succeeded.

**Cause:** `/health` performed two upstream round-trips inline (3.2 s cold),
longer than the caller's timeout.

**Fix:** cache upstream status for 30 s, answer cold calls from local state, and
expose `?deep=1` for a forced synchronous check. Now 41 ms cold, 17 ms warm.

### 16.10 Brittle test assertions

**Symptom:** an intermittent failure where the model replied `STREAM` instead of
`STREAM_OK`.

**Cause:** the assertion required an exact string from a nondeterministic model.
The transport was fine; the test was measuring the model's mood.

**Fix:** assert on a distinctive prefix. A test that fails on model verbosity
gets ignored, and then it protects nothing.

### 16.11 The AI SDK stripping tool schemas

Covered in §12.4. Not a bridge bug; documented so the next person does not lose
an afternoon to it.

---

## 17. Design decisions and their trade-offs

| Decision | Alternative | Why |
|---|---|---|
| Discover, don't hardcode | Hand-maintained model list | A hardcoded list rots the first time the vendor ships. Discovery costs 0 credits and one command. |
| Zero runtime dependencies | `@hono/node-server`, `express` | Must run on a bare Node. The whole HTTP surface is 5 routes. |
| Plugin **and** installer | Plugin only | The plugin is correct but doesn't load on this build (§11.1). The installer always works. |
| `apiKey: "local-bridge"` in config | Put the real key in config | The Command Code key never enters OpenCode's config file, so a leaked config leaks nothing. Loopback-only binding is the actual control. |
| Only `tool-call`, never `tool-input-delta` | Stream arguments progressively | Emitting both duplicates the arguments and yields invalid JSON. Correctness first. |
| Always emit usage | Honour `stream_options.include_usage` | The AI SDK never sets the flag; honouring it meant usage was always empty. |
| Loopback bind by default | `0.0.0.0` | This proxy holds a billable key. It should not be reachable off-box unless someone explicitly opts in. |
| 128k context fallback | Ship `null` | `null` makes OpenCode's context math `NaN`. 128k is conservative and safe. |
| Probes run sequentially | Parallel | Parallel trips the rolling window limiter. Wall-clock cost is ~40 s for 67 models. |
| `threadId` generated per request | Reuse a thread id | The CLI groups a conversation; a stateless proxy has none, and a fresh UUID is valid. |
| No retry in the bridge hot path | Auto-retry 429 | Retrying a credit-metered call risks double-billing. Surface the error and let the client decide. |

---

## 18. What would break this

Honest failure analysis, ordered by likelihood.

1. **The endpoint changes shape.** The `config` block gains a required field,
   or an enum loses a value. *Detection:* `npm run discover` — the repair loop
   reports a stall with the offending clause. *Response:* the probe scripts are
   field-agnostic by design; `extract-catalog.mjs` exits 3 if the route constant
   moves, which is the signal to re-derive the route.

2. **Validation errors stop being detailed.** The whole discovery system
   depends on the server naming paths. If Zod is swapped for a handler that
   returns `"invalid request"`, discovery degrades to whatever
   `envelope.generated.json` can supply. *Response:* the bridge still runs; it
   just loses automatic adaptation.

3. **The CLI bundle is restructured.** `extract-catalog.mjs` and
   `extract-envelope.mjs` parse it structurally. An exit 2 or 3 is the early
   warning. The *bridge* is unaffected — it only reads the installed
   `package.json` for the version string.

4. **Plan gating changes.** Upgrading the plan, or Command Code retiring a
   free model, changes the 49/67 split. *Detection:* `npm run catalog:probe`.
   `catalog.reachability.json` is gitignored precisely so it can be re-derived
   per account rather than shipped stale.

5. **OpenCode's plugin loader.** The v2 module contract (`id` + `setup`) and the
   tool-registration contract are both stricter than the v1 types suggest, and a
   stale module cache makes correct fixes look broken (§11.1). None of it affects
   the installer: the provider is in `opencode.json` either way.

6. **Minimum CLI version rises.** The `upgrade_required` path is explicit and
   self-describing. Reading the version from the installed CLI means the fix is
   always `cmd update`.

### 18.1 Adding a model that discovery missed

If a new model appears and reachability has not been re-probed:

```bash
npm run catalog:probe && npm run install
```

No code change. That is the point.

### 18.2 Contributing

- Never hand-edit `catalog.json`, `schema.generated.json`,
  `envelope.generated.json` or `parts.generated.json`. Regenerate them.
- Never add a field name to the bridge. Add it to a probe.
- Any new output path goes through `safe-io.mjs`.
- New transport behaviour needs a test in `test/run-all.mjs` that would fail
  without it.
- Run `npm test` before opening a PR. It costs ~0.02 credits.

---

*Generated against `command-code@1.69.0` and `opencode@2.0.19` on 2026-09-29,
account plan `individual-go-v1`. 67 models extracted, 49 reachable, 30 with
image input, 38 schema paths, 14 input part types, 27/27 tests passing.*
