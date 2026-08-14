export interface ReasoningStreamObservation {
  reasoningSeen: boolean
  reasoningStripped: boolean
  reasoningChunksStripped: number
  toolCallSeen: boolean
  finishReason?: string
}

function eventDelimiter(buffer: string): { index: number; length: number } | undefined {
  const match = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/.exec(buffer)
  return match?.index === undefined ? undefined : { index: match.index, length: match[0].length }
}

function eventLines(event: string): string[] {
  return event.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter((line) => line.length > 0) ?? []
}

function lineValue(line: string): string {
  return line.replace(/(?:\r\n|\r|\n)$/, "")
}

function dataPayload(lines: string[]): string | undefined {
  const values = lines
    .map(lineValue)
    .filter((line) => line === "data" || line.startsWith("data:"))
    .map((line) => line === "data" ? "" : line.slice(5).replace(/^ /, ""))
  return values.length === 0 ? undefined : values.join("\n")
}

function hasRelevantChoiceData(choice: Record<string, unknown>): boolean {
  const delta = choice.delta
  if (delta && typeof delta === "object" && Object.keys(delta).length > 0) return true
  return Object.entries(choice).some(([key, value]) => key !== "index" && key !== "delta" && value !== null && value !== undefined)
}

function onlyReasoningWasRemoved(payload: Record<string, unknown>): boolean {
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) return false
  if (choices.some((choice) => choice && typeof choice === "object" && hasRelevantChoiceData(choice as Record<string, unknown>))) return false
  return !Object.entries(payload).some(([key, value]) => key !== "choices" && value !== null && value !== undefined)
}

function replaceData(lines: string[], payload: string): string {
  let replaced = false
  return lines.map((line) => {
    const value = lineValue(line)
    if (value !== "data" && !value.startsWith("data:")) return line
    if (replaced) return ""
    replaced = true
    const ending = line.slice(value.length)
    return `data: ${payload}${ending}`
  }).join("")
}

function transformEvent(event: string, delimiter: string, observation: ReasoningStreamObservation): string {
  const lines = eventLines(event)
  const data = dataPayload(lines)
  if (data === undefined || data === "[DONE]") return event + delimiter

  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return event + delimiter
  }
  if (!payload || typeof payload !== "object") return event + delimiter

  const record = payload as Record<string, unknown>
  const choices = record.choices
  let removed = false
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue
      const choiceRecord = choice as Record<string, unknown>
      const delta = choiceRecord.delta
      if (delta && typeof delta === "object") {
        const deltaRecord = delta as Record<string, unknown>
        if ("reasoning_content" in deltaRecord) {
          observation.reasoningSeen = true
          delete deltaRecord.reasoning_content
          removed = true
        }
        if (Array.isArray(deltaRecord.tool_calls) && deltaRecord.tool_calls.length > 0) observation.toolCallSeen = true
      }
      if (typeof choiceRecord.finish_reason === "string") observation.finishReason = choiceRecord.finish_reason
    }
  }

  if (!removed) return event + delimiter
  observation.reasoningStripped = true
  observation.reasoningChunksStripped += 1
  if (onlyReasoningWasRemoved(record)) return ""
  return replaceData(lines, JSON.stringify(record)) + delimiter
}

export class ReasoningSseStripper {
  private readonly decoder = new TextDecoder()
  private buffer = ""

  constructor(readonly observation: ReasoningStreamObservation = {
    reasoningSeen: false,
    reasoningStripped: false,
    reasoningChunksStripped: 0,
    toolCallSeen: false,
  }) {}

  push(chunk: Uint8Array): string {
    this.buffer += this.decoder.decode(chunk, { stream: true })
    return this.drain(false)
  }

  flush(): string {
    this.buffer += this.decoder.decode()
    return this.drain(true)
  }

  private drain(flush: boolean): string {
    let output = ""
    while (true) {
      const delimiter = eventDelimiter(this.buffer)
      if (delimiter === undefined) break
      const event = this.buffer.slice(0, delimiter.index)
      const separator = this.buffer.slice(delimiter.index, delimiter.index + delimiter.length)
      this.buffer = this.buffer.slice(delimiter.index + delimiter.length)
      output += transformEvent(event, separator, this.observation)
    }
    if (flush && this.buffer.length > 0) {
      output += transformEvent(this.buffer, "", this.observation)
      this.buffer = ""
    }
    return output
  }
}
