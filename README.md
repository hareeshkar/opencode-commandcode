# opencode-commandcode-go

**Use your $1 Command Code GO plan inside OpenCode. 49 models. Real vision. Real tool use.**

---

## ⚠️ First: is this even for you?

**This package is ONLY for the $1/month Go plan.**

Command Code sells several plans, and only one of them is missing an API:

| Plan | Price | Has API access? | What you should do |
|---|---|---|---|
| **Go** | **$1/mo** | **❌ NO** | **✅ Install this package** |
| Provider | $15/mo | ✅ Yes, full OpenAI + Anthropic API | ❌ Don't install — connect the API directly |
| Pro | ~$30/mo | ✅ Yes | ❌ Don't install — connect directly |
| Max | ~$60/mo | ✅ Yes | ❌ Don't install — connect directly |
| GOAT / Ultra | $60+/mo | ✅ Yes | ❌ Don't install — connect directly |
| Team | $40+/mo | ✅ Yes | ❌ Don't install — connect directly |

Command Code states it plainly in their own docs: *"Every plan except the Go
plan has API access."*

### If you are on Provider, Pro, Max, or GOAT — stop here

You already have a real, supported API. Don't run a bridge. This is the whole
thing, in your `opencode.json`:

```jsonc
{
  "provider": {
    "commandcode": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Command Code",
      "options": {
        "baseURL": "https://api.commandcode.ai/v1",
        "apiKey": "{env:COMMAND_CODE_API_KEY}"
      }
    }
  }
}
```

Then create a key at <https://commandcode.ai/studio> and:

```bash
export COMMAND_CODE_API_KEY="cmd_..."
opencode run -m commandcode/<any-model-id> "hi"
```

That's supported, documented, and simpler than anything in this repo. This
package would only add a moving part for you.

### Good news: you don't have to check

This package **detects your plan and refuses to install** if you don't need it.
It reads your subscription from the API and, if it finds a plan that already has
API access, it stops and shows you the config above instead:

```
$ opencode-cc-go install

  You are on the 'individual-provider' plan, which already includes API access.

  This package is only for the $1 Go plan, which has no Provider API.
  You do not need it. Point OpenCode at the API directly instead:
  ...
  Install anyway with --force if you specifically want the bridge.
```

Override with `--force` if you know you want it anyway.

---

## For the $1 Go plan users

