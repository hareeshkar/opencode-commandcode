/**
 * opencode-commandcode — wire translation
 *
 * Converts between two shapes:
 *
 *   INBOUND  OpenAI /v1/chat/completions  (what OpenCode's @ai-sdk/openai-compatible sends)
 *   WIRE     Command Code POST /alpha/generate  (the CLI's own internal envelope)
 *
 * Everything here is driven by the GENERATED artifacts, never by a hand-kept
 * list of field names:
 *   schema.generated.json  — the validated contract (types, enums, optionality)
 *   envelope.generated.json— the field names the CLI itself POSTs
 *   parts.generated.json   — the content-part union (multimodal input types)
 *
 * If Command Code changes, re-run the probe scripts; this file does not change.
 */

// ---------------------------------------------------------------- primitives

/** Normalise OpenAI content (string | parts[]) to plain text. */
export function textOf(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((p) => p && (p.type === "text" || p.type === "input_text"))
    .map((p) => p.text ?? p.input_text ?? "")
    .join("")
}

/** Pull a data: URL into { mimeType, base64 }. */
function parseDataUrl(url) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  return m ? { mimeType: m[1], data: m[2] } : null
}

// ------------------------------------------------- OpenAI messages -> wire

/**
 * @param {Array} openaiMessages
 * @returns {{ messages: Array, system: string|null }}
 *
 * Role mapping (derived from the union dump in parts.generated.json):
 *   OpenAI "system"/"developer"  -> hoisted into params.system
 *   OpenAI "user"                -> wire role "user"
 *   OpenAI "assistant"           -> wire role "assistant"
 *   OpenAI "tool"                -> wire role "tool" (content parts: tool-result)
 *   OpenAI "tool" (legacy)       -> wire role "tool"
 *
 * Assistant tool calls become content parts of type "tool-call"; the schema
 * union lists "tool-call" (server) and "tool_use" (client) as distinct variants.
 * We emit "tool-call" for assistant-originated calls, matching the CLI's own
 * toWireMessages() which emits { type: "tool-call", toolCallId, toolName, input }.
 */
export function toWire(openaiMessages) {
  const out = []
  const systemParts = []
  // tool_call_id -> tool name, so a following "tool" message can name its tool
  const toolNames = new Map()

  for (const m of openaiMessages || []) {
    if (m.role === "system" || m.role === "developer") {
      const t = textOf(m.content)
      if (t) systemParts.push(t)
      continue
    }

    if (m.role === "user") {
      const parts = []
      const raw = m.content
      if (typeof raw === "string") {
        if (raw) parts.push({ type: "text", text: raw })
      } else if (Array.isArray(raw)) {
        for (const p of raw) {
          if (!p) continue
          if (p.type === "text" || p.type === "input_text") {
            parts.push({ type: "text", text: p.text ?? p.input_text ?? "" })
          } else if (p.type === "image_url" || p.type === "input_image") {
            // OpenAI chat-completions shape: { type:"image_url", image_url:{ url } }
            const url = p.image_url?.url ?? p.image_url ?? p.image
            if (typeof url !== "string") continue
            parts.push({ type: "image", image: url })
          } else if (p.type === "image") {
            // Vercel AI SDK shape: { type:"image", image: <url | data url | base64> }
            const url = p.image
            if (typeof url !== "string") continue
            parts.push({ type: "image", image: url })
          }
          // file/document parts are surfaced by the AI SDK as
          // { type: "file", data|mediaType } — map to the document variant.
          else if (p.type === "file" || p.type === "document") {
            const data = p.data ?? p.file_data ?? p.url
            const mimeType = p.mediaType ?? p.mimeType ?? p.media_type ?? "application/pdf"
            const b64 =
              typeof data === "string" && data.startsWith("data:")
                ? parseDataUrl(data)?.data
                : data
            if (b64) {
              parts.push({ type: "document", source: { type: "base64", media_type: mimeType, data: b64 } })
            }
          }
        }
      }
      if (parts.length) out.push({ role: "user", content: parts })
      continue
    }

    if (m.role === "assistant") {
      const parts = []
      // preserve prior reasoning when the client round-trips it
      const think = m.reasoning_content ?? m.reasoning
      if (think) parts.push({ type: "reasoning", text: think })
      const t = textOf(m.content)
      if (t) parts.push({ type: "text", text: t })
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          if (!tc?.function) continue
          const name = tc.function.name || "tool"
          let input = {}
          if (tc.function.arguments) {
            try { input = JSON.parse(tc.function.arguments) } catch { input = {} }
          }
          toolNames.set(tc.id, name)
          parts.push({ type: "tool-call", toolCallId: tc.id, toolName: name, input })
        }
      }
      if (parts.length) out.push({ role: "assistant", content: parts })
      continue
    }

    if (m.role === "tool" || m.role === "function") {
      const name = toolNames.get(m.tool_call_id) || m.name || "tool"
      out.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: m.tool_call_id || m.id || "unknown",
          toolName: name,
          output: { type: "text", value: textOf(m.content) },
        }],
      })
      continue
    }
  }

  return { messages: out, system: systemParts.length ? systemParts.join("\n\n") : null }
}

// ------------------------------------------------------------- tools mapping

/**
 * OpenAI tools [{type:"function",function:{name,description,parameters}}]
 *   -> wire tools [{ name, description, input_schema }]  (matching toWireTools)
 */
export function toWireTools(tools) {
  if (!Array.isArray(tools)) return []
  return tools
    .filter((t) => t && (t.type === "function" || t.function))
    .map((t) => {
      const fn = t.function || t
      return {
        name: fn.name,
        description: fn.description || "",
        input_schema: fn.parameters || { type: "object", properties: {} },
      }
    })
    .filter((t) => t.name)
}

// --------------------------------------------- wire NDJSON -> OpenAI chunks

const FINISH_MAP = {
  stop: "stop",
  tool_calls: "tool_calls",
  "tool-calls": "tool_calls",
  tool_use: "tool_calls",
  length: "length",
  max_tokens: "length",
}

/** Map a wire finishReason to an OpenAI finish_reason. */
export function finishMap(raw) {
  return FINISH_MAP[raw] || "stop"
}

/**
 * Normalise the wire usage object into OpenAI's usage shape.
 * The wire exposes inputTokens/outputTokens/totalTokens plus cache fields.
 */
export function toOpenAIUsage(u) {
  if (!u) return null
  const prompt = u.inputTokens ?? 0
  const completion = u.outputTokens ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: u.totalTokens ?? prompt + completion,
    ...(u.outputTokenDetails?.reasoningTokens || u.reasoningTokens
      ? { completion_tokens_details: { reasoning_tokens: u.outputTokenDetails?.reasoningTokens ?? u.reasoningTokens } }
      : {}),
  }
}