You like [Command Code](https://commandcode.ai) because it costs **$1/month**.
You like [OpenCode](https://opencode.ai) because it's your editor.

But the Go plan is a **closed loop**. Command Code's docs are explicit about
the consequence: *"Every plan except the Go plan has API access."* So your
cheap plan only works inside their own `cmd` terminal app, and nothing else can
talk to it.

That's a shame, because underneath, the $1 plan already gives you access to
**49 different frontier and open models**, 30 of which can read images.

## What this package does

It opens that loop.

Command Code's own CLI talks to a private endpoint on every single turn you
type. That endpoint works on the $1 plan. This package stands up a small local
server that **speaks the same language**, then teaches OpenCode to talk to it.

The result:

- ✅ All **49 models** your plan can reach, listed automatically
- ✅ **30 of them accept images** — and OpenCode routes image prompts to those
- ✅ **Full tool use** — the agent can read, write and run shell commands
- ✅ Streaming, reasoning output, and accurate token accounting
- ✅ **$0 API cost** — it reuses your existing $1 subscription

Nothing is hardcoded. The package **asks Command Code what it supports** and
builds the model list from the answer.

---

## Install in 3 steps

You need [Node 20+](https://nodejs.org) and a Command Code account
(`npm i -g command-code && cmd auth login`).

```bash
# 1. install the package
npm install -g opencode-commandcode-go

# 2. tell OpenCode about it (writes the provider into opencode.json)
opencode-cc-go install

# 3. keep the bridge running
opencode-cc-go service        # macOS: launchd agent, starts at login, restarts on crash
opencode-cc-go start          # or just run it in a terminal
```

Step 3 with `service` means you never have to think about it again: it starts at
login, and if the bridge crashes it is restarted within about 10 seconds.
`opencode-cc-go service:remove` uninstalls it.

If port 8787 is already taken by something else, the bridge **picks the next
free port automatically** and everything else — the installer, the CLI, the
OpenCode config — follows it. You will never be asked to go find a free port
yourself. Pin a specific port with `CMD_BRIDGE_PORT=8788` if you prefer.

Now use it:

```bash
opencode run -m commandcode/deepseek/deepseek-v4.1-flash "hello"
```

Or run `opencode` and pick any `commandcode/...` model from `/models`.

Check everything is healthy. The plan line confirms you're actually
on the plan this is for:

```bash
opencode-cc-go status
```

```
opencode-commandcode
  bridge        healthy  (http://127.0.0.1:8787)
  upstream      reachable  https://api.commandcode.ai
  account       your-username
  cli version   1.69.0
  catalog       49 models (2026-09-29)
  schema        38 paths (2026-09-29)
  credits       9.90 / 10 this cycle
  modalities    document, image, pdf, text
  vision models 30 of 49
```

---

## What you get

### 49 models, discovered automatically

The list isn't a hardcoded list someone typed out in 2024. The package reads
Command Code's own model catalog, then **probes every model** to see which ones
your plan can actually call. Right now that's 49 of 67, because your plan
correctly hides the Google/Gemini, Meta and xAI premium tiers.

```
deepseek/deepseek-v4-pro            1,000,000  text
deepseek/deepseek-v4.1-flash        1,000,000  text + image   ← good default
moonshotai/Kimi-K3                  1,000,000  text + image
zai-org/GLM-5.3                     1,000,000  text
xiaomi/mimo-v2.5                    1,000,000  text + image
z-ai/glm-5.3-flash                  1,048,576  text + image
... 43 more
```

Context windows are the **real** declared values, not round guesses. That's why
`Kimi-K2.5` shows 256,000 while `Kimi-K3` shows 1,000,000.

### Vision that actually works

30 models accept images, and OpenCode knows which ones — so it never sends a
screenshot to a text-only model and gets "I can't see any image" back.

Here is a real test from this repo's suite. The package renders a PNG from
scratch (a white card, a green border, the number **42**, a red square), then
asks the model to describe it:

```
PASS  vision model reads the number 42
PASS  vision model reads the green background
PASS  vision model reads the red square
```

That's not a mock. That's a real image, sent as real bytes, read correctly by a
real model.

### Full agentic tool use

The bridge translates OpenCode's tool protocol both ways, so the model can call
`read`, `write`, `bash`, and everything else. A real run from the test suite:

```bash
$ opencode run -m commandcode/deepseek/deepseek-v4.1-flash \
    "Create agentic.txt containing AGENTIC_WORKS, then verify it."
> build · deepseek/deepseek-v4.1-flash
← Write agentic.txt
Created file successfully: agentic.txt
> build · deepseek/deepseek-v4.1-flash
→ Read agentic.txt
> build · deepseek/deepseek-v4.1-flash
DONE
```

Tool **arguments** survive the round trip byte-for-byte — verified with a
`get_weather({ city: "Paris" })` assertion, because a bridge that mangles tool
arguments is worse than no bridge at all.

---

## How it works, in one picture

```
  OpenCode
      │  OpenAI chat-completions (the format everything speaks)
      ▼
  ┌──────────────────────────────┐
  │  the bridge  (localhost)     │   ← this package
  │  translates + supervises     │
  └──────────────────────────────┘
      │  Command Code's private format
      ▼
  api.commandcode.ai/alpha/generate
      │
      ▼
  DeepSeek · Kimi · Qwen · GLM · MiMo · …
```

The bridge is a **local** process. Your API key never leaves your machine, and
the key is read from your existing `cmd` login — you never paste it anywhere.

---

## The interesting part: it discovers, it doesn't assume

Most integrations hardcode a model list and a request shape, then rot the
first time the vendor ships a change.

This one **asks**. The repo contains scripts that interrogate the live API and
write down what they find:

```bash
npm run discover     # rebuild catalog + schema + parts from scratch
```

That produces three files:

| File | What it holds | How it was built |
|---|---|---|
| `catalog.json` | 49 reachable models, context windows, input types | parsed from the CLI bundle, then **probed live** |
| `schema.generated.json` | every field of the request contract, with types and enums | **brute-forced** from the API's own validation errors |
| `parts.generated.json` | the 14 input "part" types (text, image, document, PDF…) | **extracted from a union type error** |

The neat trick: the API validates requests with a library that reports
*exactly* what's wrong. Send it a broken request and it hands you the schema.
34 fields, 14 input types, 6 enum values — all recovered automatically, with
zero hardcoded field names.

Command Code upgrades their CLI, you run one command, and the package
re-learns everything. [DEVELOPER.md](./DEVELOPER.md) explains the whole
technique in detail.

---

## Commands

| Command | What it does |
|---|---|
| `opencode-cc-go install` | register the provider in OpenCode |
| `opencode-cc-go status` | health, plan, credits, model count |
| `opencode-cc-go doctor` | diagnose a broken setup (fails loudly on drift) |
| `opencode-cc-go sync` | re-point OpenCode's config at the live bridge |
| `opencode-cc-go service` | run it as a macOS launchd agent (auto-start, auto-restart) |
| `opencode-cc-go service:remove` | uninstall the launchd agent |
| `opencode-cc-go start` | run the bridge in the foreground |
| `opencode-cc-go models` | list models (`--vision` for image-capable only) |
| `opencode-cc-go schema` | print the discovered API contract |
| `opencode-cc-go discover` | re-learn everything from the live API |
| `opencode-cc-go --help` | usage |

Inside OpenCode, the agent can also call a `commandcode_status` tool to report
bridge health on demand.

---

## Tests

```bash
npm test              # 27 checks against the live API
npm test -- --offline # structural checks only, no requests, no credit cost
```

The suite covers streaming, non-streaming, multi-turn memory, tool-call
arguments, the full agent loop, real vision on a real generated image, token
accounting, and error handling.

It deliberately uses **flash-tier models** — the transport is what we're
testing, and a bigger model costs credit without testing anything extra.

---

## Resilience

Things that are handled for you, because a package you install with one command
should not need babysitting:

| Situation | What happens |
|---|---|
| Port 8787 already in use | bridge takes the next free port; CLI, installer and OpenCode config all follow it |
| Bridge not running | `opencode-cc-go service` (permanent) or `opencode-cc-go start` |
| Bridge crashed | launchd restarts it; `service:status` shows the pid changing |
| Bridge moved ports on restart | OpenCode's config is rewritten automatically; restart OpenCode |
| Bridge hung on the port | detected, reported with the exact `lsof` commands to clear it |
| `opencode` restarts | state file tells the new process where the bridge is |
| You are on a plan with a real API | the installer **refuses** and shows you the direct config instead |
| Model retired or plan-gated | filtered out by `opencode-cc-go models`; never advertised if unusable |
| Stale state file from a crash | detected via dead pid, deleted rather than trusted |
| Bridge restarts onto a new port | rewrites OpenCode's `baseURL` atomically, and tells you to restart OpenCode |
| Config hand-edited or reverted | `doctor` reports the drift and fails; `sync` repairs it |

Health checks are non-blocking: `opencode-cc-go status` answers in ~40 ms even
when Command Code's API is slow, because local liveness and upstream reachability
are reported separately.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CMD_BRIDGE_PORT` | `8787` | bridge port |
| `CMD_BRIDGE_HOST` | `127.0.0.1` | bind address (loopback by default) |
| `COMMAND_CODE_API_KEY` | — | override; otherwise reads `~/.commandcode/auth.json` |
| `CMD_API_BASE` | `https://api.commandcode.ai` | upstream base URL |
| `CMD_DEFAULT_CONTEXT` | `128000` | fallback context window |
| `CMD_BRIDGE_STATE_DIR` | `~/.commandcode-bridge` | where the chosen port is recorded |
| `CMD_AUTH_PATH` | `~/.commandcode/auth.json` | credential file |

---

## Honest caveats

**This is for the Go plan only.** If a future Command Code release gives the Go
plan a real API, this package should be deleted, not maintained. It exists to
paper over one specific gap, and the gap is documented on their site.

This talks to an **undocumented internal endpoint** that Command Code has not
published for the Go plan. Things to know:

- It could change without notice. That's why everything is discoverable rather
  than hardcoded — re-run `discover` and the package adapts.
- It is rate- and credit-limited like the CLI, since it *is* the CLI's path.
  The bridge does not retry past a 429 storm; it surfaces the error.
- Check Command Code's terms before using this commercially. This package is
  for personal and development use.
- The 30/49 vision split and the model list reflect **your** plan. Someone on a
  different tier sees a different list — that's the discovery working, not a bug.

---

## License

MIT. See [LICENSE](./LICENSE).

Not affiliated with Command Code or OpenCode. It uses both, and belongs to
neither.
